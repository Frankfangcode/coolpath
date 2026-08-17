/**
 * risk.js — 任務 B 的計算核心：體感溫度、風險分級、外部觀測資料取得
 */

const { fetchWithTimeout } = require('./http');
const geo = require('./geo');

/**
 * NOAA Heat Index（Rothfusz 迴歸式），攝氏進、攝氏出。
 * @param {number} tempC 氣溫 °C
 * @param {number} rh 相對濕度 %
 * @returns {number} 體感溫度 °C
 */
function heatIndexC(tempC, rh) {
  const T = (tempC * 9) / 5 + 32;
  const R = rh;

  // 低溫區間用 Steadman 簡式，Rothfusz 在 80°F 以下會失真
  let hi = 0.5 * (T + 61 + (T - 68) * 1.2 + R * 0.094);
  hi = (hi + T) / 2;

  if (hi >= 80) {
    hi =
      -42.379 +
      2.04901523 * T +
      10.14333127 * R -
      0.22475541 * T * R -
      0.00683783 * T * T -
      0.05481717 * R * R +
      0.00122874 * T * T * R +
      0.00085282 * T * R * R -
      0.00000199 * T * T * R * R;

    // 低濕與高濕的修正項
    if (R < 13 && T >= 80 && T <= 112) {
      hi -= ((13 - R) / 4) * Math.sqrt((17 - Math.abs(T - 95)) / 17);
    } else if (R > 85 && T >= 80 && T <= 87) {
      hi += ((R - 85) / 10) * ((87 - T) / 5);
    }
  }

  return Math.round((((hi - 32) * 5) / 9) * 10) / 10;
}

/**
 * 風險分級門檻（三個模組共用，改這裡就好）
 *   low    體感 < 32°C 且 UVI < 6
 *   medium 體感 32–36°C 或 UVI 6–7
 *   high   體感 > 36°C 或 UVI >= 8 或路線最高地表溫度 > 40°C
 */
function classifyLevel(feelsLike, uvi, maxSurfaceTemp) {
  const f = Number(feelsLike);
  const u = Number(uvi);
  const s = Number(maxSurfaceTemp);

  if (f > 36 || u >= 8 || (Number.isFinite(s) && s > 40)) return 'high';
  if ((f >= 32 && f <= 36) || (u >= 6 && u <= 7)) return 'medium';
  return 'low';
}

const isValidObs = (v) => Number.isFinite(v) && v > -90; // 氣象署用 -99 / -990 代表無效值

/**
 * 中央氣象署觀測資料，挑距離最近且觀測值有效的測站。
 * 同時抓兩個資料集，合併後全台（含離島）最近測站通常在數公里內：
 *   O-A0001-001 自動氣象站（無人，約 500 站）
 *   O-A0003-001 局屬氣象站（有人，約 30 站）
 * 其中一個失敗就用另一個，兩個都失敗才丟錯。
 */
async function fetchWeather(lat, lng) {
  const key = process.env.CWA_API_KEY;
  if (!key) throw new Error('CWA_API_KEY 未設定');

  const fetchDataset = (id) =>
    fetchWithTimeout(
      `https://opendata.cwa.gov.tw/api/v1/rest/datastore/${id}` +
        `?Authorization=${encodeURIComponent(key)}&format=JSON`
    );

  const results = await Promise.allSettled([
    fetchDataset('O-A0001-001'),
    fetchDataset('O-A0003-001'),
  ]);
  const stations = [];
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    const records = r.value?.records || {};
    stations.push(...(records.Station || records.location || []));
  }
  if (stations.length === 0) {
    const reason = results.find((r) => r.status === 'rejected');
    throw new Error(`CWA 觀測資料取得失敗：${reason?.reason?.message || '無測站資料'}`);
  }

  let best = null;
  let bestD = Infinity;

  for (const s of stations) {
    let sLat;
    let sLng;
    let temp;
    let humidity;
    let obsTime;
    let name;

    if (s.GeoInfo) {
      // 新版 schema
      const coords = s.GeoInfo.Coordinates || [];
      const coord = coords.find((c) => c.CoordinateName === 'WGS84') || coords[0];
      sLat = Number(coord?.StationLatitude);
      sLng = Number(coord?.StationLongitude);
      temp = Number(s.WeatherElement?.AirTemperature);
      humidity = Number(s.WeatherElement?.RelativeHumidity);
      obsTime = s.ObsTime?.DateTime;
      name = s.StationName;
    } else {
      // 舊版 schema
      sLat = Number(s.lat);
      sLng = Number(s.lon);
      const el = {};
      for (const e of s.weatherElement || []) el[e.elementName] = Number(e.elementValue);
      temp = el.TEMP;
      humidity = el.HUMD <= 1 ? el.HUMD * 100 : el.HUMD; // 舊版濕度是 0–1 比例
      obsTime = s.time?.obsTime;
      name = s.locationName;
    }

    if (!Number.isFinite(sLat) || !Number.isFinite(sLng)) continue;
    if (!isValidObs(temp) || !isValidObs(humidity)) continue;

    const d = geo.haversineM({ lat, lng }, { lat: sLat, lng: sLng });
    if (d < bestD) {
      bestD = d;
      best = {
        airTemp: Math.round(temp * 10) / 10,
        humidity: Math.round(humidity),
        station: name,
        stationDistM: Math.round(d),
        obsTime,
      };
    }
  }

  if (!best) throw new Error('CWA 沒有可用的測站觀測值');
  return best;
}

