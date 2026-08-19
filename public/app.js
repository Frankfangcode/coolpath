/**
 * 涼路 CoolPath — 前端（純 vanilla JS，無框架、無 build）
 *
 * 產品定位：這個網頁是 /api/coolRoute 的第一個客戶端。
 * 它只負責「決定走哪條」，導航整段交給 Google Maps。所有評分邏輯都在 Cloud Functions。
 */

'use strict';

const CFG = self.COOLPATH_CONFIG;
const DEMO_USER = 'demo_user';

// 熱區色階：26°C → 44°C 線性內插
const COLOR_STOPS = [
  { t: 26, c: [0x2c, 0x7b, 0xb6] },
  { t: 32, c: [0xab, 0xd9, 0xe9] },
  { t: 36, c: [0xff, 0xff, 0xbf] },
  { t: 40, c: [0xfd, 0xae, 0x61] },
  { t: 44, c: [0xd7, 0x19, 0x1c] },
];
const LATEST_COLOR_STOPS = [
  { t: 18, c: [0x2c, 0x7b, 0xb6] },
  { t: 30, c: [0xab, 0xd9, 0xe9] },
  { t: 40, c: [0xff, 0xff, 0xbf] },
  { t: 50, c: [0xfd, 0xae, 0x61] },
  { t: 60, c: [0xd7, 0x19, 0x1c] },
];

const MAX_CIRCLES = 2000; // 一次最多渲染 2000 點，超過依比例抽樣
const MIN_ROUTE_COVERAGE = 0.8;
const USE_MOCK = new URLSearchParams(location.search).has('mock');

// TA 是行人與機車騎士：機車預設，各模式的提示與時間用詞
const MODE_INFO = {
  scooter: { hint: '走機車路網、自動避開國道，時間含即時路況', timeWord: '騎乘' },
  walking: { hint: '步行速度慢、曝曬時間長，涼爽路線的差距最有感', timeWord: '步行' },
  driving: { hint: '車廂有遮蔽，熱暴露影響相對較低', timeWord: '行車' },
};

const state = {
  mode: 'scooter',
  map: null,
  grid: [], // [{lat, lng, t}]
  gridMeta: null,
  circles: [], // Circle 物件池，重複使用避免每次 idle 重建
  routeLines: [],
  routeMarkers: [],
  routes: [],
  risk: null,
  decision: null,
  speechUnlocked: false,
  voice: null,
  fcmToken: null,
};

const $ = (id) => document.getElementById(id);

/* ────────────────────────── 狀態訊息 ────────────────────────── */

function setStatus(msg, isError) {
  const el = $('status');
  if (!msg) {
    el.classList.add('hidden');
    return;
  }
  el.textContent = msg;
  el.classList.toggle('error', !!isError);
  el.classList.remove('hidden');
}

function updateDataQuality() {
  const notices = [];
  if (state.gridMeta?.placeholder) notices.push('溫度：全台合成示範資料，非 Landsat 觀測');
  else if (
    state.gridMeta?.source === 'LANDSAT_8_9_LATEST_AVAILABLE' &&
    Number.isFinite(state.gridMeta.maxAgeDays)
  ) {
    notices.push(`Landsat：最舊像元距今 ${state.gridMeta.maxAgeDays} 天`);
  }

  const meta = state.risk?.meta || {};
  const defaults = meta.usedDefaults || [];
  if (defaults.includes('weather')) notices.push('氣象：預設值');
  if (defaults.includes('uvi')) notices.push('UVI：環境部目前無資料，使用預設值 8');
  else if ((meta.degraded || []).includes('uvi') && meta.usedCache) notices.push('UVI：快取值');
  if ((meta.degraded || []).includes('feelsLike'))
    notices.push('體感：CWA 預報無資料，改由氣溫濕度計算');

  const el = $('dataQuality');
  el.textContent = notices.length ? `資料狀態｜${notices.join('｜')}` : '';
  el.classList.toggle('hidden', notices.length === 0);
}

/* ────────────────────────── A1 地圖與熱區圖層 ────────────────────────── */

function tempToColor(t) {
  const stops =
    state.gridMeta?.source === 'LANDSAT_8_9_LATEST_AVAILABLE'
      ? LATEST_COLOR_STOPS
      : COLOR_STOPS;
  if (t <= stops[0].t) return rgb(stops[0].c);
  if (t >= stops[stops.length - 1].t) return rgb(stops[stops.length - 1].c);

  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i].t) {
      const a = stops[i - 1];
      const b = stops[i];
      const f = (t - a.t) / (b.t - a.t);
      return rgb([0, 1, 2].map((k) => Math.round(a.c[k] + (b.c[k] - a.c[k]) * f)));
    }
  }
  return rgb(stops[stops.length - 1].c);
}

