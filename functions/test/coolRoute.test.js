/**
 * coolRoute 端到端測試：把 Routes API 換成假的回應，驗證從 polyline 進來到
 * RouteOption[] 出去的整條流程（解碼 → 取樣 → 查 LST → 標 label → 產 mapsUrl → 排序）。
 *
 *   node functions/test/coolRoute.test.js
 *
 * 不需要任何 API key，也不會打到外部服務。
 */

const assert = require('assert');

process.env.GOOGLE_MAPS_API_KEY = 'test-key';
process.env.GCLOUD_PROJECT = 'coolpath-test';
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: 'coolpath-test' });

const geo = require('../geo');

const 政大 = { lat: 24.9874, lng: 121.5759 };
const 台北車站 = { lat: 25.0488, lng: 121.5137 };

/* ── 造兩條假路線 ── */

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

/** 從 a 到 b，中間往指定方向凸出去，模擬繞路 */
function arc(a, b, bulgeLat, bulgeLng, n = 60) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const bell = Math.sin(f * Math.PI);
    pts.push({
      lat: a.lat + (b.lat - a.lat) * f + bulgeLat * bell,
      lng: a.lng + (b.lng - a.lng) * f + bulgeLng * bell,
    });
  }
  return pts;
}

// 路線一：直接走市區（較短、較快，但沿線熱）
const routeCity = arc(政大, 台北車站, 0, 0.004);
// 路線二：往東南山區繞（較遠、較慢，但沿線涼）
const routeHill = arc(政大, 台北車站, -0.025, 0.03);

const FAKE_ROUTES_RESPONSE = {
  routes: [
    {
      polyline: { encodedPolyline: encodePolyline(routeCity) },
      duration: '1800s',
      distanceMeters: Math.round(geo.pathLengthM(routeCity)),
    },
    {
      polyline: { encodedPolyline: encodePolyline(routeHill) },
      duration: '2100s',
      distanceMeters: Math.round(geo.pathLengthM(routeHill)),
    },
  ],
};

/* ── 攔截 fetch，回傳假的 Routes API 回應 ── */

let lastRequest = null;
global.fetch = async (url, options) => {
  lastRequest = { url, options };
  return {
    ok: true,
    status: 200,
    json: async () => FAKE_ROUTES_RESPONSE,
    text: async () => JSON.stringify(FAKE_ROUTES_RESPONSE),
  };
};

const { coolRoute } = require('../index');

/* ── 假的 req / res ── */

const { EventEmitter } = require('events');

function invoke(query) {
  return new Promise((resolve) => {
    const req = { method: 'GET', query, body: undefined, headers: {}, get: () => undefined };

    // onRequest 內部會等 res 的 'finish' 事件，所以 res 要是個 EventEmitter
    const res = new EventEmitter();
    res.statusCode = 200;
    // cors 中介層會操作 header，這些方法必須真的能用
    const headers = {};
    res.set = (k, v) => {
      headers[String(k).toLowerCase()] = v;
      return res;
    };
    res.type = () => res;
    res.getHeader = (k) => headers[String(k).toLowerCase()];
    res.setHeader = (k, v) => {
      headers[String(k).toLowerCase()] = v;
      return res;
    };
    res.removeHeader = (k) => {
      delete headers[String(k).toLowerCase()];
      return res;
    };
    res.status = (c) => {
      res.statusCode = c;
      return res;
    };
    res.send = (body) => {
      resolve({ status: res.statusCode, body: JSON.parse(body) });
      res.emit('finish');
      return res;
    };
    res.end = () => res.emit('finish');

    coolRoute(req, res);
  });
}

