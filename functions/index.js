/**
 * 涼路 CoolPath — 熱暴露評估引擎
 *
 * 核心產品是 /api/coolRoute：輸入起點終點，回傳多條路線及其熱暴露分數。
 * 網站只是這支 API 的第一個客戶端，導航整段交給 Google Maps。
 *
 * 端點（經 hosting rewrites，前端一律用 /api/xxx 相對路徑，沒有 CORS 問題）：
 *   GET|POST /api/coolRoute?origin=24.9874,121.5759&destination=25.0488,121.5137&mode=driving
 *   GET|POST /api/assessRisk?lat=25.0488&lng=121.5137
 *   POST     /api/decide   { risk: RiskAssessment, routes: RouteOption[] }
 *   POST     /api/notify   { title, body } 或 { registerOnly: true, token }
 *
 * 計算邏輯都在這裡與 lst.js / geo.js / risk.js / agent.js，前端不做任何評分。
 */

const { onRequest } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');

const lst = require('./lst');
const geo = require('./geo');
const risk = require('./risk');
const agent = require('./agent');
const { sendJson, fetchWithTimeout, parseLatLng, readParams, round1 } = require('./http');

admin.initializeApp();
const db = admin.firestore();

// hosting rewrites 導到 v2 function 需要 us-central1
setGlobalOptions({ region: 'us-central1', maxInstances: 10, memory: '512MiB' });

const DEMO_USER = 'demo_user';
const SAMPLE_INTERVAL_M = 50; // 沿線每 50 公尺取樣一點
const WAYPOINT_COUNT = 5; // Google Maps URL waypoints 上限 9，路線偏掉就往上加
const LOCAL_DEV = process.env.COOLPATH_LOCAL_DEV === '1';

/* ══════════════════════════════════════════════════════════════════
   任務 D — coolRoute：熱暴露評分引擎（核心產品）
   ══════════════════════════════════════════════════════════════════ */

/**
 * Routes API 的 TWO_WHEELER 是真正的機車模式（台灣、印度、越南等地支援），
 * 不是 DRIVE 的近似。差別很大且不能省：
 *   - 機車不能上國道，TWO_WHEELER 會自動排除；用 DRIVE 會推薦違法路線
 *   - 時間與距離都不同，用 DRIVE 算出來的數字對不上 Google Maps 的機車導航
 */
const TRAVEL_MODE = {
  driving: 'DRIVE',
  drive: 'DRIVE',
  motorcycle: 'TWO_WHEELER',
  scooter: 'TWO_WHEELER',
  twowheeler: 'TWO_WHEELER',
  walking: 'WALK',
  walk: 'WALK',
  bicycling: 'BICYCLE',
  bike: 'BICYCLE',
};

/**
 * 起訖點輸入：優先解析 "lat,lng"；不是座標就整串當地址字串，
 * 交給 Routes API 地理編碼（regionCode 限定台灣），前端因此可以直接輸入地名。
 */
function toWaypoint(input) {
  const ll = parseLatLng(input);
  if (ll) return { location: { latLng: { latitude: ll.lat, longitude: ll.lng } } };
  const s = typeof input === 'string' ? input.trim() : '';
  return s ? { address: s } : null;
}

/**
 * 呼叫 Routes API computeRoutes 取得替代路線。
 * 注意：Routes API 不支援自訂多邊形迴避或自訂成本函數
 * （只有 avoidTolls / avoidHighways / avoidFerries / avoidIndoor），
 * 所以熱暴露評分一律由我們自己在下面算。
 */
async function computeRoutes(originWp, destinationWp, travelMode) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) throw new Error('GOOGLE_MAPS_API_KEY 未設定（functions/.env）');

  const body = {
    origin: originWp,
    destination: destinationWp,
    travelMode,
    regionCode: 'TW', // 地址字串的地理編碼偏向台灣

    computeAlternativeRoutes: true,
    polylineQuality: 'HIGH_QUALITY',
    languageCode: 'zh-TW',
    units: 'METRIC',
  };
  // routingPreference 只對 DRIVE / TWO_WHEELER 合法。
  // 用 TRAFFIC_AWARE 才會把即時路況算進去，卡片上的時間才對得上 Google Maps 顯示的時間
  // （代價是計費 SKU 較高、回應稍慢；要省錢改回 TRAFFIC_UNAWARE，但時間會偏樂觀）
  if (travelMode === 'DRIVE' || travelMode === 'TWO_WHEELER') {
    body.routingPreference = 'TRAFFIC_AWARE';
  }

  const data = await fetchWithTimeout('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask':
        'routes.polyline.encodedPolyline,routes.duration,routes.distanceMeters,routes.description',
    },
    body: JSON.stringify(body),
  });

  return Array.isArray(data.routes) ? data.routes : [];
}

