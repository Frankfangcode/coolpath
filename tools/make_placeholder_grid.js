#!/usr/bin/env node
/**
 * 產生「佔位用」的 LST 網格 GeoJSON，schema 與 Earth Engine 匯出完全一致。
 *
 * ⚠️ 這不是 Landsat 資料。它只是為了讓整條 pipeline 在真資料到位前能跑起來。
 *    真的資料請跑指令包附錄的 Earth Engine 腳本匯出後覆蓋
 *    public/data/ 與 functions/data/ 兩份。
 *
 * 覆蓋範圍（雙解析度）：
 *   - 大台北 bbox：200m 網格（demo 路線需要街廓尺度的對比）
 *   - 台灣本島其餘地區：1.1km 網格（粗略海岸線多邊形遮罩，離島不含）
 *     lst.js 的搜尋半徑 800m >= 1.1km 網格的半對角線 778m，查詢不會漏
 *
 * 檔案裡帶 "_placeholder": true，lst.js 會偵測到並在 API 回應標記
 * meta.lstSource = "PLACEHOLDER_SYNTHETIC"，前端會顯示警告條。
 * 真資料沒有這個欄位，警告就會自動消失。
 *
 * 用法：node tools/make_placeholder_grid.js
 */

const fs = require('fs');
const path = require('path');

// 大台北高解析區，與 Earth Engine 腳本同一個 bbox
const TAIPEI_BBOX = { west: 121.45, south: 24.95, east: 121.67, north: 25.21 };
const TAIPEI_SCALE_M = 200;

// 全台粗網格
const TAIWAN_BBOX = { west: 120.0, south: 21.85, east: 122.05, north: 25.35 };
const TAIWAN_SCALE_M = 1100;

// 確定性亂數，讓每次產生的檔案一致
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260817);

const km = (aLat, aLng, bLat, bLng) => {
  const dLat = (aLat - bLat) * 111.32;
  const dLng = (aLng - bLng) * 111.32 * Math.cos((aLat * Math.PI) / 180);
  return Math.hypot(dLat, dLng);
};

/* ────────────── 台灣本島粗略海岸線（順時針，[lat, lng]） ────────────── */

const TAIWAN_OUTLINE = [
  [25.30, 121.57], // 富貴角
  [25.21, 121.70], // 金山
  [25.13, 121.92], // 鼻頭角
  [24.85, 121.83], // 頭城
  [24.60, 121.87], // 蘇澳
  [24.20, 121.68], // 和平
  [23.97, 121.63], // 花蓮
  [23.45, 121.50], // 玉里外海岸
  [23.10, 121.40], // 成功
  [22.75, 121.20], // 台東
  [22.55, 120.98], // 太麻里南
  [21.90, 120.86], // 鵝鑾鼻
  [21.93, 120.70], // 貓鼻頭
  [22.30, 120.62], // 枋寮
  [22.47, 120.42], // 林園
  [22.62, 120.26], // 高雄
  [23.00, 120.08], // 台南七股
  [23.55, 120.07], // 口湖
  [23.85, 120.25], // 芳苑
  [24.20, 120.47], // 台中港
  [24.62, 120.73], // 後龍
  [24.90, 120.93], // 新竹南寮
  [25.12, 121.24], // 林口台地北緣
  [25.19, 121.41], // 淡水
];

