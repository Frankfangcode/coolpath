#!/usr/bin/env node
/**
 * 本機開發伺服器 —— 不需要 firebase-tools，不需要任何 API key。
 *
 *   node tools/dev_server.js            → http://localhost:5000
 *   node tools/dev_server.js --port 8080
 *
 * 它做兩件事：
 *   1. 靜態服務 public/
 *   2. 把 /api/* 導到 functions/index.js 裡真正的 handler
 *      （等同 firebase.json 的 rewrites，所以前端的相對路徑照樣同源、沒有 CORS）
 *
 * 關於缺少 key 的降級行為：
 *
 *   GOOGLE_MAPS_API_KEY 沒設 → 只有「呼叫 Routes API 取得路線」這一步換成本機假路線，
 *                              評分流程（解碼 / 每 50m 取樣 / 查 LST 網格 / 標 label /
 *                              產 mapsUrl / 排序）全部是真的程式碼跑真的資料。
 *                              回應的 meta.routingSource 會標成 STUBBED_LOCAL_DEV。
 *                              key 設了就自動改打真的 Routes API，這個檔案不必改。
 *
 *   CWA / MOENV 沒設         → assessRisk 走降級路徑，meta.usedDefaults 會標明。
 *   ADC 沒設                 → decide 走規則式 fallback，meta.source 會標明。
 *
 * ⚠️ 只供本機開發。假路線不是真實道路，不可用於任何對外展示或評分。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

// 預設不用 5000：macOS 的 AirPlay 接收器（ControlCenter）預設就佔著它，
// 而且 5000 也是 firebase emulators 的 hosting 預設埠，避開比較省事。
const DEFAULT_PORT = 5050;
const portArg = process.argv.indexOf('--port');
const EXPLICIT_PORT = portArg !== -1;
const PORT = EXPLICIT_PORT ? Number(process.argv[portArg + 1]) : DEFAULT_PORT;

let activePort = PORT;

// firebase-admin 需要知道專案，本機隨便給一個即可（不會真的連上 Firestore）
process.env.COOLPATH_LOCAL_DEV = '1';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'coolpath-local';
process.env.FIREBASE_CONFIG =
  process.env.FIREBASE_CONFIG || JSON.stringify({ projectId: process.env.GCLOUD_PROJECT });

// 載入 functions/.env（如果有的話）
const envPath = path.join(ROOT, 'functions', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m && m[2]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  console.log(`已載入 functions/.env`);
}

/* ────────────────── 沒有 Routes API key 時的假路線 ────────────────── */

const HAS_ROUTES_KEY = !!process.env.GOOGLE_MAPS_API_KEY;

// 兩條大致沿著真實路廊的折線（政大 → 台北車站）。
// 不是真實道路幾何，只是為了讓評分流程有東西可以算。
const STUB_CORRIDORS = [
  {
    // 辛亥路 / 和平東路，直接穿過市區：較短、較快、較熱
    name: 'city',
    speedMps: 6.5, // 約 23 km/h，市區有號誌
    points: [
      [24.9874, 121.5759], [24.9905, 121.5700], [24.9930, 121.5620], [25.0000, 121.5560],
      [25.0100, 121.5480], [25.0200, 121.5400], [25.0270, 121.5350], [25.0330, 121.5300],
      [25.0400, 121.5230], [25.0450, 121.5180], [25.0488, 121.5137],
    ],
  },
  {
    // 貼著南側丘陵繞行：較長、較慢、較涼
    name: 'hillside',
    speedMps: 6.9, // 約 25 km/h，路寬但繞遠
    points: [
      [24.9874, 121.5759], [24.9820, 121.5680], [24.9800, 121.5580], [24.9830, 121.5470],
      [24.9900, 121.5380], [25.0000, 121.5300], [25.0120, 121.5230], [25.0250, 121.5170],
      [25.0370, 121.5140], [25.0488, 121.5137],
    ],
  },
];

const haversineM = (a, b) => {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
};

