/**
 * 台灣本島「最新可用」Landsat 8/9 地表溫度（LST）
 *
 * 在 https://code.earthengine.google.com 執行，不是在 Node.js 執行。
 * Landsat 不是即時資料：Landsat 8/9 合併後名義重訪約 8 天，雲層與 Level-2
 * 處理仍會造成空窗。本腳本查看最近 48 天，逐像元選最新一筆無雲觀測，並輸出：
 *   - LST：攝氏地表溫度
 *   - age_days：該像元觀測距今天數
 *
 * 輸出採 Cloud Optimized GeoTIFF，而不是數百萬點 GeoJSON。
 * USDOS/LSIB_SIMPLE/2017 是簡化國界，適合台灣本島示範；若產品必須包含澎湖、
 * 金門、馬祖，請把 taiwan 變數換成你自己的完整行政界線 Earth Engine Asset。
 */

var taiwan = ee.FeatureCollection('USDOS/LSIB_SIMPLE/2017')
  .filter(ee.Filter.eq('country_na', 'Taiwan'))
  .geometry();

var now = ee.Date(Date.now());
var lookbackDays = 48;
var start = now.advance(-lookbackDays, 'day');

function prep(img) {
  var qa = img.select('QA_PIXEL');
  var clear = qa.bitwiseAnd(1 << 0).eq(0) // fill
    .and(qa.bitwiseAnd(1 << 1).eq(0))     // dilated cloud
    .and(qa.bitwiseAnd(1 << 2).eq(0))     // cirrus
    .and(qa.bitwiseAnd(1 << 3).eq(0))     // cloud
    .and(qa.bitwiseAnd(1 << 4).eq(0))     // cloud shadow
    .and(qa.bitwiseAnd(1 << 5).eq(0));    // snow

  var lst = img.select('ST_B10')
    .multiply(0.00341802)
    .add(149.0)
    .subtract(273.15)
    .rename('LST');

  var acquiredMs = ee.Image.constant(img.date().millis())
    .toDouble()
    .rename('acquired_ms');

  return lst.addBands(acquiredMs)
    .updateMask(clear)
    .copyProperties(img, ['system:time_start', 'DATE_ACQUIRED', 'SPACECRAFT_ID']);
}

var collection = ee.ImageCollection('LANDSAT/LC08/C02/T1_L2')
  .merge(ee.ImageCollection('LANDSAT/LC09/C02/T1_L2'))
  .filterBounds(taiwan)
  .filterDate(start, now.advance(1, 'day'))
  .filter(ee.Filter.eq('PROCESSING_LEVEL', 'L2SP'))
  .filter(ee.Filter.lt('CLOUD_COVER', 80))
  .map(prep);

// 每個像元用 acquired_ms 最大者，也就是最近一筆通過雲遮罩的觀測。
var latest = collection.qualityMosaic('acquired_ms').clip(taiwan);
var ageDays = ee.Image.constant(now.millis())
  .subtract(latest.select('acquired_ms'))
  .divide(1000 * 60 * 60 * 24)
  .rename('age_days');
var output = latest.select('LST').addBands(ageDays).toFloat();

Map.centerObject(taiwan, 7);
Map.addLayer(output.select('LST'), {
  min: 18,
  max: 48,
  palette: ['#2c7bb6', '#abd9e9', '#ffffbf', '#fdae61', '#d7191c']
}, '最新可用 LST（非即時）');
Map.addLayer(output.select('age_days'), {
  min: 0,
  max: lookbackDays,
  palette: ['#22c55e', '#fde047', '#ef4444']
}, '觀測年齡（天）', false);

print('查詢期間', start.format('YYYY-MM-dd'), '→', now.format('YYYY-MM-dd'));
print('通過篩選的場景數', collection.size());
print('場景日期', collection.aggregate_array('DATE_ACQUIRED').distinct().sort());
print('LST / 觀測年齡統計', output.reduceRegion({
  reducer: ee.Reducer.minMax()
    .combine(ee.Reducer.mean(), '', true)
    .combine(ee.Reducer.percentile([5, 50, 95]), '', true),
  geometry: taiwan,
  scale: 100,
  maxPixels: 1e9,
  bestEffort: true
}));

// 把 YOUR_BUCKET_NAME 換成自己的 Cloud Storage bucket。
// 建議排程每日執行；沒有新場景時，輸出內容不會突然變成「即時」。
Export.image.toCloudStorage({
  image: output.unmask(-9999),
  description: 'taiwan_latest_landsat_lst',
  bucket: 'YOUR_BUCKET_NAME',
  fileNamePrefix: 'coolpath/lst/taiwan_latest',
  region: taiwan,
  scale: 100,
  maxPixels: 1e10,
  fileFormat: 'GeoTIFF',
  formatOptions: {
    cloudOptimized: true,
    noData: -9999
  },
  skipEmptyTiles: true
});