/** "1234s" → 1234 */
function parseDuration(d) {
  if (typeof d === 'number') return Math.round(d);
  const m = /^(\d+(?:\.\d+)?)s$/.exec(String(d || ''));
  return m ? Math.round(Number(m[1])) : 0;
}

/**
 * 產生交棒用的 Google Maps 導航連結。
 * 中繼點取自我們算出來的那條 polyline，Google 才會重現同一條路。
 * ⚠️ 上台前務必人工點開實測；若 Google 走了別條路，把 WAYPOINT_COUNT 調高（上限 9）。
 */
function buildMapsUrl(points, mode) {
  const first = points[0];
  const last = points[points.length - 1];
  const fmt = (p) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;

  const waypoints = geo.pickWaypoints(points, WAYPOINT_COUNT).map(fmt).join('|');
  // two-wheeler 是 Google Maps URL 的機車模式（實測會轉成 data=!3e9），
  // 台灣有支援。交棒過去才會沿用機車路網，時間也才跟我們算的一致。
  const travelmode =
    mode === 'WALK'
      ? 'walking'
      : mode === 'BICYCLE'
        ? 'bicycling'
        : mode === 'TWO_WHEELER'
          ? 'two-wheeler'
          : 'driving';

  const params = new URLSearchParams({
    api: '1',
    origin: fmt(first),
    destination: fmt(last),
    travelmode,
  });
  if (waypoints) params.set('waypoints', waypoints);

  // URLSearchParams 會把 | 編成 %7C，Google Maps 兩種都吃，保留原樣比較好讀
  return `https://www.google.com/maps/dir/?${params.toString().replace(/%7C/g, '|')}`;
}

/**
 * 單條路線評分：解碼 polyline → 每 50 公尺取樣 → 查 LST 網格 → 求平均與最大值。
 * label 由呼叫端統一指派。
 */
function scoreRoute(route, travelMode) {
  const encoded = route?.polyline?.encodedPolyline || '';
  const points = geo.decodePolyline(encoded);
  if (points.length < 2) return null;

  const samples = geo.resample(points, SAMPLE_INTERVAL_M);
  const heat = lst.summarize(samples);

  return {
    polyline: encoded,
    durationSec: parseDuration(route.duration),
    distanceM: Math.round(route.distanceMeters || geo.pathLengthM(points)),
    heatScore: heat.avg, // 沿線平均地表溫度 °C
    maxSurfaceTemp: heat.max,
    avgObservationAgeDays: heat.avgAgeDays,
    maxObservationAgeDays: heat.maxAgeDays,
    samplePoints: heat.samplePoints, // 取樣點數，展示可信度用
    label: null,
    mapsUrl: buildMapsUrl(points, travelMode),
    // 以下為輔助欄位，資料契約要求的必填欄位都在上面
    start: points[0], // 實際起訖點（地址輸入時即地理編碼結果），前端拿來更新風險評估位置
    end: points[points.length - 1],
    minSurfaceTemp: heat.min,
    coveredPoints: heat.coveredPoints, // 有查到 LST 的取樣點數
    coverageRatio: heat.samplePoints
      ? Math.round((heat.coveredPoints / heat.samplePoints) * 100) / 100
      : 0,
  };
}