/** 把稀疏的路廊點加密成類似真實 polyline 的密度，並平移到實際起訖點 */
function densify(corridor, origin, destination) {
  const src = corridor[0];
  const dst = corridor[corridor.length - 1];
  const spanLat = dst[0] - src[0];
  const spanLng = dst[1] - src[1];
  const needLat = destination.lat - origin.lat;
  const needLng = destination.lng - origin.lng;
  const kLat = spanLat === 0 ? 1 : needLat / spanLat;
  const kLng = spanLng === 0 ? 1 : needLng / spanLng;

  // 依起訖點做線性伸縮，讓任意起訖都能得到一條形狀合理的路線
  const moved = corridor.map(([lat, lng]) => [
    origin.lat + (lat - src[0]) * kLat,
    origin.lng + (lng - src[1]) * kLng,
  ]);

  const out = [];
  for (let i = 1; i < moved.length; i++) {
    const a = moved[i - 1];
    const b = moved[i];
    const steps = Math.max(1, Math.round(haversineM(a, b) / 80));
    for (let s = 0; s < steps; s++) {
      const f = s / steps;
      out.push({ lat: a[0] + (b[0] - a[0]) * f, lng: a[1] + (b[1] - a[1]) * f });
    }
  }
  out.push({ lat: moved[moved.length - 1][0], lng: moved[moved.length - 1][1] });
  return out;
}

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

function pathLen(points) {
  let t = 0;
  for (let i = 1; i < points.length; i++) {
    t += haversineM([points[i - 1].lat, points[i - 1].lng], [points[i].lat, points[i].lng]);
  }
  return t;
}

/** 只攔截 Routes API，其他 fetch（氣象、UVI、Gemini）照常放行 */
if (!HAS_ROUTES_KEY) {
  process.env.GOOGLE_MAPS_API_KEY = 'local-dev-stub';
  const realFetch = global.fetch;

  global.fetch = async (url, options) => {
    if (!String(url).includes('routes.googleapis.com')) return realFetch(url, options);

    const sent = JSON.parse(options.body);
    // 地址字串在無 key 模式沒辦法地理編碼，退回示範起訖點（政大 → 台北車站）
    const toLL = (wp, fallback) =>
      wp && wp.location
        ? { lat: wp.location.latLng.latitude, lng: wp.location.latLng.longitude }
        : fallback;
    const origin = toLL(sent.origin, { lat: 24.9874, lng: 121.5759 });
    const destination = toLL(sent.destination, { lat: 25.0488, lng: 121.5137 });

    const routes = STUB_CORRIDORS.map((corridor) => {
      const pts = densify(corridor.points, origin, destination);
      const meters = Math.round(pathLen(pts));
      return {
        polyline: { encodedPolyline: encodePolyline(pts) },
        duration: `${Math.round(meters / corridor.speedMps)}s`,
        distanceMeters: meters,
      };
    });

    return {
      ok: true,
      status: 200,
      json: async () => ({ routes }),
      text: async () => '',
    };
  };
}

/* ────────────────── 載入真正的 function handlers ────────────────── */

const functions = require(path.join(ROOT, 'functions', 'index.js'));
const lst = require(path.join(ROOT, 'functions', 'lst.js'));

const API = {
  '/api/coolRoute': functions.coolRoute,
  '/api/assessRisk': functions.assessRisk,
  '/api/decide': functions.decide,
  '/api/notify': functions.notify,
};

/* ────────────────── express 風格的 req / res 墊片 ────────────────── */

function shimResponse(res) {
  res.set = (k, v) => {
    res.setHeader(k, v);
    return res;
  };
  res.status = (c) => {
    res.statusCode = c;
    return res;
  };
  res.type = (t) => {
    res.setHeader('Content-Type', t);
    return res;
  };
  res.send = (body) => {
    res.end(body);
    return res;
  };
  return res;
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(raw);
      }
    });
  });
}

/* ────────────────── 靜態檔 ────────────────── */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.geojson': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(pathname, res) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));

  if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.end('404');
  }

  res.setHeader('Content-Type', MIME[path.extname(filePath)] || 'application/octet-stream');
  // Service Worker 與 config 不快取，改了要立刻生效
  res.setHeader('Cache-Control', 'no-store');

  // 本機開發時沿用 functions/.env 的 Google key，避免把 key 寫進公開的 config.js。
  // Maps JavaScript API key 本來就會送到瀏覽器；正式部署仍應使用 HTTP referrer 限制。
  if (pathname === '/config.js' && process.env.GOOGLE_MAPS_API_KEY) {
    const source = fs.readFileSync(filePath, 'utf8').replace(
      'REPLACE_WITH_MAPS_JS_API_KEY',
      process.env.GOOGLE_MAPS_API_KEY.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    );
    return res.end(source);
  }

  fs.createReadStream(filePath).pipe(res);
}

