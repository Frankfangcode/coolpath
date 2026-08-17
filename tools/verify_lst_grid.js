#!/usr/bin/env node
/**
 * 驗證 Earth Engine 匯出的 LST 網格 GeoJSON。
 *
 *   node tools/verify_lst_grid.js ~/Downloads/taipei_lst_grid.geojson
 *
 * 全部通過的話，加 --install 直接複製到 public/data/ 與 functions/data/：
 *
 *   node tools/verify_lst_grid.js ~/Downloads/taipei_lst_grid.geojson --install
 *
 * 不給檔名就檢查目前專案裡已安裝的那份。
 *
 * 這支工具存在的理由：LST 資料壞掉的方式都是「安靜」的 —— 經緯度顛倒、
 * 忘了減 273.15、雲遮罩吃掉半個台北，程式都不會報錯，只會讓 heatScore
 * 全部變成 null 或一堆假數字，然後你在台上才發現。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'public', 'data', 'taipei_lst_grid.geojson'),
  path.join(ROOT, 'functions', 'data', 'taipei_lst_grid.geojson'),
];

const args = process.argv.slice(2);
const install = args.includes('--install');
const inputPath = args.find((a) => !a.startsWith('--')) || TARGETS[1];

// Earth Engine 腳本裡的 bbox
const BBOX = { west: 121.45, south: 24.95, east: 121.67, north: 25.21 };

let failed = 0;
let warned = 0;

const ok = (msg, detail) => console.log(`  ✓ ${msg}${detail ? `　${detail}` : ''}`);
const warn = (msg, detail) => {
  warned++;
  console.log(`  ! ${msg}${detail ? `　${detail}` : ''}`);
};
const fail = (msg, detail, fix) => {
  failed++;
  console.log(`  ✗ ${msg}${detail ? `　${detail}` : ''}`);
  if (fix) console.log(`      → ${fix}`);
};

/* ────────────────────────── 載入 ────────────────────────── */

console.log(`\n檢查 ${inputPath}\n`);

if (!fs.existsSync(inputPath)) {
  console.error(`找不到檔案：${inputPath}\n`);
  process.exit(1);
}

const sizeMB = fs.statSync(inputPath).size / 1048576;
let gj;
try {
  gj = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
} catch (err) {
  console.error(`JSON 解析失敗：${err.message}`);
  console.error('Earth Engine 偶爾會匯出成 GeoJSON Text Sequence，請確認 fileFormat 是 GeoJSON。\n');
  process.exit(1);
}

console.log('── 檔案結構 ──');

if (gj.type !== 'FeatureCollection') {
  fail('不是 FeatureCollection', `type = ${gj.type}`, 'Export.table.toDrive 的 fileFormat 要設 GeoJSON');
} else {
  ok('是 FeatureCollection', `${sizeMB.toFixed(1)} MB`);
}

const features = Array.isArray(gj.features) ? gj.features : [];

if (gj._placeholder === true) {
  fail(
    '這是本專案產生的合成佔位資料，不是 Landsat 觀測值',
    '',
    '跑 tools/earthengine_lst_export.js 匯出真資料後再驗一次'
  );
} else {
  ok('沒有佔位標記，看起來是真的匯出檔');
}

/* ────────────────────────── 點數 ────────────────────────── */

console.log('\n── 網格點數 ──');

if (features.length === 0) {
  fail('沒有任何 feature', '', '檢查 EE 的 lst.sample() 是否回傳空集合');
  console.log('\n無法繼續檢查。\n');
  process.exit(1);
} else if (features.length < 8000) {
  fail(
    `只有 ${features.length} 點，太少`,
    '預期約 14,000–17,000',
    'scale 可能設得比 200 大，或雲遮罩吃掉太多資料'
  );
} else if (features.length > 150000) {
  warn(
    `${features.length} 點，太多`,
    'scale 可能小於 100（比 Landsat 原生解析度還細，沒有意義），檔案會拖慢前端載入'
  );
} else {
  ok(
    `${features.length} 點`,
    '大台北 100m 約 55,000–70,000；200m 約 14,000–17,000；併入全台 1km 再加約 35,000'
  );
}

/* ────────────────────────── 溫度欄位 ────────────────────────── */

console.log('\n── 溫度欄位 ──');

const TEMP_KEYS = ['LST', 'lst', 'ST_B10', 'mean', 'median', 'b1', 'temp'];
const propKeys = Object.keys(features[0].properties || {});
const tempKey = TEMP_KEYS.find((k) => propKeys.includes(k));