/** Ray casting 點在多邊形內判斷 */
function inTaiwan(lat, lng) {
  let inside = false;
  const n = TAIWAN_OUTLINE.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [yi, xi] = TAIWAN_OUTLINE[i];
    const [yj, xj] = TAIWAN_OUTLINE[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

const inTaipeiBbox = (lat, lng) =>
  lat >= TAIPEI_BBOX.south && lat <= TAIPEI_BBOX.north &&
  lng >= TAIPEI_BBOX.west && lng <= TAIPEI_BBOX.east;

/* ────────────── 大台北模型（與原版一致，保住 demo 路線的對比） ────────────── */

// 冷源：山區、河道、大型綠地（座標為粗略中心點）
const TAIPEI_COOL = [
  { lat: 25.165, lng: 121.545, r: 5.5, drop: 13 }, // 陽明山
  { lat: 24.975, lng: 121.585, r: 4.5, drop: 12 }, // 木柵 / 二格山
  { lat: 25.135, lng: 121.63, r: 4.0, drop: 10 },  // 內湖東側山區
  { lat: 25.02, lng: 121.6, r: 3.5, drop: 9 },     // 南港 / 四獸山
  { lat: 25.095, lng: 121.47, r: 3.0, drop: 7 },   // 社子 / 淡水河口
  { lat: 25.075, lng: 121.52, r: 1.6, drop: 4 },   // 基隆河截彎段
  { lat: 25.038, lng: 121.548, r: 0.8, drop: 3 },  // 大安森林公園
  { lat: 25.045, lng: 121.5, r: 1.2, drop: 3.5 },  // 淡水河 / 華中河濱
];

// 熱源：高密度街廓
const TAIPEI_HOT = [
  { lat: 25.045, lng: 121.517, r: 2.6, add: 4.5 }, // 台北車站 / 西門
  { lat: 25.052, lng: 121.545, r: 2.2, add: 4.0 }, // 中山 / 松江
  { lat: 25.033, lng: 121.565, r: 2.4, add: 3.8 }, // 信義 / 市府
  { lat: 25.062, lng: 121.494, r: 2.0, add: 3.2 }, // 三重 / 蘆洲側
  { lat: 25.014, lng: 121.535, r: 1.8, add: 2.6 }, // 公館 / 萬隆
];

function taipeiTemp(lat, lng) {
  let t = 40.5; // 都市基準面溫
  for (const c of TAIPEI_COOL) {
    const d = km(lat, lng, c.lat, c.lng);
    t -= c.drop * Math.exp(-(d * d) / (2 * c.r * c.r));
  }
  for (const h of TAIPEI_HOT) {
    const d = km(lat, lng, h.lat, h.lng);
    t += h.add * Math.exp(-(d * d) / (2 * h.r * h.r));
  }
  // 街廓尺度的細部變異 + 感測雜訊
  t += 1.1 * Math.sin(lat * 640) * Math.cos(lng * 610);
  return t;
}

/* ────────────── 全台模型：中央山脈冷脊 + 西部平原城市熱島 ────────────── */

// 中央山脈／雪山山脈脊線（粗略）
const RIDGE = [
  { lat: 24.90, lng: 121.55, r: 8, drop: 10 },  // 雪山北段（台北南緣）
  { lat: 24.70, lng: 121.42, r: 12, drop: 13 },
  { lat: 24.38, lng: 121.28, r: 15, drop: 15 }, // 雪山
  { lat: 24.15, lng: 121.28, r: 15, drop: 15 }, // 合歡山
  { lat: 23.85, lng: 121.15, r: 16, drop: 15 }, // 能高 / 奇萊
  { lat: 23.47, lng: 120.96, r: 16, drop: 16 }, // 玉山
  { lat: 23.10, lng: 120.90, r: 15, drop: 14 },
  { lat: 22.70, lng: 120.76, r: 13, drop: 13 }, // 北大武
  { lat: 22.30, lng: 120.78, r: 10, drop: 10 }, // 恆春半島山地
  { lat: 24.55, lng: 121.65, r: 9, drop: 10 },  // 蘭陽溪南側山區
];

// 西部平原與縱谷主要城市熱島
const CITY_HOT = [
  { lat: 24.99, lng: 121.30, r: 6, add: 3.0 }, // 桃園
  { lat: 24.95, lng: 121.22, r: 5, add: 2.5 }, // 中壢
  { lat: 24.80, lng: 120.97, r: 5, add: 3.0 }, // 新竹
  { lat: 24.15, lng: 120.66, r: 8, add: 4.0 }, // 台中
  { lat: 24.07, lng: 120.54, r: 5, add: 3.0 }, // 彰化
  { lat: 23.48, lng: 120.44, r: 5, add: 3.0 }, // 嘉義
  { lat: 23.00, lng: 120.20, r: 7, add: 4.0 }, // 台南
  { lat: 22.63, lng: 120.30, r: 8, add: 4.5 }, // 高雄
  { lat: 22.67, lng: 120.49, r: 5, add: 3.0 }, // 屏東
  { lat: 24.75, lng: 121.75, r: 5, add: 2.5 }, // 宜蘭 / 羅東
  { lat: 23.98, lng: 121.60, r: 4, add: 2.5 }, // 花蓮
  { lat: 22.75, lng: 121.15, r: 4, add: 2.5 }, // 台東
];

function taiwanTemp(lat, lng) {
  // 南部基準比北部熱
  let t = 38.5 + (24.6 - lat) * 0.7;
  for (const c of RIDGE) {
    const d = km(lat, lng, c.lat, c.lng);
    t -= c.drop * Math.exp(-(d * d) / (2 * c.r * c.r));
  }
  for (const h of CITY_HOT) {
    const d = km(lat, lng, h.lat, h.lng);
    t += h.add * Math.exp(-(d * d) / (2 * h.r * h.r));
  }
  t += 0.9 * Math.sin(lat * 240) * Math.cos(lng * 230);
  return t;
}

/* ────────────── 產生點 ────────────── */

function round(n, d) {
  const p = Math.pow(10, d);
  return Math.round(n * p) / p;
}

const features = [];
function push(lat, lng, t) {
  t = Math.max(26, Math.min(45.5, t + (rand() - 0.5) * 1.4));
  features.push({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [round(lng, 5), round(lat, 5)] },
    properties: { LST: round(t, 1) },
  });
}

// 大台北 200m
{
  const latStep = TAIPEI_SCALE_M / 111320;
  const lngStep = TAIPEI_SCALE_M / (111320 * Math.cos((25.08 * Math.PI) / 180));
  for (let lat = TAIPEI_BBOX.south; lat <= TAIPEI_BBOX.north; lat += latStep) {
    for (let lng = TAIPEI_BBOX.west; lng <= TAIPEI_BBOX.east; lng += lngStep) {
      if (rand() < 0.012) continue; // 模擬雲遮罩空洞（Landsat 實際上也會有）
      push(lat, lng, taipeiTemp(lat, lng));
    }
  }
}
const taipeiCount = features.length;

// 全台 1.1km（跳過大台北 bbox，避免重複）
{
  const latStep = TAIWAN_SCALE_M / 111320;
  const lngStep = TAIWAN_SCALE_M / (111320 * Math.cos((23.6 * Math.PI) / 180));
  for (let lat = TAIWAN_BBOX.south; lat <= TAIWAN_BBOX.north; lat += latStep) {
    for (let lng = TAIWAN_BBOX.west; lng <= TAIWAN_BBOX.east; lng += lngStep) {
      if (inTaipeiBbox(lat, lng)) continue;
      if (!inTaiwan(lat, lng)) continue;
      if (rand() < 0.012) continue;
      push(lat, lng, taiwanTemp(lat, lng));
    }
  }
}

const geojson = {
  type: 'FeatureCollection',
  _placeholder: true,
  _note:
    '合成佔位資料，非 Landsat 觀測值。全台示範網格（本島 1.1km、大台北 200m）。' +
    '請用 Earth Engine 匯出的真資料覆蓋此檔。',
  _detailBbox: TAIPEI_BBOX, // 前端據此決定熱區圓點的渲染半徑
  columns: { LST: 'Float' },
  features,
};

const json = JSON.stringify(geojson);
for (const target of ['public/data', 'functions/data']) {
  const dir = path.join(__dirname, '..', target);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'taipei_lst_grid.geojson'), json);
}

const temps = features.map((f) => f.properties.LST);
console.log(
  `寫出 ${features.length} 點（大台北 ${taipeiCount}、全台粗網格 ${features.length - taipeiCount}）` +
    ` → public/data/ 與 functions/data/`
);
console.log(
  `LST 範圍 ${Math.min(...temps).toFixed(1)}–${Math.max(...temps).toFixed(1)}°C，` +
    `平均 ${(temps.reduce((a, b) => a + b, 0) / temps.length).toFixed(1)}°C，` +
    `檔案 ${(json.length / 1048576).toFixed(1)} MB`
);
