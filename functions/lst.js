/**
 * lst.js — Landsat 地表溫度（LST）查詢共用模組
 *
 * 支援兩種資料：夏季多期中位數，以及最近 48 天逐像元最新晴空觀測。
 * 兩者都不是即時氣溫；最新觀測的不同像元也可能來自不同日期。
 *
 * GeoJSON 座標順序是 [lng, lat]，不是 [lat, lng]。搞反的話全部查詢會回 null。
 */

const fs = require('fs');
const path = require('path');

const GEOJSON_PATH = path.join(__dirname, 'data', 'taipei_lst_grid.geojson');

// 空間雜湊格大小（度）。約 890m（緯度向），台灣緯度的經度向約 810–820m，
// >= 搜尋半徑 800m，因此掃 3x3 鄰格就保證不會漏掉任何在半徑內的點。
// 搜尋半徑 800m 同時支援 200m 高解析網格與 1.1km 全台粗網格（半對角線 778m）。
const CELL = 0.008;
const MAX_DIST_M = 800;

// 溫度可能的欄位名（Earth Engine rename 過是 LST，沒 rename 是 ST_B10）
const TEMP_KEYS = ['LST', 'lst', 'ST_B10', 'mean', 'median', 'b1', 'temp'];

let index = null; // Map<cellKey, Array<[lat, lng, temp, ageDays]>>
let meta = {
  loaded: false,
  placeholder: false,
  source: null,
  generatedAt: null,
  minAgeDays: null,
  maxAgeDays: null,
  points: 0,
  error: null,
};
const memo = new Map(); // 取樣點常常落在同一格，快取省掉重複的最近鄰搜尋
const MEMO_LIMIT = 200000;

function cellKey(lat, lng) {
  return `${Math.floor(lat / CELL)}:${Math.floor(lng / CELL)}`;
}