exports.coolRoute = onRequest({ cors: true }, async (req, res) => {
  const started = Date.now();
  try {
    const p = readParams(req);
    const originWp = toWaypoint(p.origin);
    const destinationWp = toWaypoint(p.destination);
    const modeRaw = String(p.mode || 'driving').toLowerCase();
    const travelMode = TRAVEL_MODE[modeRaw] || 'DRIVE';

    if (!originWp || !destinationWp) {
      return sendJson(res, 400, {
        ok: false,
        error: 'origin 與 destination 為必填，可填 lat,lng 座標或地名/地址',
        example: '/api/coolRoute?origin=國立政治大學&destination=25.0488,121.5137&mode=driving',
      });
    }

    const raw = await computeRoutes(originWp, destinationWp, travelMode);
    if (raw.length === 0) {
      return sendJson(res, 502, {
        ok: false,
        error: 'Routes API 沒有回傳任何路線（地名輸入時請確認拼字，或改用 lat,lng）',
        query: { origin: p.origin, destination: p.destination, mode: modeRaw },
      });
    }

    const routes = raw.map((r) => scoreRoute(r, travelMode)).filter(Boolean);
    if (routes.length === 0) {
      return sendJson(res, 502, { ok: false, error: 'polyline 解碼失敗，無法評分' });
    }

    // 指派 label：heatScore 最低者 coolest，durationSec 最短者 fastest（可為同一條）
    const scored = routes.filter((r) => r.heatScore !== null);
    const coolest = scored.length
      ? scored.reduce((a, b) => (b.heatScore < a.heatScore ? b : a))
      : routes[0];
    const fastest = routes.reduce((a, b) => (b.durationSec < a.durationSec ? b : a));

    for (const r of routes) r.label = 'alternative';
    fastest.label = 'fastest';
    coolest.label = 'coolest'; // 同一條時 coolest 蓋過 fastest，靠 meta.sameRouteIsBoth 告知前端

    // 依 heatScore 排序回傳（查無 LST 的排最後）
    routes.sort((a, b) => {
      if (a.heatScore === null) return 1;
      if (b.heatScore === null) return -1;
      return a.heatScore - b.heatScore;
    });

    const sameRoute = coolest === fastest;
    const extraSec = sameRoute ? 0 : coolest.durationSec - fastest.durationSec;
    const extraMin = Math.round(extraSec / 60);
    const tempDelta = sameRoute ? 0 : round1(fastest.heatScore - coolest.heatScore);

    const comparison = sameRoute
      ? null
      : {
          extraSeconds: extraSec,
          extraMinutes: extraMin,
          tempDelta,
          summary: `最涼路線多花 ${extraMin} 分鐘，沿線平均地表溫度低 ${tempDelta} 度`,
        };

    const lstInfo = lst.datasetInfo();
    return sendJson(res, 200, {
      ok: true,
      query: {
        origin: p.origin,
        destination: p.destination,
        mode: modeRaw,
        travelMode,
        // 地址輸入時前端拿不到座標，用最快路線的實際起訖點回填（風險評估要用）
        resolved: { origin: fastest.start, destination: fastest.end },
      },
      meta: {
        lstSource: lstInfo.source,
        lstLabel: lstInfo.label,
        lstDisclaimer: lstInfo.disclaimer,
        sampleIntervalM: SAMPLE_INTERVAL_M,
        routeCount: routes.length,
        sameRouteIsBoth: sameRoute,
        computeMs: Date.now() - started,
      },
      comparison,
      routes,
    });
  } catch (err) {
    console.error('[coolRoute]', err);
    return sendJson(res, 500, {
      ok: false,
      error: String(err.message || err),
      hint: '檢查 functions/.env 的 GOOGLE_MAPS_API_KEY，以及 Google Cloud 是否已啟用 Routes API',
    });
  }
});

/* ══════════════════════════════════════════════════════════════════
   任務 B — assessRisk：環境風險計算
   ══════════════════════════════════════════════════════════════════ */