if (!tempKey) {
  fail(
    '找不到溫度欄位',
    `現有欄位：${propKeys.join(', ') || '（無）'}`,
    'EE 腳本裡要有 .rename("LST")'
  );
} else if (tempKey === 'LST') {
  ok('溫度欄位是 LST');
} else {
  warn(`溫度欄位是 ${tempKey} 而不是 LST`, 'lst.js 讀得到，但建議在 EE 腳本加 .rename("LST")');
}

/* ────────────────────────── 座標 ────────────────────────── */

console.log('\n── 座標（GeoJSON 是 [lng, lat]，這是最常出錯的地方）──');

let badGeom = 0;
let outOfBox = 0;
let swapped = 0;
const pts = [];

for (const f of features) {
  const g = f && f.geometry;
  if (!g || g.type !== 'Point' || !Array.isArray(g.coordinates)) {
    badGeom++;
    continue;
  }
  const [lng, lat] = g.coordinates;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    badGeom++;
    continue;
  }
  // 顛倒的話 lat 會落在 121 附近、lng 落在 25 附近
  if (lat > 100 && lng < 100) swapped++;
  if (lng < BBOX.west - 0.05 || lng > BBOX.east + 0.05 || lat < BBOX.south - 0.05 || lat > BBOX.north + 0.05) {
    outOfBox++;
  }
  const t = tempKey ? f.properties[tempKey] : null;
  if (typeof t === 'number') pts.push({ lat, lng, t });
}

if (badGeom > 0) warn(`${badGeom} 筆 geometry 無效`, '已略過');
else ok('所有 feature 都是有效的 Point');

if (swapped > 0) {
  fail(
    `${swapped} 筆座標順序顛倒`,
    '',
    'GeoJSON 必須是 [lng, lat]。順序反了會讓所有 LST 查詢回傳 null'
  );
} else {
  ok('座標順序正確（[lng, lat]）');
}

if (outOfBox > features.length * 0.02) {
  fail(`${outOfBox} 筆落在台北 bbox 外`, '', 'EE 腳本的 taipei Rectangle 可能被改過');
} else if (outOfBox > 0) {
  warn(`${outOfBox} 筆略微超出 bbox`, '邊界效應，可接受');
} else {
  ok('全部落在台北 bbox 內');
}

const lats = pts.map((p) => p.lat);
const lngs = pts.map((p) => p.lng);
ok(
  '實際涵蓋範圍',
  `經度 ${Math.min(...lngs).toFixed(3)}–${Math.max(...lngs).toFixed(3)}、` +
    `緯度 ${Math.min(...lats).toFixed(3)}–${Math.max(...lats).toFixed(3)}`
);

/* ────────────────────────── 數值 ────────────────────────── */

console.log('\n── 溫度數值 ──');

const temps = pts.map((p) => p.t).sort((a, b) => a - b);
const q = (f) => temps[Math.floor((temps.length - 1) * f)];
const mean = temps.reduce((a, b) => a + b, 0) / temps.length;

if (temps.length === 0) {
  fail('沒有任何有效溫度值');
} else {
  const min = temps[0];
  const max = temps[temps.length - 1];

  if (min > 200) {
    fail(
      `數值落在 ${min.toFixed(0)}–${max.toFixed(0)}，這是 Kelvin`,
      '',
      'EE 腳本忘了 .subtract(273.15)'
    );
  } else if (max > 60) {
    fail(`最高 ${max.toFixed(1)}°C，過高`, '', '可能混到未遮罩的雲或縮放係數用錯');
  } else if (min < 10) {
    warn(`最低 ${min.toFixed(1)}°C，偏低`, '可能有殘留的雲影未被遮掉');
  } else if (min < 20 || max < 38) {
    warn(`範圍 ${min.toFixed(1)}–${max.toFixed(1)}°C 略偏離預期`, '預期約 26–46°C');
  } else {
    ok(`範圍 ${min.toFixed(1)}–${max.toFixed(1)}°C`, '預期約 26–46°C');
  }

  ok(
    '分位數',
    `p5 ${q(0.05).toFixed(1)}　中位數 ${q(0.5).toFixed(1)}　` +
      `p95 ${q(0.95).toFixed(1)}　平均 ${mean.toFixed(1)}`
  );

  if (mean < 28 || mean > 42) {
    warn(`平均 ${mean.toFixed(1)}°C 偏離夏季台北的合理區間`, '預期約 32–38°C');
  }
}

/* ────────────────────────── 都市熱島 ────────────────────────── */

console.log('\n── 都市熱島是否成立（資料對不對的關鍵）──');