const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;

async function loadGrid() {
  try {
    const res = await fetch('data/taipei_lst_grid.geojson');
    const gj = await res.json();

    if (gj._placeholder === true) $('placeholderWarning').classList.remove('hidden');

    state.grid = (gj.features || [])
      .map((f) => {
        const g = f.geometry;
        if (!g || g.type !== 'Point') return null;
        const [lng, lat] = g.coordinates; // GeoJSON 是 [lng, lat]
        const p = f.properties || {};
        const t = p.LST ?? p.lst ?? p.ST_B10 ?? p.mean;
        const ageDays = p.age_days ?? p.ageDays ?? null;
        return typeof t === 'number' ? { lat, lng, t, ageDays } : null;
      })
      .filter(Boolean);

    const lats = state.grid.map((p) => p.lat);
    const lngs = state.grid.map((p) => p.lng);
    state.gridMeta = {
      placeholder: gj._placeholder === true,
      source: gj._source || (gj._placeholder === true ? 'PLACEHOLDER_SYNTHETIC' : null),
      minAgeDays: Number.isFinite(Number(gj._minAgeDays)) ? Number(gj._minAgeDays) : null,
      maxAgeDays: Number.isFinite(Number(gj._maxAgeDays)) ? Number(gj._maxAgeDays) : null,
      detailBbox: gj._detailBbox || null, // 高解析區，圓點畫小顆
      bounds: state.grid.length
        ? {
            south: Math.min(...lats),
            north: Math.max(...lats),
            west: Math.min(...lngs),
            east: Math.max(...lngs),
          }
        : null,
    };

    const latest = state.gridMeta.source === 'LANDSAT_8_9_LATEST_AVAILABLE';
    $('legendTitle').textContent = state.gridMeta.placeholder
      ? '示範地表溫度（°C）'
      : latest
        ? '最新可用地表溫度（°C）'
        : 'Landsat 地表溫度（°C）';
    $('legendSource').textContent = state.gridMeta.placeholder
      ? '合成網格｜非 Landsat、非即時資料'
      : latest
        ? `Landsat 8/9｜像元距今 ${state.gridMeta.minAgeDays}–${state.gridMeta.maxAgeDays} 天`
        : 'Landsat 8/9 ST_B10｜衛星過境觀測，非即時資料';
    $('legendScope').textContent = state.gridMeta.placeholder
      ? '全台示範網格｜大台北高解析'
      : latest
        ? '全台約 1km｜大台北約 100m'
        : '';
    const tickValues = latest ? [18, 30, 45, 60] : [26, 32, 38, 44];
    document.querySelectorAll('.legend-ticks span').forEach((el, index) => {
      el.textContent = tickValues[index];
    });
    const sourceNote = $('lstSourceNote');
    if (sourceNote && latest) {
      sourceNote.textContent =
        `地表溫度：Landsat 逐像元最新晴空觀測；` +
        `本批像元距今 ${state.gridMeta.minAgeDays}–${state.gridMeta.maxAgeDays} 天，並非即時溫度。` +
        `地表溫度是太陽直射下路面、屋頂等表面的溫度，通常明顯高於氣溫。`;
    }
    updateDataQuality();

    console.log(`[heat] 載入 ${state.grid.length} 個網格點`);
    renderHeatLayer();
  } catch (err) {
    console.error('[heat] 熱區資料載入失敗', err);
  }
}

/**
 * 只渲染目前視野內的點，單次上限 2000，超過依比例抽樣。
 * 一次全畫 16000 個 Circle 會讓手機直接卡死。
 */