/* ────────────────── 伺服器 ────────────────── */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${activePort}`);
  const handler = API[url.pathname];

  if (!handler) return serveStatic(url.pathname, res);

  req.query = Object.fromEntries(url.searchParams);
  req.body = req.method === 'POST' ? await readBody(req) : undefined;
  shimResponse(res);

  const started = Date.now();
  res.on('finish', () => {
    console.log(`  ${req.method} ${url.pathname} → ${res.statusCode} (${Date.now() - started}ms)`);
  });

  try {
    handler(req, res);
  } catch (err) {
    console.error(err);
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: String(err.message || err) }));
  }
});

function banner(port) {
  const conf = fs.readFileSync(path.join(PUBLIC_DIR, 'config.js'), 'utf8');
  const hasMapsKey =
    !conf.includes('REPLACE_WITH_MAPS_JS_API_KEY') || Boolean(process.env.GOOGLE_MAPS_API_KEY);

  console.log(`\n涼路 CoolPath 本機開發伺服器`);
  console.log(`  http://localhost:${port}\n`);

  console.log(`目前狀態`);
  console.log(`  LST 網格　　 ${lst.source()}${lst.source() === 'PLACEHOLDER_SYNTHETIC' ? '　← 合成佔位資料' : ''}`);
  console.log(`  路線來源　　 ${HAS_ROUTES_KEY ? '真實 Routes API' : '本機假路線　← 沒有 GOOGLE_MAPS_API_KEY'}`);
  console.log(`  地圖圖磚　　 ${hasMapsKey ? '已提供 key（仍需啟用 Maps JavaScript API）' : '不會顯示　← 尚未設定 Google Maps key'}`);
  console.log(`  氣象 / UVI 　${process.env.CWA_API_KEY ? '真實資料' : '降級為預設值'}`);
  console.log(`  Gemini　　　 ${process.env.GEMINI_API_KEY ? 'AI Studio' : 'Vertex（需要 ADC，失敗會用規則式 fallback）'}`);

  console.log(`\n試試看`);
  console.log(`  http://localhost:${port}/api/coolRoute?origin=24.9874,121.5759&destination=25.0488,121.5137`);
  console.log(`  http://localhost:${port}/api/assessRisk?lat=25.0488&lng=121.5137`);
  console.log(`\n  Ctrl+C 結束\n`);
}

/**
 * 連接埠被占用時不要吐 stack trace。
 * 沒指定 --port 就自動往後找，指定了就尊重使用者的選擇、只給出處理方式。
 */
// 只註冊一次，並且讀 activePort。
// 不能用 server.listen(port, cb) 的 callback 形式：綁定失敗時那個 cb 會留在
// 'listening' 監聽器上，等下一次綁定成功時一起觸發，於是印出兩次橫幅、
// 而且第一次印的是失敗的那個埠。
server.on('listening', () => banner(activePort));

function start(port, attemptsLeft) {
  server.once('error', (err) => {
    if (err.code !== 'EADDRINUSE') throw err;

    const isAirplay = port === 5000;
    const hint = isAirplay ? '（macOS 的 AirPlay 接收器預設就占著 5000）' : '';

    if (EXPLICIT_PORT || attemptsLeft === 0) {
      console.error(`\n連接埠 ${port} 已被占用${hint}`);
      console.error(`  換一個：      node tools/dev_server.js --port ${port + 1}`);
      console.error(`  查誰占用了：  lsof -nP -iTCP:${port} -sTCP:LISTEN`);
      if (isAirplay) {
        console.error(`  或關掉 AirPlay：系統設定 → 一般 → AirDrop 與接力 → AirPlay 接收器\n`);
      } else {
        console.error('');
      }
      process.exit(1);
    }

    console.log(`連接埠 ${port} 已被占用${hint}，改用 ${port + 1}`);
    start(port + 1, attemptsLeft - 1);
  });

  activePort = port;
  server.listen(port);
}

start(PORT, 10);