/**
 * CWA F-D0047-089 鄉鎮天氣預報（新版 API 為 22 縣市層級，逐 1–3 小時）。
 * 「體感溫度」直接取 CWA 預報值（Apparent Temperature），全台適用。
 *
 * 回應約 110KB，快取在模組層 30 分鐘，同一個 function instance 共用；
 * 抓失敗時由呼叫端退回 NOAA Heat Index 計算值（heatIndexC）。
 */
const FEELS_TTL_MS = 30 * 60 * 1000;
let feelsCache = { data: null, at: 0 };

async function fetchFeelsLike(lat, lng, now = Date.now()) {
  const key = process.env.CWA_API_KEY;
  if (!key) throw new Error('CWA_API_KEY 未設定');

  if (!feelsCache.data || now - feelsCache.at > FEELS_TTL_MS) {
    const url =
      'https://opendata.cwa.gov.tw/api/v1/rest/datastore/F-D0047-089' +
      `?Authorization=${encodeURIComponent(key)}&format=JSON` +
      `&ElementName=${encodeURIComponent('體感溫度')}`;
    feelsCache = { data: await fetchWithTimeout(url), at: now };
  }

  const locations = feelsCache.data?.records?.Locations?.[0]?.Location || [];

  // 挑距離最近的縣市代表點
  let best = null;
  let bestD = Infinity;
  for (const loc of locations) {
    const sLat = Number(loc.Latitude);
    const sLng = Number(loc.Longitude);
    if (!Number.isFinite(sLat) || !Number.isFinite(sLng)) continue;
    const d = geo.haversineM({ lat, lng }, { lat: sLat, lng: sLng });
    if (d < bestD) {
      bestD = d;
      best = loc;
    }
  }
  if (!best) throw new Error('F-D0047-089 沒有可用的縣市預報');

  // 挑時間上離現在最近的預報時段（第一天逐時，之後逐三小時）
  const el = (best.WeatherElement || []).find((e) => e.ElementName === '體感溫度');
  let bestT = null;
  let bestDt = Infinity;
  for (const t of el?.Time || []) {
    const dt = new Date(t.DataTime || t.StartTime).getTime();
    if (!Number.isFinite(dt)) continue;
    const diff = Math.abs(dt - now);
    if (diff < bestDt) {
      bestDt = diff;
      bestT = t;
    }
  }

  const v = bestT?.ElementValue?.[0];
  const feelsLike = v ? Number(v.ApparentTemperature ?? Object.values(v)[0]) : NaN;
  if (!Number.isFinite(feelsLike)) throw new Error('體感溫度預報值無效');

  return {
    feelsLike,
    area: best.LocationName, // 縣市名，例如「臺北市」
    forecastTime: bestT.DataTime || bestT.StartTime || null,
  };
}

/** 測試用：清掉模組層快取 */
function _clearFeelsCache() {
  feelsCache = { data: null, at: 0 };
}

/**
 * 環境部 UV_S_01 紫外線即時監測（全台數十站）。
 * 有座標欄位就挑距離最近的測站；沒有就退回第一筆有效值。
 * 單站代表一片區域：不沿路線變化，也不參與路線評分。
 */
async function fetchUvi(lat, lng) {
  const key = process.env.MOENV_API_KEY;
  if (!key) throw new Error('MOENV_API_KEY 未設定');

  const url =
    'https://data.moenv.gov.tw/api/v2/uv_s_01' +
    `?api_key=${encodeURIComponent(key)}&format=JSON&limit=200`;
  const data = await fetchWithTimeout(url);

  const records = (data?.records || []).filter((r) => Number.isFinite(Number(r.uvi ?? r.UVI)));
  if (records.length === 0) throw new Error('環境部沒有回傳有效的 UVI 資料');

  let hit = null;
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    let bestD = Infinity;
    for (const r of records) {
      const sLat = Number(r.latitude ?? r.Latitude ?? r.twd97lat);
      const sLng = Number(r.longitude ?? r.Longitude ?? r.twd97lon);
      if (!Number.isFinite(sLat) || !Number.isFinite(sLng)) continue;
      const d = geo.haversineM({ lat, lng }, { lat: sLat, lng: sLng });
      if (d < bestD) {
        bestD = d;
        hit = r;
      }
    }
  }
  hit = hit || records[0];

  return {
    uvi: Math.round(Number(hit.uvi ?? hit.UVI) * 10) / 10,
    uviSite: hit.sitename || hit.SiteName || null,
    uviTime: hit.publishtime || hit.PublishTime || null,
  };
}

module.exports = {
  heatIndexC,
  classifyLevel,
  fetchWeather,
  fetchUvi,
  fetchFeelsLike,
  _clearFeelsCache,
};