function nearest(lat, lng) {
  let best = null;
  let bestD = Infinity;
  for (const p of pts) {
    const dLat = (p.lat - lat) * 111320;
    const dLng = (p.lng - lng) * 111320 * Math.cos((lat * Math.PI) / 180);
    const d = Math.hypot(dLat, dLng);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return bestD <= 500 ? { t: best.t, d: bestD } : null;
}

const PROBES = [
  { name: '台北車站', lat: 25.0488, lng: 121.5137, kind: 'hot' },
  { name: '信義區', lat: 25.033, lng: 121.5654, kind: 'hot' },
  { name: '大安森林公園', lat: 25.033, lng: 121.5436, kind: 'cool' },
  { name: '政治大學', lat: 24.9874, lng: 121.5759, kind: 'cool' },
  { name: '陽明山', lat: 25.165, lng: 121.545, kind: 'cool' },
];

const probed = [];
for (const p of PROBES) {
  const hit = nearest(p.lat, p.lng);
  if (!hit) {
    fail(`${p.name} 500 公尺內查無資料`, '', '該區域可能被雲遮罩整片吃掉');
  } else {
    probed.push({ ...p, t: hit.t });
    console.log(`    ${p.name.padEnd(7, '　')} ${hit.t.toFixed(1)}°C　（最近網格點 ${Math.round(hit.d)} m）`);
  }
}

const hots = probed.filter((p) => p.kind === 'hot');
const cools = probed.filter((p) => p.kind === 'cool');

if (hots.length && cools.length) {
  const hotAvg = hots.reduce((a, b) => a + b.t, 0) / hots.length;
  const coolAvg = cools.reduce((a, b) => a + b.t, 0) / cools.length;
  const delta = hotAvg - coolAvg;

  if (delta < 0) {
    fail(
      `市區比山區還涼 ${(-delta).toFixed(1)} 度`,
      '',
      '資料有問題，不要用。先確認經緯度順序與 EE 腳本的遮罩邏輯'
    );
  } else if (delta < 2) {
    warn(`市區只比山區熱 ${delta.toFixed(1)} 度`, '偏小，預期 5 度以上。可能混到非夏季影像');
  } else {
    ok(`市區比山區熱 ${delta.toFixed(1)} 度`, '都市熱島成立');
  }
}

/* ────────────────────────── 示範路線覆蓋率 ────────────────────────── */

console.log('\n── 示範路線覆蓋率（政大 → 台北車站）──');

const A = { lat: 24.9874, lng: 121.5759 };
const B = { lat: 25.0488, lng: 121.5137 };
let covered = 0;
const N = 100;
for (let i = 0; i <= N; i++) {
  const f = i / N;
  if (nearest(A.lat + (B.lat - A.lat) * f, A.lng + (B.lng - A.lng) * f)) covered++;
}
const ratio = covered / (N + 1);

if (ratio < 0.8) {
  fail(
    `沿線只有 ${(ratio * 100).toFixed(0)}% 的取樣點查得到資料`,
    '',
    'heatScore 會嚴重失真，需要放寬雲量門檻重新匯出'
  );
} else if (ratio < 0.95) {
  warn(`沿線覆蓋率 ${(ratio * 100).toFixed(0)}%`, '可用，但有資料空洞');
} else {
  ok(`沿線覆蓋率 ${(ratio * 100).toFixed(0)}%`);
}

/* ────────────────────────── 兩份副本是否一致 ────────────────────────── */

console.log('\n── 已安裝的兩份副本 ──');

const installed = TARGETS.map((p) => ({
  path: p,
  exists: fs.existsSync(p),
  size: fs.existsSync(p) ? fs.statSync(p).size : 0,
}));

for (const f of installed) {
  if (!f.exists) fail(`缺少 ${path.relative(ROOT, f.path)}`, '', '兩邊都要有同一份');
}
if (installed.every((f) => f.exists)) {
  if (installed[0].size === installed[1].size) {
    ok('public/data 與 functions/data 兩份一致');
  } else {
    fail(
      '兩份大小不同',
      `${installed[0].size} vs ${installed[1].size}`,
      '用 --install 重新安裝，確保兩邊同步'
    );
  }
}

/* ────────────────────────── 結果 ────────────────────────── */

console.log('');
if (failed > 0) {
  console.log(`✗ ${failed} 項不合格${warned ? `，另有 ${warned} 項警告` : ''}。先修好再用。\n`);
  process.exit(1);
}

if (install) {
  const raw = fs.readFileSync(inputPath);
  for (const target of TARGETS) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, raw);
    console.log(`已安裝 → ${path.relative(ROOT, target)}`);
  }
  console.log('\n接著跑 cd functions && npm test 確認評分引擎仍然正常。\n');
} else {
  console.log(`✓ 全部合格${warned ? `（${warned} 項警告）` : ''}。`);
  if (path.resolve(inputPath) !== path.resolve(TARGETS[1])) {
    console.log(`  加 --install 可複製到 public/data/ 與 functions/data/。`);
  }
  console.log('');
}