exports.assessRisk = onRequest({ cors: true }, async (req, res) => {
  const p = readParams(req);
  // 預設用示範路線終點（台北車站）
  const lat = Number(p.lat ?? 25.0488);
  const lng = Number(p.lng ?? 121.5137);
  const maxSurfaceTemp = p.maxSurfaceTemp !== undefined ? Number(p.maxSurfaceTemp) : undefined;

  const surfaceObservation = lst.lookupSurfaceObservation(lat, lng);
  const surfaceTemp = surfaceObservation?.temp ?? null;
  const surfaceTempAgeDays = surfaceObservation?.ageDays ?? null;
  const degraded = [];

  // 三支外部 API 各自獨立降級，一支掛掉不影響另一支
  const [weatherR, uviR, feelsR] = await Promise.allSettled([
    risk.fetchWeather(lat, lng),
    risk.fetchUvi(lat, lng),
    risk.fetchFeelsLike(lat, lng),
  ]);
  let weather = weatherR.status === 'fulfilled' ? weatherR.value : null;
  let uviData = uviR.status === 'fulfilled' ? uviR.value : null;
  const forecastFeels = feelsR.status === 'fulfilled' ? feelsR.value : null;

  if (!weather) {
    console.error('[assessRisk] 氣象取得失敗：', weatherR.reason?.message);
    degraded.push('weather');
  }
  if (!uviData) {
    console.error('[assessRisk] UVI 取得失敗：', uviR.reason?.message);
    degraded.push('uvi');
  }
  if (!forecastFeels) {
    console.error('[assessRisk] 體感預報取得失敗：', feelsR.reason?.message);
    degraded.push('feelsLike');
  }

  // 失敗時讀 Firestore cache/weather 最後一筆，dataTime 必須反映實際資料時間
  let cached = null;
  // 輕量本機伺服器沒有 Firestore ADC，直接走誠實標記的預設值，避免每次多等數秒。
  // Firebase emulator／正式 Cloud Functions 未設 COOLPATH_LOCAL_DEV，仍會正常使用快取。
  if (degraded.length && !LOCAL_DEV) {
    try {
      const snap = await db.collection('cache').doc('weather').get();
      if (snap.exists) cached = snap.data();
    } catch (err) {
      console.error('[assessRisk] 讀取快取失敗：', err.message);
    }
  }

  if (!weather && cached) {
    weather = {
      airTemp: cached.airTemp,
      humidity: cached.humidity,
      station: cached.station,
      stationDistM: cached.stationDistM,
      obsTime: cached.obsTime,
    };
  }
  if (!uviData && cached) {
    uviData = { uvi: cached.uvi, uviSite: cached.uviSite, uviTime: cached.uviTime };
  }

  // 連快取都沒有時的最後防線：夏季合理預設值，並誠實標記在 meta.usedDefaults
  const usedDefaults = [];
  if (!weather || !Number.isFinite(weather.airTemp)) {
    weather = { airTemp: 34.5, humidity: 72, station: null, stationDistM: null, obsTime: null };
    usedDefaults.push('weather');
  }
  if (!uviData || !Number.isFinite(uviData.uvi)) {
    uviData = { uvi: 8, uviSite: null, uviTime: null };
    usedDefaults.push('uvi');
  }

  // 體感溫度：優先用 CWA 縣市預報值（產品決策 2026-08-17），
  // 預報抓不到才退回由測站氣溫濕度計算的 NOAA Heat Index
  const feelsLike = forecastFeels
    ? forecastFeels.feelsLike
    : risk.heatIndexC(weather.airTemp, weather.humidity);
  const level = risk.classifyLevel(feelsLike, uviData.uvi, maxSurfaceTemp ?? surfaceTemp);

  // dataTime 取兩個來源中較舊者，代表整包資料的新鮮度
  const times = [weather.obsTime, uviData.uviTime]
    .filter(Boolean)
    .map((t) => new Date(t))
    .filter((d) => !Number.isNaN(d.getTime()));
  const dataTime = times.length
    ? new Date(Math.min(...times.map((d) => d.getTime()))).toISOString()
    : new Date().toISOString();

  const payload = {
    level,
    feelsLike,
    airTemp: weather.airTemp,
    humidity: weather.humidity,
    uvi: uviData.uvi,
    surfaceTemp: surfaceTemp === null ? null : round1(surfaceTemp),
    surfaceTempAgeDays,
    dataTime,
    meta: {
      lat,
      lng,
      station: weather.station,
      stationDistM: weather.stationDistM,
      feelsLikeSource: forecastFeels ? 'CWA_FORECAST' : 'NOAA_HEAT_INDEX',
      feelsLikeArea: forecastFeels ? forecastFeels.area : null, // 縣市名
      feelsLikeTime: forecastFeels ? forecastFeels.forecastTime : null,
      uviSite: uviData.uviSite,
      uviNote: '就近環境部測站即時值，單站代表一片區域，不隨路線位置變化，不參與路線評分',
      surfaceTempNote: lst.datasetInfo().surfaceTempNote,
      lstSource: lst.source(),
      degraded, // 這次抓失敗的來源
      usedCache: degraded.length > 0 && cached !== null,
      usedDefaults, // 連快取都沒有而改用預設值的來源
    },
  };

  // 成功時寫回快取，供之後失敗時使用（feelsLike 預報有自己的模組層快取，不看它）
  if (!degraded.includes('weather') && !degraded.includes('uvi') && !LOCAL_DEV) {
    db.collection('cache')
      .doc('weather')
      .set(
        {
          ...weather,
          ...uviData,
          feelsLike,
          dataTime,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      )
      .catch((err) => console.error('[assessRisk] 寫入快取失敗：', err.message));
  }

  return sendJson(res, 200, payload);
});

/* ══════════════════════════════════════════════════════════════════
   任務 C — decide：Gemini 判斷層
   ══════════════════════════════════════════════════════════════════ */

exports.decide = onRequest({ cors: true }, async (req, res) => {
  try {
    const p = readParams(req);
    const assessment = p.risk || p.assessment || null;
    const routes = Array.isArray(p.routes) ? p.routes : [];

    if (!assessment || typeof assessment.feelsLike !== 'number') {
      return sendJson(res, 400, {
        ok: false,
        error: 'body 需要 { risk: RiskAssessment, routes: RouteOption[] }',
      });
    }

    // 路線最高地表溫度也會影響等級，這裡用完整資訊重新判定一次
    const maxTemp = routes.reduce(
      (m, r) => (typeof r.maxSurfaceTemp === 'number' && r.maxSurfaceTemp > m ? r.maxSurfaceTemp : m),
      -Infinity
    );
    const effective = {
      ...assessment,
      level: risk.classifyLevel(
        assessment.feelsLike,
        assessment.uvi,
        Number.isFinite(maxTemp) ? maxTemp : undefined
      ),
    };

    let decision;
    try {
      decision = agent.normalizeDecision(await agent.callGemini(effective, routes), effective, routes);
    } catch (err) {
      console.error('[decide] Gemini 失敗，改用規則式決策：', err.message);
      decision = agent.fallbackDecision(effective, routes);
      decision.meta.error = String(err.message || err);
    }

    return sendJson(res, 200, decision);
  } catch (err) {
    console.error('[decide]', err);
    return sendJson(res, 500, { ok: false, error: String(err.message || err) });
  }
});

/* ══════════════════════════════════════════════════════════════════
   任務 E 支援 — notify：送 FCM 推播（Demo 高潮那一下）
   ══════════════════════════════════════════════════════════════════ */

exports.notify = onRequest({ cors: true }, async (req, res) => {
  try {
    const p = readParams(req);
    const uid = String(p.userId || DEMO_USER);

    // 前端拿到 FCM token 後先來註冊（A6 步驟三），寫進 users/demo_user 就好，不送推播
    if (p.registerOnly) {
      if (!p.token) return sendJson(res, 400, { ok: false, error: 'registerOnly 需要 token' });
      await db
        .collection('users')
        .doc(uid)
        .set(
          { fcmToken: String(p.token), updatedAt: admin.firestore.FieldValue.serverTimestamp() },
          { merge: true }
        );
      return sendJson(res, 200, { ok: true, registered: true, userId: uid });
    }

    let token = p.token;
    if (!token) {
      const snap = await db.collection('users').doc(uid).get();
      token = snap.exists ? snap.data().fcmToken : null;
    }
    if (!token) {
      return sendJson(res, 404, {
        ok: false,
        error: `users/${uid} 沒有 fcmToken，請先在網頁點「開始」授權推播`,
      });
    }

    const title = String(p.title || '涼路 CoolPath');
    const body = String(p.body || '前方路段偏熱，建議改走最涼路線');

    // payload 必須含 notification 區塊，只有 data 的話 Chrome 不會顯示橫幅；
    // 高優先級才能在使用者正在用 Google Maps 導航時蓋上去
    const messageId = await admin.messaging().send({
      token,
      notification: { title, body },
      data: { speech: String(p.speech || body), url: String(p.url || '/') },
      android: { priority: 'high' },
      webpush: { headers: { Urgency: 'high' }, fcmOptions: { link: '/' } },
    });

    return sendJson(res, 200, { ok: true, messageId, title, body });
  } catch (err) {
    console.error('[notify]', err);
    return sendJson(res, 500, { ok: false, error: String(err.message || err) });
  }
});