function renderHeatLayer() {
  if (!state.map || state.grid.length === 0) return;

  const bounds = state.map.getBounds();
  if (!bounds) return;

  const ne = bounds.getNorthEast();
  const sw = bounds.getSouthWest();
  const visible = [];
  for (const p of state.grid) {
    if (p.lat >= sw.lat() && p.lat <= ne.lat() && p.lng >= sw.lng() && p.lng <= ne.lng()) {
      visible.push(p);
    }
  }

  const step = Math.max(1, Math.ceil(visible.length / MAX_CIRCLES));
  const drawn = [];
  for (let i = 0; i < visible.length; i += step) drawn.push(visible[i]);

  // 高解析區（100/200m 網格）畫小顆，全台粗網格（約 1km）畫大顆才不會滿地空隙
  // 半徑隨網格間距與抽樣比例縮放：每畫 1 點代表 step 個點的面積，
  // 縮到全台視野時圓點放大成連續熱區面，放大到街區時縮回網格原尺度
  const db = state.gridMeta?.detailBbox;
  const inDetail = (p) =>
    db && p.lat >= db.south && p.lat <= db.north && p.lng >= db.west && p.lng <= db.east;
  const scale = Math.sqrt(step);
  const detailMeters = state.gridMeta?.source === 'LANDSAT_8_9_LATEST_AVAILABLE' ? 100 : 200;
  const radiusOf = (p) =>
    Math.min(4000, Math.max(75, 0.6 * (!db || inDetail(p) ? detailMeters : 1000) * scale));
  const opacityOf = (p) => (!db || inDetail(p) ? 0.45 : 0.3); // 粗網格重疊多，畫淡一點

  // 物件池：有幾個畫幾個，多的收起來
  for (let i = 0; i < drawn.length; i++) {
    const p = drawn[i];
    const color = tempToColor(p.t);
    let circle = state.circles[i];
    if (!circle) {
      circle = new google.maps.Circle({
        fillOpacity: 0.45,
        strokeWeight: 0,
        clickable: false,
        map: state.map,
      });
      state.circles[i] = circle;
    }
    circle.setOptions({
      center: { lat: p.lat, lng: p.lng },
      fillColor: color,
      radius: radiusOf(p),
      fillOpacity: opacityOf(p),
    });
    if (!circle.getMap()) circle.setMap(state.map);
  }
  for (let i = drawn.length; i < state.circles.length; i++) {
    if (state.circles[i].getMap()) state.circles[i].setMap(null);
  }

  $('mapCoverageNotice').classList.toggle('hidden', visible.length > 0);

  $('legendCount').textContent =
    visible.length === 0
      ? '目前視野沒有溫度資料'
      : `視野內 ${visible.length} 點，顯示 ${drawn.length} 點` +
        (step > 1 ? `（每 ${step} 點取 1）` : '');
}

// Maps API callback，必須是全域函式
self.initMap = function () {
  state.map = new google.maps.Map($('map'), {
    center: { lat: 25.02, lng: 121.545 },
    zoom: 12,
    disableDefaultUI: true,
    zoomControl: true,
    gestureHandling: 'greedy',
    styles: [
      { featureType: 'poi', stylers: [{ visibility: 'off' }] },
      { featureType: 'transit', stylers: [{ visibility: 'off' }] },
    ],
  });

  // 只在地圖靜止時重繪，拖曳過程中不做事
  state.map.addListener('idle', renderHeatLayer);
  setupPlaceInput($('originInput'));
  setupPlaceInput($('destInput'));
  loadGrid();
};

function loadMapsScript() {
  if (!CFG.mapsApiKey || CFG.mapsApiKey.startsWith('REPLACE_')) {
    setStatus('尚未設定 Google Maps API key。請填 functions/.env 的 GOOGLE_MAPS_API_KEY（本機），或 public/config.js 的 mapsApiKey（部署）。地圖不會顯示，但路線查詢仍可運作。', true);
    return;
  }
  const s = document.createElement('script');
  s.src =
    `https://maps.googleapis.com/maps/api/js?key=${CFG.mapsApiKey}` +
    '&callback=initMap&libraries=geometry,places&language=zh-TW&region=TW&loading=async';
  s.async = true;
  document.head.appendChild(s);
}

/**
 * 起訖點輸入框可以打「地名」也可以打「lat,lng」。
 * 有 Places API 時掛自動完成，選中後把座標存進 dataset（比後端地理編碼精確）；
 * 沒有也沒關係，純文字會交給後端 /api/coolRoute 地理編碼。
 */
function setupPlaceInput(input) {
  if (!self.google?.maps?.places?.Autocomplete) return;
  try {
    const ac = new google.maps.places.Autocomplete(input, {
      fields: ['geometry', 'name'],
      componentRestrictions: { country: 'tw' },
    });
    ac.addListener('place_changed', () => {
      const loc = ac.getPlace()?.geometry?.location;
      if (!loc) return;
      input.dataset.lat = loc.lat();
      input.dataset.lng = loc.lng();
    });
  } catch (err) {
    console.warn('[places] 自動完成無法啟用，改由後端地理編碼', err);
  }
}

/** 送給後端的值：優先用自動完成選中的座標，其次是使用者輸入的文字 */
function readPlace(id) {
  const input = $(id);
  const { lat, lng } = input.dataset;
  return lat && lng ? `${lat},${lng}` : input.value.trim();
}

/* ────────────────────────── A2 路線查詢與對比 ────────────────────────── */

