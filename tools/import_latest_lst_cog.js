#!/usr/bin/env node
/**
 * 將 Earth Engine 匯出的「最新可用 Landsat LST」COG 轉成現有網站可讀的
 * 雙解析度 GeoJSON：大台北保留約 100m，其餘台灣約 1km。
 *
 *   node tools/import_latest_lst_cog.js ~/Downloads/taiwan_latest_landsat_lst.tif
 *   node tools/import_latest_lst_cog.js ~/Downloads/taiwan_latest_landsat_lst.tif --install
 *
 * 輸入必須有兩個 band：1=LST（攝氏）、2=age_days。--install 會同步寫入
 * public/data 與 functions/data，避免前後端使用不同版本。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'public', 'data', 'taipei_lst_grid.geojson'),
  path.join(ROOT, 'functions', 'data', 'taipei_lst_grid.geojson'),
];
const DETAIL_BBOX = { west: 121.45, south: 24.95, east: 121.67, north: 25.21 };
const COARSE_METERS = 1000;
const CHUNK_ROWS = 256;

const args = process.argv.slice(2);
const install = args.includes('--install');
const inputPath = args.find((arg) => !arg.startsWith('--'));

if (!inputPath) {
  console.error(
    '用法：node tools/import_latest_lst_cog.js <taiwan_latest_landsat_lst.tif> [--install]'
  );
  process.exit(1);
}

if (!fs.existsSync(inputPath)) {
  console.error(`找不到檔案：${inputPath}`);
  process.exit(1);
}

const round = (value, digits) => {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};

function percentile(sorted, fraction) {
  return sorted[Math.floor((sorted.length - 1) * fraction)];
}

async function main() {
  const { fromFile } = await import('geotiff');
  const tiff = await fromFile(inputPath);
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  const samples = image.getSamplesPerPixel();
  const [originLng, originLat] = image.getOrigin();
  const [resLng, resLat] = image.getResolution();
  const noData = Number(image.getGDALNoData());

  if (samples < 2) {
    throw new Error(`GeoTIFF 只有 ${samples} 個 band；預期 Band 1=LST、Band 2=age_days`);
  }
  if (!(resLng > 0 && resLat < 0)) {
    throw new Error(`不支援的 raster 方向：resolution = [${resLng}, ${resLat}]`);
  }

  const metersPerPixel = Math.abs(resLat) * 111320;
  const coarseStride = Math.max(1, Math.round(COARSE_METERS / metersPerPixel));
  const features = [];
  const temps = [];
  const ages = [];
  let detailPoints = 0;
  let coarsePoints = 0;
  let invalidAge = 0;

  console.log(`\n讀取 ${inputPath}`);
  console.log(
    `  ${width} × ${height} pixels，約 ${metersPerPixel.toFixed(0)}m，` +
      `${samples} bands，NoData ${Number.isFinite(noData) ? noData : '未設定'}`
  );
  console.log(`  大台北每 1 pixel；其他區域每 ${coarseStride} pixels（約 1km）\n`);

  for (let rowStart = 0; rowStart < height; rowStart += CHUNK_ROWS) {
    const rowEnd = Math.min(height, rowStart + CHUNK_ROWS);
    const rasters = await image.readRasters({
      window: [0, rowStart, width, rowEnd],
      samples: [0, 1],
      interleave: false,
    });
    const lstBand = rasters[0];
    const ageBand = rasters[1];

    for (let localRow = 0; localRow < rowEnd - rowStart; localRow++) {
      const row = rowStart + localRow;
      const lat = originLat + (row + 0.5) * resLat;
      const coarseRow = row % coarseStride === 0;

      for (let col = 0; col < width; col++) {
        const lng = originLng + (col + 0.5) * resLng;
        const inDetail =
          lng >= DETAIL_BBOX.west &&
          lng <= DETAIL_BBOX.east &&
          lat >= DETAIL_BBOX.south &&
          lat <= DETAIL_BBOX.north;

        if (!inDetail && (!coarseRow || col % coarseStride !== 0)) continue;

        const offset = localRow * width + col;
        const temp = Number(lstBand[offset]);
        const age = Number(ageBand[offset]);
        // 台灣最近 48 天白天地表溫度不應低於 0°C；極端負值通常是殘雲或反演異常。
        if (!Number.isFinite(temp) || temp === noData || temp < 0 || temp > 70) continue;
        if (!Number.isFinite(age) || age === noData || age < 0) {
          invalidAge++;
          continue;
        }

        features.push({
          type: 'Feature',
          geometry: {
            type: 'Point',
            coordinates: [round(lng, 5), round(lat, 5)],
          },
          properties: {
            LST: round(temp, 1),
            age_days: round(age, 1),
          },
        });
        temps.push(temp);
        ages.push(age);
        if (inDetail) detailPoints++;
        else coarsePoints++;
      }
    }

    const percent = Math.round((rowEnd / height) * 100);
    process.stdout.write(`\r  轉換進度 ${String(percent).padStart(3)}%`);
  }
  process.stdout.write('\n');

  if (features.length < 10000) {
    throw new Error(`只有 ${features.length} 個有效點，可能是 band 順序或 NoData 設定錯誤`);
  }

  const sortedTemps = [...temps].sort((a, b) => a - b);
  const sortedAges = [...ages].sort((a, b) => a - b);
  const maxAgeDays = Math.ceil(sortedAges[sortedAges.length - 1]);
  const geojson = {
    type: 'FeatureCollection',
    _source: 'LANDSAT_8_9_LATEST_AVAILABLE',
    _note:
      'Landsat 8/9 逐像元最新晴空觀測；不是即時資料。' +
      '大台北約 100m、其他區域約 1km。',
    _detailBbox: DETAIL_BBOX,
    _generatedAt: new Date().toISOString(),
    _rasterFile: path.basename(inputPath),
    _minAgeDays: Math.floor(sortedAges[0]),
    _maxAgeDays: maxAgeDays,
    columns: { LST: 'Float', age_days: 'Float' },
    features,
  };

  const json = JSON.stringify(geojson);
  console.log(`\n結果`);
  console.log(`  ${features.length} 點（大台北 ${detailPoints}、全台粗網格 ${coarsePoints}）`);
  console.log(
    `  LST ${sortedTemps[0].toFixed(1)}–${sortedTemps[sortedTemps.length - 1].toFixed(1)}°C，` +
      `p5 ${percentile(sortedTemps, 0.05).toFixed(1)}、` +
      `p50 ${percentile(sortedTemps, 0.5).toFixed(1)}、` +
      `p95 ${percentile(sortedTemps, 0.95).toFixed(1)}`
  );
  console.log(
    `  age_days ${sortedAges[0].toFixed(1)}–${sortedAges[sortedAges.length - 1].toFixed(1)} 天`
  );
  if (invalidAge) console.log(`  略過 ${invalidAge} 個 age_days 無效的像元`);
  console.log(`  GeoJSON ${(Buffer.byteLength(json) / 1048576).toFixed(1)} MB`);

  if (install) {
    for (const target of TARGETS) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, json);
      console.log(`  已安裝 → ${path.relative(ROOT, target)}`);
    }
  } else {
    const outputPath = path.join(ROOT, 'latest_lst_grid.geojson');
    fs.writeFileSync(outputPath, json);
    console.log(`  已寫入 → ${path.relative(process.cwd(), outputPath)}`);
    console.log('  確認結果後加 --install，同步安裝到前後端。');
  }
}

main().catch((err) => {
  console.error(`\n✗ 匯入失敗：${err.message}\n`);
  process.exitCode = 1;
});