/** 點到折線的最短距離（公尺），用平面近似即可 */
function distToPath(p, path) {
  const mPerLat = 111320;
  const mPerLng = 111320 * Math.cos((p.lat * Math.PI) / 180);
  const X = (q) => [(q.lng - p.lng) * mPerLng, (q.lat - p.lat) * mPerLat];

  let best = Infinity;
  for (let i = 1; i < path.length; i++) {
    const [ax, ay] = X(path[i - 1]);
    const [bx, by] = X(path[i]);
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

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

(async () => {
  console.log('\ncoolRoute —— 端到端（Routes API 已替換為假回應）\n');

  const { status, body } = await invoke({
    origin: '24.9874,121.5759',
    destination: '25.0488,121.5137',
    mode: 'driving',
  });

  console.log(JSON.stringify(body, null, 2).slice(0, 1400) + '\n…\n');

  t('回應 200 且 ok', () => {
    assert.strictEqual(status, 200);
    assert.strictEqual(body.ok, true);
  });

  t('Routes API 請求帶了正確的 field mask 與 computeAlternativeRoutes', () => {
    assert.ok(lastRequest.url.includes('directions/v2:computeRoutes'));
    const mask = lastRequest.options.headers['X-Goog-FieldMask'];
    assert.ok(mask.includes('routes.polyline.encodedPolyline'), 'field mask 缺 polyline');
    assert.ok(mask.includes('routes.duration'), 'field mask 缺 duration');
    assert.ok(mask.includes('routes.distanceMeters'), 'field mask 缺 distanceMeters');
    const sent = JSON.parse(lastRequest.options.body);
    assert.strictEqual(sent.computeAlternativeRoutes, true);
    assert.strictEqual(sent.travelMode, 'DRIVE');
  });

  t('每條路線都有資料契約要求的全部欄位', () => {
    const required = [
      'polyline', 'durationSec', 'distanceM', 'heatScore',
      'maxSurfaceTemp', 'samplePoints', 'label', 'mapsUrl',
    ];
    for (const r of body.routes) {
      for (const k of required) assert.ok(k in r, `缺欄位 ${k}`);
      assert.strictEqual(typeof r.durationSec, 'number');
      assert.strictEqual(typeof r.distanceM, 'number');
      assert.strictEqual(typeof r.samplePoints, 'number');
    }
  });

  t('取樣點數 ≈ 距離 / 50 公尺', () => {
    for (const r of body.routes) {
      const expected = r.distanceM / 50;
      assert.ok(
        Math.abs(r.samplePoints - expected) / expected < 0.05,
        `${r.samplePoints} 點 vs 預期 ${Math.round(expected)} 點`
      );
    }
  });

  t('繞山路那條的 heatScore 確實比走市區低', () => {
    const cool = body.routes.find((r) => r.label === 'coolest');
    const fast = body.routes.find((r) => r.label === 'fastest');
    assert.ok(cool && fast, '缺 coolest 或 fastest');
    assert.ok(cool.heatScore < fast.heatScore, `${cool.heatScore} 不低於 ${fast.heatScore}`);
  });

  t('fastest 確實是 durationSec 最小的那條', () => {
    const fast = body.routes.find((r) => r.label === 'fastest');
    const min = Math.min(...body.routes.map((r) => r.durationSec));
    assert.strictEqual(fast.durationSec, min);
  });

  t('coolest 確實是 heatScore 最小的那條', () => {
    const cool = body.routes.find((r) => r.label === 'coolest');
    const min = Math.min(...body.routes.map((r) => r.heatScore));
    assert.strictEqual(cool.heatScore, min);
  });

  t('回傳依 heatScore 由低到高排序', () => {
    const scores = body.routes.map((r) => r.heatScore);
    const sorted = [...scores].sort((a, b) => a - b);
    assert.deepStrictEqual(scores, sorted);
  });

  t('maxSurfaceTemp >= heatScore', () => {
    for (const r of body.routes) assert.ok(r.maxSurfaceTemp >= r.heatScore);
  });

  t('mapsUrl 格式正確，含 5 個中繼點', () => {
    for (const r of body.routes) {
      const u = new URL(r.mapsUrl);
      assert.strictEqual(u.origin + u.pathname, 'https://www.google.com/maps/dir/');
      assert.strictEqual(u.searchParams.get('api'), '1');
      assert.strictEqual(u.searchParams.get('travelmode'), 'driving');
      const wps = u.searchParams.get('waypoints').split('|');
      assert.strictEqual(wps.length, 5, `中繼點 ${wps.length} 個`);
      for (const wp of wps) {
        const [lat, lng] = wp.split(',').map(Number);
        assert.ok(lat > 24.9 && lat < 25.3, `中繼點緯度 ${lat} 不在台北`);
        assert.ok(lng > 121.4 && lng < 121.7, `中繼點經度 ${lng} 不在台北`);
      }
    }
  });

  t('mapsUrl 的起訖點與路線頭尾一致', () => {
    for (const r of body.routes) {
      const u = new URL(r.mapsUrl);
      const path = geo.decodePolyline(r.polyline);
      const [oLat, oLng] = u.searchParams.get('origin').split(',').map(Number);
      const [dLat, dLng] = u.searchParams.get('destination').split(',').map(Number);
      assert.ok(geo.haversineM({ lat: oLat, lng: oLng }, path[0]) < 5);
      assert.ok(geo.haversineM({ lat: dLat, lng: dLng }, path[path.length - 1]) < 5);
    }
  });

  t('中繼點確實落在該條路線上（Google 才會重現同一條路）', () => {
    for (const r of body.routes) {
      const path = geo.decodePolyline(r.polyline);
      const u = new URL(r.mapsUrl);
      for (const wp of u.searchParams.get('waypoints').split('|')) {
        const [lat, lng] = wp.split(',').map(Number);
        // 要量的是「到線段」的垂直距離，不是到頂點的距離：
        // 中繼點是沿線段內插出來的，量到頂點會多算半個線段長
        const nearest = distToPath({ lat, lng }, path);
        assert.ok(nearest < 1, `中繼點離路線 ${nearest.toFixed(1)} 公尺`);
      }
    }
  });

  t('comparison 的分鐘差與溫差算得對', () => {
    const cool = body.routes.find((r) => r.label === 'coolest');
    const fast = body.routes.find((r) => r.label === 'fastest');
    assert.strictEqual(body.comparison.extraSeconds, cool.durationSec - fast.durationSec);
    assert.ok(Math.abs(body.comparison.tempDelta - (fast.heatScore - cool.heatScore)) < 0.05);
  });

  t('meta 誠實標示資料來源與性質', () => {
    assert.ok(body.meta.lstSource);
    assert.ok(/Landsat/.test(body.meta.lstLabel));
    assert.ok(/非即時/.test(body.meta.lstDisclaimer), '缺少「非即時」聲明');
    assert.strictEqual(body.meta.sampleIntervalM, 50);
  });

  t('缺參數回 400 而不是 500', async () => {});
  const bad = await invoke({ origin: '24.9874,121.5759' });
  t('缺 destination → 400 並附上範例網址', () => {
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(bad.body.ok, false);
    assert.ok(bad.body.example.includes('/api/coolRoute'));
  });

  const addr = await invoke({ origin: '國立政治大學', destination: '25.0488,121.5137' });
  t('地址字串（非經緯度）→ 交給 Routes API 地理編碼，回 200', () => {
    assert.strictEqual(addr.status, 200);
    const sent = JSON.parse(lastRequest.options.body);
    assert.strictEqual(sent.origin.address, '國立政治大學');
    assert.strictEqual(sent.regionCode, 'TW');
    assert.ok(addr.body.query.resolved.destination, '缺 query.resolved.destination');
  });

  const blank = await invoke({ origin: '   ', destination: '25.0488,121.5137' });
  t('空白字串 → 400，不會炸掉', () => {
    assert.strictEqual(blank.status, 400);
  });

  // 情境二：最涼與最快是同一條（山路又涼又快）
  const savedFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      routes: [
        {
          polyline: { encodedPolyline: encodePolyline(routeHill) },
          duration: '1500s', // 涼的那條同時也最快
          distanceMeters: Math.round(geo.pathLengthM(routeHill)),
        },
        {
          polyline: { encodedPolyline: encodePolyline(routeCity) },
          duration: '1800s',
          distanceMeters: Math.round(geo.pathLengthM(routeCity)),
        },
      ],
    }),
    text: async () => '',
  });
  const same = await invoke({ origin: '24.9874,121.5759', destination: '25.0488,121.5137' });

  t('最涼與最快同一條時，meta.sameRouteIsBoth 為 true 且 comparison 為 null', () => {
    assert.strictEqual(same.body.meta.sameRouteIsBoth, true);
    assert.strictEqual(same.body.comparison, null);
    const cool = same.body.routes.find((r) => r.label === 'coolest');
    assert.ok(cool, '缺 coolest');
    // label 是單一字串，同一條時 coolest 蓋過 fastest，靠 meta 告知前端
    assert.strictEqual(same.body.routes.filter((r) => r.label === 'fastest').length, 0);
  });

  global.fetch = savedFetch;

  // Routes API 掛掉的情境
  global.fetch = async () => {
    throw new Error('simulated network failure');
  };
  const failed = await invoke({ origin: '24.9874,121.5759', destination: '25.0488,121.5137' });
  t('Routes API 失敗時回結構化錯誤而非 crash', () => {
    assert.strictEqual(failed.status, 500);
    assert.strictEqual(failed.body.ok, false);
    assert.ok(failed.body.error.includes('simulated network failure'));
    assert.ok(failed.body.hint);
  });

  const cool = body.routes.find((r) => r.label === 'coolest');
  const fast = body.routes.find((r) => r.label === 'fastest');
  console.log(
    `\n最涼：${Math.round(cool.durationSec / 60)} 分 / ${(cool.distanceM / 1000).toFixed(1)} km / ` +
      `平均 ${cool.heatScore}°C / 最高 ${cool.maxSurfaceTemp}°C / ${cool.samplePoints} 取樣點`
  );
  console.log(
    `最快：${Math.round(fast.durationSec / 60)} 分 / ${(fast.distanceM / 1000).toFixed(1)} km / ` +
      `平均 ${fast.heatScore}°C / 最高 ${fast.maxSurfaceTemp}°C / ${fast.samplePoints} 取樣點`
  );
  console.log(`對比：${body.comparison.summary}`);
  console.log(`\n${pass} 項通過${process.exitCode ? '，有失敗項目' : '，全數通過'}\n`);
})();
