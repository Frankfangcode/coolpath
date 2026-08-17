/**
 * lst.js — 夏季平均地表溫度（LST）查詢共用模組
 *
 * 資料來源：Landsat 8/9 熱紅外 ST_B10，2023–2026 夏季（6–9 月）影像中位數，
 *          Earth Engine 以 200m sample 匯出成點網格。原生解析度 100m。
 *
 * 誠實性：這是「夏季平均地表溫度」，不是即時氣溫，也不是現在的溫度。
 *        Landsat 過境時間約上午 10:30，代表上午時段。
 *        可比較不同路廊，不可宣稱能分辨同一條路的兩側。
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

let index = null; // Map<cellKey, Array<[lat, lng, temp]>>
let meta = { loaded: false, placeholder: false, points: 0, error: null };
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

function load() {
  if (index) return;
  index = new Map();
  try {
    const raw = fs.readFileSync(GEOJSON_PATH, 'utf8');
    const gj = JSON.parse(raw);
    meta.placeholder = gj._placeholder === true;

    for (const f of gj.features || []) {
      const g = f && f.geometry;
      if (!g || g.type !== 'Point' || !Array.isArray(g.coordinates)) continue;
      const [lng, lat] = g.coordinates; // GeoJSON = [lng, lat]
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      const temp = pickTemp(f.properties);
      if (temp === null) continue;

      const key = cellKey(lat, lng);
      let bucket = index.get(key);
      if (!bucket) index.set(key, (bucket = []));
      bucket.push([lat, lng, temp]);
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
 * 查詢某點的夏季平均地表溫度。
 * @param {number} lat
 * @param {number} lng
 * @returns {number|null} °C，最近網格點超過 500m 或無資料時回 null
 */
function lookupSurfaceTemp(lat, lng) {
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
      for (const [pLat, pLng, temp] of bucket) {
        const d = distM(lat, lng, pLat, pLng);
        if (d < bestD) {
          bestD = d;
          best = temp;
        }
      }
    }
  }

  const result = bestD <= MAX_DIST_M ? best : null;
  if (memo.size < MEMO_LIMIT) memo.set(mk, result);
  return result;
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

  for (const p of points) {
    const t = lookupSurfaceTemp(p.lat, p.lng);
    if (t === null) continue;
    sum += t;
    hit++;
    if (t > max) max = t;
    if (t < min) min = t;
  }

  if (hit === 0) {
    return { avg: null, max: null, min: null, samplePoints: points.length, coveredPoints: 0 };
  }
  return {
    avg: Math.round((sum / hit) * 10) / 10,
    max: Math.round(max * 10) / 10,
    min: Math.round(min * 10) / 10,
    samplePoints: points.length,
    coveredPoints: hit,
  };
}

/** 資料來源標記，讓 API 回應能誠實說明用的是真資料還是佔位資料 */
function source() {
  load();
  if (!meta.loaded) return 'UNAVAILABLE';
  return meta.placeholder ? 'PLACEHOLDER_SYNTHETIC' : 'LANDSAT_8_9_SUMMER_MEDIAN';
}

function stats() {
  load();
  return { ...meta, cells: index ? index.size : 0 };
}

module.exports = { lookupSurfaceTemp, summarize, source, stats, MAX_DIST_M };
