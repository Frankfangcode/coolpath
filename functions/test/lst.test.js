/**
 * 評分引擎核心的離線測試（不需要 Firebase、不需要任何 API key）
 *   node functions/test/lst.test.js
 */

const assert = require('assert');
const lst = require('../lst');
const geo = require('../geo');

const 政大 = { lat: 24.9874, lng: 121.5759 };
const 台北車站 = { lat: 25.0488, lng: 121.5137 };

let pass = 0;
function t(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    pass++;
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}

/** 測試用的 polyline 編碼器（正式流程只需要解碼，這裡用來造測資） */
function encodePolyline(points) {
  let lastLat = 0;
  let lastLng = 0;
  let out = '';
  const enc = (v) => {
    v = v < 0 ? ~(v << 1) : v << 1;
    let s = '';
    while (v >= 0x20) {
      s += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    return s + String.fromCharCode(v + 63);
  };
  for (const p of points) {
    const lat = Math.round(p.lat * 1e5);
    const lng = Math.round(p.lng * 1e5);
    out += enc(lat - lastLat) + enc(lng - lastLng);
    lastLat = lat;
    lastLng = lng;
  }
  return out;
}

console.log('\nlst.js —— LST 網格查詢');

t('GeoJSON 載入成功且點數合理', () => {
  const s = lst.stats();
  assert.ok(s.loaded, `載入失敗：${s.error}`);
  assert.ok(s.points > 10000, `只載到 ${s.points} 點`);
});

t('政大查得到地表溫度，且落在合理區間 26–46°C', () => {
  const v = lst.lookupSurfaceTemp(政大.lat, 政大.lng);
  assert.ok(v !== null, '回傳 null');
  assert.ok(v >= 26 && v <= 46, `${v}°C 超出合理範圍`);
});

t('台北車站查得到地表溫度', () => {
  const v = lst.lookupSurfaceTemp(台北車站.lat, 台北車站.lng);
  assert.ok(v !== null && v >= 26 && v <= 46, `得到 ${v}`);
});

t('市中心比政大山區熱（驗證經緯度沒顛倒）', () => {
  const city = lst.lookupSurfaceTemp(台北車站.lat, 台北車站.lng);
  const hill = lst.lookupSurfaceTemp(政大.lat, 政大.lng);
  assert.ok(city > hill, `台北車站 ${city}°C 不高於政大 ${hill}°C —— 檢查 [lng, lat] 順序`);
});

t('高雄也查得到（全台網格）', () => {
  const v = lst.lookupSurfaceTemp(22.6273, 120.3014);
  assert.ok(v !== null && v >= 26 && v <= 46, `得到 ${v}`);
});

t('高雄市區比玉山熱（全台模型的都市熱島）', () => {
  const city = lst.lookupSurfaceTemp(22.6273, 120.3014);
  const mountain = lst.lookupSurfaceTemp(23.47, 120.957);
  assert.ok(city - mountain >= 5, `高雄 ${city}°C vs 玉山 ${mountain}°C，差距不足 5 度`);
});

t('網格外（外海）回傳 null', () => {
  assert.strictEqual(lst.lookupSurfaceTemp(24.0, 122.9), null);
});

t('把經緯度顛倒過來查會回 null（座標順序的防呆）', () => {
  assert.strictEqual(lst.lookupSurfaceTemp(台北車站.lng, 台北車站.lat), null);
});

t('無效輸入回傳 null 而不是丟例外', () => {
  assert.strictEqual(lst.lookupSurfaceTemp(NaN, 121), null);
  assert.strictEqual(lst.lookupSurfaceTemp(undefined, undefined), null);
});

console.log('\ngeo.js —— polyline 與沿線取樣');

const path = [];
for (let i = 0; i <= 40; i++) {
  const f = i / 40;
  path.push({
    lat: 政大.lat + (台北車站.lat - 政大.lat) * f,
    lng: 政大.lng + (台北車站.lng - 政大.lng) * f,
  });
}
const encoded = encodePolyline(path);

t('polyline 解碼還原座標（誤差 < 1e-5 度）', () => {
  const decoded = geo.decodePolyline(encoded);
  assert.strictEqual(decoded.length, path.length);
  for (let i = 0; i < path.length; i++) {
    assert.ok(Math.abs(decoded[i].lat - path[i].lat) < 1e-5, `第 ${i} 點 lat 偏移`);
    assert.ok(Math.abs(decoded[i].lng - path[i].lng) < 1e-5, `第 ${i} 點 lng 偏移`);
  }
});

t('空字串解碼不炸', () => {
  assert.deepStrictEqual(geo.decodePolyline(''), []);
  assert.deepStrictEqual(geo.decodePolyline(null), []);
});

t('路徑長度接近政大到北車直線距離（約 9–10 公里）', () => {
  const len = geo.pathLengthM(path);
  assert.ok(len > 8000 && len < 11000, `算出 ${Math.round(len)} 公尺`);
});

const samples = geo.resample(path, 50);

t('每 50 公尺取樣一點，點數與路徑長度相符', () => {
  const len = geo.pathLengthM(path);
  const expected = len / 50;
  assert.ok(
    Math.abs(samples.length - expected) < 5,
    `取樣 ${samples.length} 點，預期約 ${Math.round(expected)} 點`
  );
});

t('相鄰取樣點間距確實接近 50 公尺', () => {
  for (let i = 1; i < samples.length - 1; i++) {
    const d = geo.haversineM(samples[i - 1], samples[i]);
    assert.ok(Math.abs(d - 50) < 1, `第 ${i} 段間距 ${d.toFixed(1)} 公尺`);
  }
});

t('取樣含頭尾', () => {
  assert.ok(geo.haversineM(samples[0], path[0]) < 1);
  assert.ok(geo.haversineM(samples[samples.length - 1], path[path.length - 1]) < 60);
});

t('waypoints 取 5 個且沿路徑均勻分布', () => {
  const wps = geo.pickWaypoints(path, 5);
  assert.strictEqual(wps.length, 5);
  const total = geo.pathLengthM(path);
  wps.forEach((wp, i) => {
    // 第 i 個中繼點應該落在全長的 (i+1)/6 處
    const upto = geo.pathLengthM([...path.slice(0, 1), wp]);
    const expected = (total * (i + 1)) / 6;
    assert.ok(
      Math.abs(upto - expected) < total * 0.05,
      `第 ${i + 1} 個中繼點位置偏差過大`
    );
  });
});

t('點數過少時 waypoints 回空陣列而不是炸掉', () => {
  assert.deepStrictEqual(geo.pickWaypoints([政大], 5), []);
  assert.deepStrictEqual(geo.pickWaypoints([], 5), []);
});

console.log('\n整合 —— 沿線熱暴露評分');

const heat = lst.summarize(samples);

t('沿線統計算得出來，且覆蓋率夠高', () => {
  assert.ok(heat.avg !== null, '平均溫度為 null');
  assert.ok(heat.avg >= 26 && heat.avg <= 46, `平均 ${heat.avg}°C 超出合理範圍`);
  assert.ok(heat.max >= heat.avg && heat.avg >= heat.min, '最大/平均/最小關係不對');
  assert.ok(
    heat.coveredPoints / heat.samplePoints > 0.9,
    `覆蓋率只有 ${((heat.coveredPoints / heat.samplePoints) * 100).toFixed(0)}%`
  );
});

t('資料來源標記正確反映目前用的是哪種資料', () => {
  const src = lst.source();
  assert.ok(['LANDSAT_8_9_SUMMER_MEDIAN', 'PLACEHOLDER_SYNTHETIC'].includes(src), src);
});

console.log(
  `\n政大 → 台北車站（直線近似）：` +
    `取樣 ${heat.samplePoints} 點，平均 ${heat.avg}°C，最高 ${heat.max}°C，最低 ${heat.min}°C`
);
console.log(`LST 資料來源：${lst.source()}`);
console.log(`\n${pass} 項通過${process.exitCode ? '，有失敗項目' : '，全數通過'}\n`);
