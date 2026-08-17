/**
 * 台北地表溫度網格 — Earth Engine 前處理與匯出
 *
 * 於 https://code.earthengine.google.com 執行。
 * Earth Engine 沒有 API key，用 OAuth 登入，右上角選到已註冊的 Cloud project。
 *
 * ⚠️ 這個檔案是給 Earth Engine Code Editor 用的，不是 Node 程式，不要在本機跑。
 *
 * 匯出要跑十幾二十分鐘，所以下面在 Export 之前先把所有驗證印出來。
 * 先看 Console 的六項檢查，全部合格再去 Tasks 分頁按 RUN。
 */

var taipei = ee.Geometry.Rectangle([121.45, 24.95, 121.67, 25.21]);

function prep(img) {
  var lst = img.select('ST_B10')
    .multiply(0.00341802).add(149.0).subtract(273.15)   // Kelvin → 攝氏
    .rename('LST');
  var qa = img.select('QA_PIXEL');
  var mask = qa.bitwiseAnd(1 << 3).eq(0)                // 去雲
              .and(qa.bitwiseAnd(1 << 4).eq(0));        // 去雲影
  // 想更嚴格可以再加：.and(qa.bitwiseAnd(1 << 1).eq(0))  // 去 dilated cloud
  //                  .and(qa.bitwiseAnd(1 << 2).eq(0))  // 去 cirrus
  return lst.updateMask(mask);
}

var col = ee.ImageCollection('LANDSAT/LC08/C02/T1_L2')
  .merge(ee.ImageCollection('LANDSAT/LC09/C02/T1_L2'))
  .filterBounds(taipei)
  .filterDate('2023-06-01', '2026-09-30')
  .filter(ee.Filter.calendarRange(6, 9, 'month'))       // 僅夏季
  .filter(ee.Filter.lt('CLOUD_COVER', 30))
  .map(prep);

var lst = col.median().clip(taipei);

Map.centerObject(taipei, 11);
Map.addLayer(lst, {min: 26, max: 44,
  palette: ['#2c7bb6','#abd9e9','#ffffbf','#fdae61','#d7191c']}, 'LST');


/* ══════════════════════════════════════════════════════════════════
   匯出前的六項檢查 —— 全部看過再去按 RUN
   ══════════════════════════════════════════════════════════════════ */

print('═══ 檢查 1：影像數量 ═══');
print('合格標準：至少 20 幅。太少代表雲量門檻太嚴或日期範圍太窄。');
print('影像數', col.size());
print('拍攝日期', col.aggregate_array('DATE_ACQUIRED').sort());
print('雲量', col.aggregate_array('CLOUD_COVER'));

print('═══ 檢查 2：數值範圍 ═══');
print('合格標準：約 26–46°C。');
print('  出現 300 以上 → 忘了減 273.15');
print('  出現負值或整片空白 → 遮罩過頭，放寬雲量門檻或日期範圍');
print('統計', lst.reduceRegion({
  reducer: ee.Reducer.minMax()
    .combine(ee.Reducer.mean(), '', true)
    .combine(ee.Reducer.stdDev(), '', true)
    .combine(ee.Reducer.percentile([5, 50, 95]), '', true),
  geometry: taipei,
  scale: 100,
  maxPixels: 1e9,
  bestEffort: true
}));

print('═══ 檢查 3：資料覆蓋率 ═══');
print('合格標準：有效像元佔比 > 0.9。太低代表雲遮罩把資料吃掉太多。');
var validRatio = lst.mask().reduceRegion({
  reducer: ee.Reducer.mean(),
  geometry: taipei,
  scale: 100,
  maxPixels: 1e9,
  bestEffort: true
});
print('有效像元佔比', validRatio);
print('═══ 檢查 4：都市熱島是否成立（最重要的一項）═══');
print('合格標準：台北車站 / 信義 明顯高於 陽明山 / 木柵，差距應有 5 度以上。');
print('若市區反而比山區涼，代表資料有問題，不要匯出。');
var checkPoints = ee.FeatureCollection([
  ee.Feature(ee.Geometry.Point([121.5137, 25.0488]), {name: '台北車站（應該最熱）'}),
  ee.Feature(ee.Geometry.Point([121.5654, 25.0330]), {name: '信義區（應該很熱）'}),
  ee.Feature(ee.Geometry.Point([121.5436, 25.0330]), {name: '大安森林公園（應偏涼）'}),
  ee.Feature(ee.Geometry.Point([121.5759, 24.9874]), {name: '政治大學（應偏涼）'}),
  ee.Feature(ee.Geometry.Point([121.5450, 25.1650]), {name: '陽明山（應該最涼）'})
]);
print('各點 LST', lst.reduceRegions({
  collection: checkPoints,
  reducer: ee.Reducer.first().setOutputs(['LST']),
  scale: 100
}));

print('═══ 檢查 5：分布形狀 ═══');
print('合格標準：單峰、集中在 32–42 之間。雙峰或極端偏態代表混到不同季節或有殘雲。');
print(ui.Chart.image.histogram({image: lst, region: taipei, scale: 200, maxPixels: 1e9})
  .setOptions({title: '夏季平均地表溫度分布', hAxis: {title: '°C'}}));

print('═══ 檢查 6：網格點數 ═══');
print('合格標準：約 14,000–17,000 點。差太多代表 scale 設錯。');
var grid = lst.sample({region: taipei, scale: 200, geometries: true});
print('網格點數', grid.size());
print('前 3 筆（確認 properties 裡是 LST，geometry 是 Point）', grid.limit(3));


/* ══════════════════════════════════════════════════════════════════
   六項都合格才匯出。到 Tasks 分頁按 RUN，跑完從雲端硬碟下載。
   下載後在專案根目錄跑：
       node tools/verify_lst_grid.js ~/Downloads/taipei_lst_grid.geojson
   驗證通過它會幫你複製到 public/data/ 與 functions/data/。
   ══════════════════════════════════════════════════════════════════ */

Export.table.toDrive({
  collection: grid,
  description: 'taipei_lst_grid',
  fileFormat: 'GeoJSON'
});
