/**
 * 台灣本島夏季平均地表溫度 —— 粗網格 GeoJSON 匯出
 *
 * 於 https://code.earthengine.google.com 執行，不是 Node 程式。
 *
 * 這支是 earthengine_lst_export.js（大台北 100m）的搭配品：
 * 同樣的夏季中位數演算法，但範圍是全台本島、間距 1 公里。
 * 兩份合併後，台北有街道級解析度，其他縣市有區域級覆蓋，
 * 全台任何路線都算得出熱暴露，且完全走現有的 GeoJSON pipeline，
 * 不需要 COG tile server。
 *
 * ⚠️ 兩支腳本的演算法必須一致（都是夏季中位數），否則合併後
 *    台北與外縣市的數值語意不同，跨區路線的比較會失真。
 *    這也是為什麼不要拿 earthengine_taiwan_latest_lst.js（最新可用觀測）
 *    來跟這支混用。
 *
 * 匯出後：
 *   node tools/merge_lst_grids.js ~/Downloads/taipei_lst_grid.geojson \
 *                                 ~/Downloads/taiwan_lst_grid.geojson --install
 */

/* ══════════════════════════════════════════════════════════════════
   設定
   ══════════════════════════════════════════════════════════════════ */

// 取樣間距（公尺）。1000m 約 36,000 點、3 MB。
// 不要調到 500 以下，全台點數會爆掉、前端載不動。
var SCALE = 1000;

// 與大台北腳本相同的時間範圍，確保兩份資料語意一致
var DATE_START = '2023-06-01';
var DATE_END = '2026-09-30';
var SUMMER_MONTHS = [6, 9]; // 6–9 月
var MAX_CLOUD = 30;

var EXPORT_NAME = 'taiwan_lst_grid';

/* ══════════════════════════════════════════════════════════════════ */

// USDOS/LSIB_SIMPLE/2017 是簡化國界，適合本島示範。
// 要含澎湖金門馬祖請換成自己的完整行政界線 Asset。
var taiwan = ee.FeatureCollection('USDOS/LSIB_SIMPLE/2017')
  .filter(ee.Filter.eq('country_na', 'Taiwan'))
  .geometry();

function prep(img) {
  var lst = img.select('ST_B10')
    .multiply(0.00341802).add(149.0).subtract(273.15)   // Kelvin → 攝氏
    .rename('LST');
  var qa = img.select('QA_PIXEL');
  var mask = qa.bitwiseAnd(1 << 3).eq(0)                // 去雲
              .and(qa.bitwiseAnd(1 << 4).eq(0));        // 去雲影
  return lst.updateMask(mask);
}

var col = ee.ImageCollection('LANDSAT/LC08/C02/T1_L2')
  .merge(ee.ImageCollection('LANDSAT/LC09/C02/T1_L2'))
  .filterBounds(taiwan)
  .filterDate(DATE_START, DATE_END)
  .filter(ee.Filter.calendarRange(SUMMER_MONTHS[0], SUMMER_MONTHS[1], 'month'))
  .filter(ee.Filter.lt('CLOUD_COVER', MAX_CLOUD))
  .map(prep);

var lst = col.median().clip(taiwan);

Map.centerObject(taiwan, 8);
Map.addLayer(lst, {min: 26, max: 44,
  palette: ['#2c7bb6','#abd9e9','#ffffbf','#fdae61','#d7191c']}, '全台 LST');


/* ══════════════════════════════════════════════════════════════════
   匯出前的四項檢查 —— 全部合格再去 Tasks 按 RUN
   ══════════════════════════════════════════════════════════════════ */

print('═══ 檢查 1：影像數量 ═══');
print('合格標準：全台範圍應有數百幅。太少代表雲量門檻太嚴。');
print('影像數', col.size());

print('═══ 檢查 2：數值範圍 ═══');
print('合格標準：約 20–48°C（全台含高山，下限會比台北低）。');
print('  出現 300 以上 → 忘了減 273.15');
print('統計', lst.reduceRegion({
  reducer: ee.Reducer.minMax()
    .combine(ee.Reducer.mean(), '', true)
    .combine(ee.Reducer.percentile([5, 50, 95]), '', true),
  geometry: taiwan,
  scale: 1000,
  maxPixels: 1e10,
  bestEffort: true
}));

print('═══ 檢查 3：都市熱島（最重要）═══');
print('合格標準：西部各大城市都要明顯比中央山脈熱，差 8 度以上。');
print('  如果山區反而比市區熱，資料是壞的，不要匯出。');
var PROBES = ee.FeatureCollection([
  ee.Feature(ee.Geometry.Point([121.5137, 25.0488]), {name: '台北車站'}),
  ee.Feature(ee.Geometry.Point([120.6667, 24.1477]), {name: '台中'}),
  ee.Feature(ee.Geometry.Point([120.2000, 22.9999]), {name: '台南'}),
  ee.Feature(ee.Geometry.Point([120.3014, 22.6273]), {name: '高雄'}),
  ee.Feature(ee.Geometry.Point([121.6044, 23.9769]), {name: '花蓮'}),
  ee.Feature(ee.Geometry.Point([120.9570, 23.4700]), {name: '玉山（應最涼）'}),
  ee.Feature(ee.Geometry.Point([121.2800, 24.1500]), {name: '合歡山（應最涼）'})
]);
print('各點溫度', lst.reduceRegions({
  collection: PROBES,
  reducer: ee.Reducer.mean(),
  scale: 1000
}));

print('═══ 檢查 4：網格點數 ═══');
print('合格標準：SCALE=1000 約 30,000–40,000 點。');
var grid = lst.sample({
  region: taiwan,
  scale: SCALE,
  geometries: true,
  tileScale: 8   // 全台範圍必須調高，否則會 Computation timed out
});
print('網格點數', grid.size());
print('前 3 筆', grid.limit(3));


/* ══════════════════════════════════════════════════════════════════
   四項都合格才匯出。Tasks 分頁按 RUN，跑完從雲端硬碟下載。
   ══════════════════════════════════════════════════════════════════ */

Export.table.toDrive({
  collection: grid,
  description: EXPORT_NAME,
  fileFormat: 'GeoJSON'
});
