#!/usr/bin/env node
/**
 * 把兩份 Earth Engine 匯出的 LST GeoJSON 合併成一份雙解析度網格。
 *
 *   node tools/merge_lst_grids.js <細網格.geojson> <粗網格.geojson> [--install]
 *
 * 例：
 *   node tools/merge_lst_grids.js ~/Downloads/taipei_lst_grid.geojson \
 *                                 ~/Downloads/taiwan_lst_grid.geojson --install
 *
 * 細網格（大台北 100m）的範圍內會蓋掉粗網格（全台 1km）的點，
 * 產生的檔案帶 `_detailBbox`，前端據此決定熱區圓點的渲染半徑。
 *
 * 只有一份也可以：第二個參數留空就只處理細網格。
 *
 * 合併完務必再跑一次驗證：
 *   node tools/verify_lst_grid.js public/data/taipei_lst_grid.geojson
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const install = args.includes('--install');
const files = args.filter((a) => !a.startsWith('--'));

if (files.length === 0) {
  console.error(
    '用法：node tools/merge_lst_grids.js <細網格.geojson> [粗網格.geojson] [--install]'
  );
  process.exit(1);
}

const TEMP_KEYS = ['LST', 'lst', 'ST_B10', 'mean', 'median', 'b1', 'temp'];

function pickTemp(props) {
  if (!props) return null;
  for (const k of TEMP_KEYS) {
    const v = Number(props[k]);
    if (Number.isFinite(v)) return v;
  }
  for (const v of Object.values(props)) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0 && n < 80) return n;
  }
  return null;
}

/** 讀檔並正規化成 [{lat, lng, t}]，順便回報異常 */
function read(file, label) {
  if (!fs.existsSync(file)) {
    console.error(`✗ 找不到檔案：${file}`);
    process.exit(1);
  }
  const gj = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (gj._placeholder === true) {
    console.error(`✗ ${label} 是合成佔位資料，不是 Landsat 匯出結果`);
    process.exit(1);
  }

  const pts = [];
  let skipped = 0;
  for (const f of gj.features || []) {
    const g = f && f.geometry;
    if (!g || g.type !== 'Point' || !Array.isArray(g.coordinates)) {
      skipped++;
      continue;
    }
    const [lng, lat] = g.coordinates; // GeoJSON = [lng, lat]
    const t = pickTemp(f.properties);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || t === null) {
      skipped++;
      continue;
    }
    pts.push({ lat, lng, t });
  }

  if (pts.length === 0) {
    console.error(`✗ ${label} 沒有任何有效的點`);
    process.exit(1);
  }

  const temps = pts.map((p) => p.t);
  const lo = Math.min(...temps);
  const hi = Math.max(...temps);
  console.log(
    `  ${label.padEnd(10, '　')} ${pts.length} 點　` +
      `${lo.toFixed(1)}–${hi.toFixed(1)}°C` +
      (skipped ? `　（略過 ${skipped} 筆無效）` : '')
  );

  // 攝氏/克氏搞混是最常見的靜默錯誤，這裡直接擋掉
  if (hi > 100) {
    console.error(`✗ ${label} 最高溫 ${hi.toFixed(1)}，看起來是克氏溫度 —— 忘了減 273.15`);
    process.exit(1);
  }
  return pts;
}

console.log('\n── 讀取 ──');
const fine = read(files[0], '細網格');
const coarse = files[1] ? read(files[1], '粗網格') : [];

/* ── 細網格的 bbox，粗網格落在裡面的點要丟掉 ── */

const bbox = {
  west: Math.min(...fine.map((p) => p.lng)),
  east: Math.max(...fine.map((p) => p.lng)),
  south: Math.min(...fine.map((p) => p.lat)),
  north: Math.max(...fine.map((p) => p.lat)),
};

const round = (n, d) => {
  const m = 10 ** d;
  return Math.round(n * m) / m;
};

const kept = coarse.filter(
  (p) =>
    p.lat < bbox.south || p.lat > bbox.north || p.lng < bbox.west || p.lng > bbox.east
);

if (coarse.length) {
  console.log('\n── 合併 ──');
  console.log(
    `  細網格範圍　 ${bbox.south.toFixed(3)}–${bbox.north.toFixed(3)}°N, ` +
      `${bbox.west.toFixed(3)}–${bbox.east.toFixed(3)}°E`
  );
  console.log(`  粗網格保留　 ${kept.length} 點（範圍內 ${coarse.length - kept.length} 點由細網格取代）`);
}

const merged = [...fine, ...kept];

const geojson = {
  type: 'FeatureCollection',
  _source: 'LANDSAT_8_9_SUMMER_MEDIAN',
  _note: files[1]
    ? '大台北細網格 + 全台粗網格，皆為 Landsat 8/9 夏季中位數地表溫度'
    : 'Landsat 8/9 夏季中位數地表溫度',
  _detailBbox: {
    west: round(bbox.west, 5),
    south: round(bbox.south, 5),
    east: round(bbox.east, 5),
    north: round(bbox.north, 5),
  },
  _generatedAt: new Date().toISOString(),
  columns: { LST: 'Float' },
  features: merged.map((p) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [round(p.lng, 5), round(p.lat, 5)] },
    properties: { LST: round(p.t, 1) },
  })),
};

const json = JSON.stringify(geojson);
const temps = merged.map((p) => p.t);

console.log('\n── 結果 ──');
console.log(
  `  合計 ${merged.length} 點　` +
    `${Math.min(...temps).toFixed(1)}–${Math.max(...temps).toFixed(1)}°C　` +
    `平均 ${(temps.reduce((a, b) => a + b, 0) / merged.length).toFixed(1)}°C　` +
    `${(json.length / 1048576).toFixed(1)} MB`
);

// 沒有 _placeholder 欄位，lst.js 會自動把 lstSource 標成 LANDSAT_8_9_SUMMER_MEDIAN，
// 前端的橘色警告條也會自動消失
console.log('  ✓ 不含 _placeholder，前端警告條會自動消失');

const TARGETS = ['public/data', 'functions/data'];

if (!install) {
  const out = path.join(__dirname, '..', 'merged_lst_grid.geojson');
  fs.writeFileSync(out, json);
  console.log(`\n寫到 ${path.relative(process.cwd(), out)}`);
  console.log('確認沒問題後，加 --install 直接安裝到兩個 data 目錄。\n');
} else {
  for (const target of TARGETS) {
    const dir = path.join(__dirname, '..', target);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'taipei_lst_grid.geojson'), json);
  }
  console.log(`\n已安裝到 ${TARGETS.join(' 與 ')}`);
  console.log('接著跑：');
  console.log('  node tools/verify_lst_grid.js public/data/taipei_lst_grid.geojson');
  console.log('  npm test');
  console.log('  npm run deploy      ← 兩份資料都要部署\n');
}