/** 後端接口。想在沒有後端時看畫面，網址加 ?mock=1 */
async function fetchRoutes(origin, destination) {
  if (USE_MOCK) return mockRoutes();

  const url = `/api/coolRoute?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}&mode=${state.mode}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);

  if (data.meta && data.meta.lstSource === 'PLACEHOLDER_SYNTHETIC') {
    $('placeholderWarning').classList.remove('hidden');
  }
  return data;
}

/** 假資料，只在 ?mock=1 時使用，畫面會標明是示範資料 */
function mockRoutes() {
  const mk = (label, dur, dist, heat, max) => ({
    polyline: '',
    durationSec: dur,
    distanceM: dist,
    heatScore: heat,
    maxSurfaceTemp: max,
    samplePoints: Math.round(dist / 50),
    coveredPoints: Math.round(dist / 50),
    coverageRatio: 1,
    label,
    mapsUrl: 'https://www.google.com/maps/dir/?api=1&origin=24.9874,121.5759&destination=25.0488,121.5137&travelmode=driving',
  });
  const routes = [mk('coolest', 2100, 13400, 38.4, 42.1), mk('fastest', 1800, 11200, 44.2, 47.0)];
  return {
    ok: true,
    mock: true,
    meta: { lstSource: 'MOCK', sampleIntervalM: 50, routeCount: 2 },
    comparison: { extraMinutes: 5, tempDelta: 5.8, summary: '示範資料' },
    routes,
  };
}

const fmtDuration = (sec) => {
  const m = Math.round(sec / 60);
  return m >= 60 ? `${Math.floor(m / 60)} 小時 ${m % 60} 分` : `${m} 分鐘`;
};
const fmtDistance = (m) => `${(m / 1000).toFixed(1)} 公里`;
const fmtTemp = (t) => (t === null || t === undefined ? '無資料' : `${t.toFixed(1)}`);
const routeCoverage = (route) =>
  Number.isFinite(route.coverageRatio) ? route.coverageRatio : route.heatScore == null ? 0 : 1;
const routeHasTemperature = (route) =>
  route && route.heatScore != null && routeCoverage(route) >= MIN_ROUTE_COVERAGE;

function drawRoutes(data) {
  const routes = data.routes;
  for (const line of state.routeLines) line.setMap(null);
  for (const m of state.routeMarkers) m.setMap(null);
  state.routeLines = [];
  state.routeMarkers = [];
  if (!state.map || !self.google) return;

  const bounds = new google.maps.LatLngBounds();
  let drew = false;

  // 先畫 fastest，coolest 疊在上面
  const { coolest, fastest } = splitRoutes(data);
  const ordered = [...routes].sort((a, b) => (a === coolest ? 1 : b === coolest ? -1 : 0));

  for (const r of ordered) {
    if (!r.polyline) continue;
    const path = google.maps.geometry.encoding.decodePath(r.polyline);
    const isCool = r === coolest && routeHasTemperature(r);
    const isFast = r === fastest;
    if (!isCool && !isFast) continue;

    const line = new google.maps.Polyline({
      path,
      strokeColor: isCool ? '#16a34a' : '#2563eb',
      strokeOpacity: 0.95,
      strokeWeight: isCool ? 7 : 5,
      zIndex: isCool ? 3 : 2,
      map: state.map,
    });
    state.routeLines.push(line);
    path.forEach((p) => bounds.extend(p));
    drew = true;
  }

  // 起訖點大頭針（設計稿：綠＝起點、紅＝終點）
  const resolved = data.query && data.query.resolved;
  if (drew && resolved && resolved.origin && resolved.destination) {
    const pin = (pos, color) =>
      new google.maps.Marker({
        position: pos,
        map: state.map,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 8,
          fillColor: color,
          fillOpacity: 1,
          strokeColor: '#ffffff',
          strokeWeight: 3,
        },
        zIndex: 5,
      });
    state.routeMarkers.push(pin(resolved.origin, '#10b981'), pin(resolved.destination, '#ef4444'));
  }

  if (drew) state.map.fitBounds(bounds, 40);
}

/**
 * label 是單一字串，最涼與最快是同一條時 coolest 會蓋過 fastest，
 * 所以要靠後端的 meta.sameRouteIsBoth 才知道那條同時也是最快的。
 */
function splitRoutes(data) {
  const routes = data.routes;
  const coolest = routes.find((r) => r.label === 'coolest') || null;
  const explicitFastest = routes.find((r) => r.label === 'fastest') || null;
  const sameRoute = !explicitFastest && !!(data.meta && data.meta.sameRouteIsBoth);
  return { coolest, fastest: explicitFastest || (sameRoute ? coolest : null), sameRoute };
}

function renderCards(data) {
  const wrap = $('cards');
  wrap.innerHTML = '';

  const { coolest, fastest, sameRoute } = splitRoutes(data);
  const show = [coolest, fastest].filter((r, i, arr) => r && arr.indexOf(r) === i);
  const bothComparable =
    coolest && fastest && !sameRoute && routeHasTemperature(coolest) && routeHasTemperature(fastest);
  const extraMin = bothComparable ? Math.round((coolest.durationSec - fastest.durationSec) / 60) : 0;
  const delta = bothComparable ? (fastest.heatScore - coolest.heatScore).toFixed(1) : null;

  for (const r of show) {
    const hasTemperature = routeHasTemperature(r);
    const isCool = r === coolest && hasTemperature;
    const coveragePct = Math.round(routeCoverage(r) * 100);
    const mins = Math.round(r.durationSec / 60);
    const km = (r.distanceM / 1000).toFixed(1);

    const timeWord = (MODE_INFO[state.mode] || MODE_INFO.scooter).timeWord;
    const title = hasTemperature ? (isCool ? '🍃 涼爽路線' : '⚡ 最快路線') : '⚡ 最快路線';
    const sub = hasTemperature
      ? isCool
        ? '沿線平均地表溫度最低'
        : `${timeWord}時間最短`
      : `${timeWord}時間最短｜溫度資料不足`;

    let note = '';
    if (!hasTemperature) {
      note = '<div class="card-note warn">此路線溫度網格覆蓋不足，不比較熱暴露</div>';
    } else if (sameRoute && isCool) {
      note = '<div class="card-note cool">最涼與最快是同一條路線，沒有取捨</div>';
    } else if (bothComparable && isCool) {
      note =
        extraMin > 0
          ? `<div class="card-note cool">比最快路線多 ${extraMin} 分鐘，但平均低 ${delta}°C 更涼爽</div>`
          : `<div class="card-note cool">比最快路線更快，平均還低 ${delta}°C</div>`;
    } else if (bothComparable) {
      note = `<div class="card-note fast">比涼爽路線快 ${extraMin} 分鐘，但平均高 ${delta}°C 較炎熱</div>`;
    }

    const card = document.createElement('div');
    card.className = `card ${isCool ? 'coolest' : 'fastest'}`;
    card.innerHTML = `
      <div class="card-head">${isCool && !sameRoute && bothComparable ? '<span class="badge badge-cool">推薦</span>' : ''}<span class="card-title">${title}</span></div>
      <div class="card-sub">${sub}</div>
      <div class="card-main">
        <span class="card-big">${mins}<small>分鐘</small></span>
        <span class="card-big">${km}<small>公里</small></span>
      </div>
      <div class="card-metrics">
        <div class="card-metric">
          <span class="card-metric-label">沿線平均地表溫度</span>
          <span class="card-metric-value ${hasTemperature ? '' : 'unavailable'}" style="${
            hasTemperature ? `color:${isCool ? 'var(--cool)' : 'var(--hot)'}` : ''
          }">${hasTemperature ? `${fmtTemp(r.heatScore)}°C` : '資料不足'}</span>
        </div>
        <div class="card-metric">
          <span class="card-metric-label">最高溫路段</span>
          <span class="card-metric-value">${hasTemperature ? `${fmtTemp(r.maxSurfaceTemp)}°C` : '--'}</span>
        </div>
      </div>
      ${note}
      <div class="card-samples">沿線取樣 ${r.samplePoints} 點｜溫度覆蓋 ${coveragePct}%｜</div>
    `;

    // A3 交棒 Google Maps —— 產品定位的體現，按鈕文案不要改
    const btn = document.createElement('button');
    btn.className = 'btn btn-nav';
    btn.textContent = '用 Google Maps 導航';
    btn.addEventListener('click', () => {
      window.location.href = r.mapsUrl;
    });
    card.appendChild(btn);

    wrap.appendChild(card);
  }
}

/** A3 導航交棒列：主按鈕帶最涼路線，分享按鈕分享目前頁面 */
function updateActionBar(data) {
  const { coolest, fastest } = splitRoutes(data);
  const target = routeHasTemperature(coolest) ? coolest : fastest || coolest;
  if (!target || !target.mapsUrl) {
    $('actionBar').classList.add('hidden');
    return;
  }
  $('navBtn').textContent = `用 Google Maps 導航（${
    target === coolest && routeHasTemperature(coolest) ? '涼爽路線' : '最快路線'
  }）`;
  $('navBtn').onclick = () => {
    window.location.href = target.mapsUrl;
  };
  $('actionBar').classList.remove('hidden');
}

function renderComparison(data) {
  const el = $('comparison');
  const { coolest, fastest, sameRoute } = splitRoutes(data);

  if (!routeHasTemperature(coolest) || !routeHasTemperature(fastest)) {
    el.textContent = '此路線溫度資料覆蓋不足，目前只能比較行車時間，不能比較熱暴露。';
    el.classList.add('unavailable');
    el.classList.remove('hidden');
    return;
  }

  el.classList.remove('unavailable');
  if (!coolest || !fastest || sameRoute) {
    el.innerHTML = '🍃 最涼與最快是<em>同一條</em>路線，沒有取捨';
    el.classList.remove('hidden');
    return;
  }

  const extraMin = Math.round((coolest.durationSec - fastest.durationSec) / 60);
  const delta = (fastest.heatScore - coolest.heatScore).toFixed(1);

  el.innerHTML =
    extraMin > 0
      ? `🍃 選擇涼爽路線，沿線平均地表溫度可低 <em>${delta}°C</em>（多花 ${extraMin} 分鐘）`
      : `🍃 涼爽路線同時也比較快，沿線平均地表溫度低 <em>${delta}°C</em>`;
  el.classList.remove('hidden');
}

async function planRoute() {
  const origin = readPlace('originInput');
  const destination = readPlace('destInput');
  if (!origin || !destination) {
    setStatus('請先輸入起點與終點（地名或座標都可以）', true);
    return Promise.reject(new Error('缺起訖點'));
  }

  $('planBtn').disabled = true;
  setStatus('計算中：呼叫 Routes API、解碼路線、沿線每 50 公尺取樣查詢地表溫度…');

  try {
    const data = await fetchRoutes(origin, destination);
    state.routes = data.routes;

    // 地名輸入時前端沒有座標，用後端回填的實際終點更新環境風險列
    const resolvedDest = data.query?.resolved?.destination;
    if (!parseLatLng(destination) && resolvedDest) loadRisk(resolvedDest);

    drawRoutes(data);
    renderCards(data);
    renderComparison(data);
    updateActionBar(data);

    const bestCoverage = Math.max(...data.routes.map(routeCoverage));
    const insufficient = !data.mock && bestCoverage < MIN_ROUTE_COVERAGE;
    setStatus(
      data.mock
        ? '⚠️ 目前顯示的是前端示範假資料（?mock=1），不是真實計算結果'
        : insufficient
          ? `路線完成，但溫度資料最高僅覆蓋 ${Math.round(bestCoverage * 100)}%（可能經過離島或資料空洞），暫不比較熱暴露`
          : `完成：${data.routes.length} 條路線，沿線每 ${data.meta.sampleIntervalM} 公尺取樣一點`,
      !!data.mock || insufficient
    );
    return data;
  } catch (err) {
    console.error('[route]', err);
    setStatus(`路線規劃失敗：${err.message}`, true);
    throw err;
  } finally {
    $('planBtn').disabled = false;
  }
}

/* ────────────────────────── A5 環境資訊列 ────────────────────────── */

async function loadRisk(at) {
  const dest = at || parseLatLng(readPlace('destInput')) || CFG.demo.destination;
  try {
    const res = await fetch(`/api/assessRisk?lat=${dest.lat}&lng=${dest.lng}`);
    const risk = await res.json();
    if (risk.ok === false) throw new Error(risk.error);
    state.risk = risk;
    renderEnvBar(risk);
    return risk;
  } catch (err) {
    console.error('[risk]', err);
    return null;
  }
}

function renderEnvBar(risk) {
  $('envAirTemp').textContent = `${risk.airTemp}°C`;
  $('envFeelsLike').textContent = `${risk.feelsLike}°C`;
  $('envHumidity').textContent = `${risk.humidity}%`;
  $('envUvi').textContent = risk.uvi;

  const meta = risk.meta || {};
  const defaults = meta.usedDefaults || [];
  const degraded = meta.degraded || [];
  $('envWeatherNote').textContent = defaults.includes('weather')
    ? '即時氣象無資料，使用預設值'
    : degraded.includes('weather') && meta.usedCache
      ? '快取觀測值'
      : meta.station
        ? `${meta.station}測站`
        : '氣象觀測值';
  $('envFeelsNote').textContent =
    meta.feelsLikeSource === 'CWA_FORECAST'
      ? `CWA 預報${meta.feelsLikeArea ? `｜${meta.feelsLikeArea}` : ''}`
      : '由氣溫濕度計算';
  $('envUviNote').textContent = defaults.includes('uvi')
    ? '環境部目前無資料，使用預設值 8'
    : degraded.includes('uvi') && meta.usedCache
      ? '環境部快取值'
      : meta.uviSite
        ? `${meta.uviSite}測站觀測值`
        : '環境部觀測值';
  updateDataQuality();

  const label = { low: '低', medium: '中', high: '高' }[risk.level] || '--';
  const el = $('envLevel');
  el.textContent = label;
  el.className = risk.level;

  // 頂列 CWA 資料狀態膠囊
  const pill = $('cwaPill');
  const t = risk.dataTime ? new Date(risk.dataTime) : null;
  const hhmm =
    t && !Number.isNaN(t.getTime())
      ? `${t.getHours()}:${String(t.getMinutes()).padStart(2, '0')}`
      : '';
  if (defaults.includes('weather')) {
    $('cwaPillText').textContent = '氣象使用預設值';
    pill.classList.add('degraded');
  } else if (degraded.includes('weather') && meta.usedCache) {
    $('cwaPillText').textContent = `CWA 快取${hhmm ? ` ${hhmm}` : ''}`;
    pill.classList.add('degraded');
  } else {
    $('cwaPillText').textContent = `CWA 觀測${hhmm ? ` ${hhmm}` : ''}`;
    pill.classList.remove('degraded');
  }
  pill.classList.remove('hidden');
}

function parseLatLng(s) {
  const parts = String(s || '').split(',');
  if (parts.length !== 2) return null;
  const lat = Number(parts[0]);
  const lng = Number(parts[1]);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

/* ────────────────────────── Gemini 判斷層 ────────────────────────── */

async function loadDecision(risk, routes) {
  if (!risk || !routes || routes.length === 0) return null;
  try {
    const res = await fetch('/api/decide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ risk, routes }),
    });
    const decision = await res.json();
    if (decision.ok === false) throw new Error(decision.error);

    state.decision = decision;
    renderDecision(decision);
    return decision;
  } catch (err) {
    console.error('[decide]', err);
    return null;
  }
}

function renderDecision(d) {
  const pill = $('decisionLevel');
  pill.textContent = { low: '低風險', medium: '中風險', high: '高風險' }[d.level] || d.level;
  pill.className = `pill ${d.level}`;

  $('decisionHeadline').textContent = d.headline;
  $('decisionAction').textContent = d.action;
  $('decisionReason').textContent = d.reason;
  $('decisionQuiet').classList.toggle('hidden', d.shouldNotify !== false);
  $('decision').classList.remove('hidden');
}

/* ────────────────────────── A4 語音播報 ────────────────────────── */

function pickVoice() {
  const voices = speechSynthesis.getVoices();
  state.voice =
    voices.find((v) => v.lang === 'zh-TW') ||
    voices.find((v) => v.lang && v.lang.startsWith('zh')) ||
    null;
}

// getVoices() 初次可能是空陣列，要等 onvoiceschanged
if ('speechSynthesis' in self) {
  pickVoice();
  speechSynthesis.onvoiceschanged = pickVoice;
}

function speak(text) {
  if (!text || !('speechSynthesis' in self)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'zh-TW';
  if (state.voice) u.voice = state.voice;
  u.rate = 1.0;
  speechSynthesis.speak(u);
}

/** Chrome 要求首次發聲必須由使用者手勢觸發，用空字串先解鎖 */
function unlockSpeech() {
  if (state.speechUnlocked || !('speechSynthesis' in self)) return;
  speechSynthesis.speak(new SpeechSynthesisUtterance(''));
  state.speechUnlocked = true;
  pickVoice();
}

/* ────────────────────────── A6 FCM Web Push ────────────────────────── */

async function setupPush() {
  if (!CFG.vapidKey || CFG.vapidKey.startsWith('REPLACE_')) {
    console.warn('[fcm] 尚未設定 vapidKey，略過推播');
    return null;
  }
  if (!('serviceWorker' in navigator) || !self.firebase) return null;

  try {
    firebase.initializeApp(CFG.firebase);
    const messaging = firebase.messaging();

    // Notification.requestPermission() 必須由使用者手勢觸發，所以掛在「開始」按鈕上
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      setStatus('未取得推播權限，Demo 仍可用「一鍵示範」按鈕觸發流程');
      return null;
    }

    const reg = await navigator.serviceWorker.register('/firebase-messaging-sw.js');
    const token = await messaging.getToken({ vapidKey: CFG.vapidKey, serviceWorkerRegistration: reg });
    state.fcmToken = token;
    console.log('[fcm] token', token);

    // 寫入 Firestore users/demo_user，後端 notify 會讀這個欄位
    await fetch('/api/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ registerOnly: true, userId: DEMO_USER, token }),
    }).catch(() => {});

    // 前景訊息由頁面自己顯示，順便觸發語音
    messaging.onMessage((payload) => {
      const n = payload.notification || {};
      setStatus(`🔔 ${n.title || ''} ${n.body || ''}`);
      speak((payload.data && payload.data.speech) || n.body || '');
      if (Notification.permission === 'granted') {
        new Notification(n.title || '涼路 CoolPath', { body: n.body, icon: '/icon.png' });
      }
    });

    return token;
  } catch (err) {
    console.error('[fcm]', err);
    return null;
  }
}

/* ────────────────────────── A7 Demo 觸發 ────────────────────────── */

async function runDemo() {
  $('demoBtn').disabled = true;
  unlockSpeech();

  try {
    setStatus('① 評估環境風險…');
    const risk = await loadRisk();

    setStatus('② 計算路線熱暴露…');
    const routeData = await planRoute();

    setStatus('③ 交給 Gemini 判斷…');
    const decision = await loadDecision(risk || state.risk, routeData.routes);

    if (decision) {
      speak(decision.speech);
      setStatus(
        decision.shouldNotify
          ? `判斷完成：${decision.headline}`
          : `判斷完成：風險為 low，系統決定不打擾使用者（shouldNotify = false）`
      );

      // 有 token 才送推播，讓橫幅蓋在 Google Maps 上
      if (decision.shouldNotify && state.fcmToken) {
        fetch('/api/notify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId: DEMO_USER,
            title: decision.headline,
            body: decision.action,
            speech: decision.speech,
          }),
        }).catch((err) => console.error('[notify]', err));
      }
    }
  } catch (err) {
    setStatus(`示範流程中斷：${err.message}`, true);
  } finally {
    $('demoBtn').disabled = false;
  }
}

/* ────────────────────────── 啟動 ────────────────────────── */

function init() {
  // 預設顯示地名（可讀），座標放 dataset（精確）；使用者一改字就清掉 dataset
  const prefill = (id, place) => {
    const input = $(id);
    input.value = place.name;
    input.dataset.lat = place.lat;
    input.dataset.lng = place.lng;
    input.addEventListener('input', () => {
      delete input.dataset.lat;
      delete input.dataset.lng;
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') planRoute().catch(() => {});
    });
  };
  prefill('originInput', CFG.demo.origin);
  prefill('destInput', CFG.demo.destination);

  $('swapBtn').addEventListener('click', () => {
    const a = $('originInput');
    const b = $('destInput');
    [a.value, b.value] = [b.value, a.value];
    [a.dataset.lat, b.dataset.lat] = [b.dataset.lat || '', a.dataset.lat || ''];
    [a.dataset.lng, b.dataset.lng] = [b.dataset.lng || '', a.dataset.lng || ''];
  });

  // 交通方式選擇（機車預設）
  document.querySelectorAll('.mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.mode = btn.dataset.mode;
      document.querySelectorAll('.mode-btn').forEach((b) => b.classList.toggle('active', b === btn));
      $('modeHint').textContent = (MODE_INFO[state.mode] || MODE_INFO.scooter).hint;
    });
  });

  $('planBtn').addEventListener('click', () => planRoute().catch(() => {}));
  $('demoBtn').addEventListener('click', runDemo);

  // 使用目前位置當起點（需 HTTPS 或 localhost）
  $('locateBtn').addEventListener('click', () => {
    if (!navigator.geolocation) {
      setStatus('此瀏覽器不支援定位', true);
      return;
    }
    setStatus('取得目前位置中…');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const input = $('originInput');
        input.value = '目前位置';
        input.dataset.lat = pos.coords.latitude;
        input.dataset.lng = pos.coords.longitude;
        setStatus('已將起點設為目前位置');
      },
      (err) => setStatus(`定位失敗：${err.message}（需要 HTTPS 或 localhost）`, true),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });

  $('infoBtn').addEventListener('click', () => {
    $('sources').scrollIntoView({ behavior: 'smooth' });
  });

  $('shareBtn').addEventListener('click', async () => {
    const share = { title: '涼路 CoolPath', text: '找一條更涼的路', url: location.href };
    try {
      if (navigator.share) await navigator.share(share);
      else {
        await navigator.clipboard.writeText(location.href);
        setStatus('已複製連結');
      }
    } catch (err) {
      if (err.name !== 'AbortError') setStatus('分享失敗，請直接複製網址', true);
    }
  });
  $('replayBtn').addEventListener('click', () => {
    unlockSpeech();
    speak(state.decision ? state.decision.speech : '尚未產生判斷結果。');
  });

  // 「開始」：一次解鎖語音與推播權限，兩者都必須由使用者手勢觸發
  $('startBtn').addEventListener('click', async () => {
    unlockSpeech();
    speak('涼路已啟動。');
    $('startBtn').textContent = '已啟動';
    $('startBtn').classList.add('armed');
    await setupPush();
  });

  loadMapsScript();
  loadRisk();
}

document.addEventListener('DOMContentLoaded', init);