function pickTemp(props) {
  if (!props) return null;
  for (const k of TEMP_KEYS) {
    const v = props[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  // 保底：抓第一個看起來像攝氏地表溫度的數值欄位
  for (const v of Object.values(props)) {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 80) return v;
  }
  return null;
}

function pickAgeDays(props) {
  const value = Number(props?.age_days ?? props?.ageDays);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function load() {
  if (index) return;
  index = new Map();
  try {
    const raw = fs.readFileSync(GEOJSON_PATH, 'utf8');
    const gj = JSON.parse(raw);
    meta.placeholder = gj._placeholder === true;
    meta.source = gj._source || null;
    meta.generatedAt = gj._generatedAt || null;
    meta.minAgeDays = Number.isFinite(Number(gj._minAgeDays)) ? Number(gj._minAgeDays) : null;
    meta.maxAgeDays = Number.isFinite(Number(gj._maxAgeDays)) ? Number(gj._maxAgeDays) : null;

    for (const f of gj.features || []) {
      const g = f && f.geometry;
      if (!g || g.type !== 'Point' || !Array.isArray(g.coordinates)) continue;
      const [lng, lat] = g.coordinates; // GeoJSON = [lng, lat]
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      const temp = pickTemp(f.properties);
      if (temp === null) continue;
      const ageDays = pickAgeDays(f.properties);

      const key = cellKey(lat, lng);
      let bucket = index.get(key);
      if (!bucket) index.set(key, (bucket = []));
      bucket.push([lat, lng, temp, ageDays]);
      meta.points++;
    }
    meta.loaded = true;

    if (meta.placeholder) {
      console.warn(
        '[lst] ⚠️ 載入的是合成佔位資料，不是 Landsat 觀測值。' +
          '請用 Earth Engine 匯出的 GeoJSON 覆蓋 functions/data/taipei_lst_grid.geojson'
      );
    }
    console.log(`[lst] 載入 ${meta.points} 個網格點，${index.size} 個空間格`);
  } catch (err) {
    meta.error = err.message;
    console.error('[lst] GeoJSON 載入失敗：', err.message);
  }
}

// 公尺距離（等距投影近似，500m 尺度誤差可忽略）
function distM(aLat, aLng, bLat, bLng) {
  const dLat = (aLat - bLat) * 111320;
  const dLng = (aLng - bLng) * 111320 * Math.cos((aLat * Math.PI) / 180);
  return Math.hypot(dLat, dLng);
}

/**
 * 查詢某點最近網格觀測，包含溫度與像元觀測年齡。
 * @param {number} lat
 * @param {number} lng
 * @returns {{temp:number,ageDays:number|null,distanceM:number}|null}
 */
function lookupSurfaceObservation(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  load();
  if (!meta.loaded) return null;

  // 快取到小數 4 位（約 11m），取樣間距 50m 時命中率很高
  const mk = `${lat.toFixed(4)},${lng.toFixed(4)}`;
  if (memo.has(mk)) return memo.get(mk);

  const ci = Math.floor(lat / CELL);
  const cj = Math.floor(lng / CELL);
  let best = null;
  let bestD = Infinity;

  for (let di = -1; di <= 1; di++) {
    for (let dj = -1; dj <= 1; dj++) {
      const bucket = index.get(`${ci + di}:${cj + dj}`);
      if (!bucket) continue;
      for (const [pLat, pLng, temp, ageDays] of bucket) {
        const d = distM(lat, lng, pLat, pLng);
        if (d < bestD) {
          bestD = d;
          best = { temp, ageDays, distanceM: Math.round(d) };
        }
      }
    }
  }

  const result = bestD <= MAX_DIST_M ? best : null;
  if (memo.size < MEMO_LIMIT) memo.set(mk, result);
  return result;
}

/** 相容既有呼叫端：只取攝氏地表溫度。 */
function lookupSurfaceTemp(lat, lng) {
  return lookupSurfaceObservation(lat, lng)?.temp ?? null;
}

/**
 * 一次查一串座標，回傳統計。供 coolRoute 沿線取樣使用。
 * @param {Array<{lat:number,lng:number}>} points
 */
function summarize(points) {
  let sum = 0;
  let hit = 0;
  let max = -Infinity;
  let min = Infinity;
  let ageSum = 0;
  let ageHit = 0;
  let maxAgeDays = -Infinity;

  for (const p of points) {
    const observation = lookupSurfaceObservation(p.lat, p.lng);
    if (!observation) continue;
    const t = observation.temp;
    sum += t;
    hit++;
    if (t > max) max = t;
    if (t < min) min = t;
    if (observation.ageDays !== null) {
      ageSum += observation.ageDays;
      ageHit++;
      if (observation.ageDays > maxAgeDays) maxAgeDays = observation.ageDays;
    }
  }

  if (hit === 0) {
    return {
      avg: null,
      max: null,
      min: null,
      avgAgeDays: null,
      maxAgeDays: null,
      samplePoints: points.length,
      coveredPoints: 0,
    };
  }
  return {
    avg: Math.round((sum / hit) * 10) / 10,
    max: Math.round(max * 10) / 10,
    min: Math.round(min * 10) / 10,
    avgAgeDays: ageHit ? Math.round((ageSum / ageHit) * 10) / 10 : null,
    maxAgeDays: ageHit ? Math.round(maxAgeDays * 10) / 10 : null,
    samplePoints: points.length,
    coveredPoints: hit,
  };
}

/** 資料來源標記，讓 API 回應能誠實說明用的是真資料還是佔位資料 */
function source() {
  load();
  if (!meta.loaded) return 'UNAVAILABLE';
  if (meta.placeholder) return 'PLACEHOLDER_SYNTHETIC';
  return meta.source || 'LANDSAT_8_9_SUMMER_MEDIAN';
}

/** API 與 UI 共用的誠實資料說明。 */
function datasetInfo() {
  const src = source();
  if (src === 'LANDSAT_8_9_LATEST_AVAILABLE') {
    return {
      source: src,
      label: '最新可用地表溫度（Landsat 8/9 熱紅外，逐像元最近 48 天晴空觀測）',
      disclaimer:
        '非即時溫度。每個像元的觀測日期可能不同，請搭配 age_days 判讀；' +
        '可比較不同路廊，不可分辨同一條路的兩側。',
      surfaceTempNote: '該點最新可用晴空衛星地表溫度，非即時溫度',
    };
  }
  if (src === 'PLACEHOLDER_SYNTHETIC') {
    return {
      source: src,
      label: '合成示範地表溫度（非 Landsat 觀測）',
      disclaimer: '合成佔位資料，僅供流程展示，不可用於真實熱暴露判斷。',
      surfaceTempNote: '合成示範地表溫度，非觀測資料',
    };
  }
  return {
    source: src,
    label: '夏季平均地表溫度（Landsat 8/9 熱紅外，100m 網格，2023–2026 夏季中位數）',
    disclaimer:
      '非即時溫度。Landsat 過境時間約上午 10:30，代表上午時段。' +
      '可比較不同路廊，不可分辨同一條路的兩側。',
    surfaceTempNote: '該點夏季平均地表溫度，非即時溫度',
  };
}

function stats() {
  load();
  return { ...meta, cells: index ? index.size : 0 };
}

module.exports = {
  lookupSurfaceObservation,
  lookupSurfaceTemp,
  summarize,
  source,
  datasetInfo,
  stats,
  MAX_DIST_M,
};
