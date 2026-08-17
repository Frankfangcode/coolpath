#!/usr/bin/env node
/**
 * 上線前檢查 —— 現在還差什麼、每一項卡住哪個功能。
 *
 *   node tools/preflight.js           只看設定有沒有填
 *   node tools/preflight.js --live    實際打每支 API，驗證 key 真的能用
 *
 * --live 會產生極少量的 API 用量（每支各一次呼叫），成本可忽略。
 * 「有填」跟「能用」是兩回事，上台前請至少跑一次 --live。
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const LIVE = process.argv.includes('--live');

/* ────────────────── 載入設定 ────────────────── */

const env = {};
const envPath = path.join(ROOT, 'functions', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && m[2]) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
Object.assign(process.env, env);

const configPath = path.join(ROOT, 'public', 'config.js');
const configSrc = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
const configFilled = (field) => {
  const m = new RegExp(`${field}:\\s*['"]([^'"]*)['"]`).exec(configSrc);
  return m && !m[1].startsWith('REPLACE_') ? m[1] : null;
};

let projectId = null;
const rcPath = path.join(ROOT, '.firebaserc');
if (fs.existsSync(rcPath)) {
  try {
    projectId = JSON.parse(fs.readFileSync(rcPath, 'utf8')).projects?.default || null;
  } catch {}
}

const has = (cmd) => {
  try {
    execSync(`command -v ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

/* ────────────────── 檢查結果收集 ────────────────── */

const rows = [];
const add = (item, state, blocks, fix) => rows.push({ item, state, blocks, fix });

const OK = 'ok';
const MISSING = 'missing';
const BAD = 'bad';

async function probe(url, options = {}, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } catch (err) {
    return { ok: false, status: 0, text: String(err.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

const brief = (t) => String(t).replace(/\s+/g, ' ').slice(0, 110);

/* ────────────────── 各項檢查 ────────────────── */

async function checkRoutes() {
  const key = env.GOOGLE_MAPS_API_KEY;
  if (!key) {
    return add('Routes API key', MISSING, '核心產品 coolRoute 只能用本機假路線',
      'Cloud Console 啟用 Routes API 後建 key，填進 functions/.env 的 GOOGLE_MAPS_API_KEY');
  }
  if (!LIVE) return add('Routes API key', OK, '', '（--live 可實際驗證）');

  const r = await probe('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters',
    },
    body: JSON.stringify({
      origin: { location: { latLng: { latitude: 24.9874, longitude: 121.5759 } } },
      destination: { location: { latLng: { latitude: 25.0488, longitude: 121.5137 } } },
      travelMode: 'DRIVE',
      computeAlternativeRoutes: true,
    }),
  });

  if (r.ok) {
    let n = 0;
    try {
      n = (JSON.parse(r.text).routes || []).length;
    } catch {}
    if (n < 2) {
      return add('Routes API key', OK, `只回傳 ${n} 條路線`,
        '政大→北車通常有 2–3 條替代路線；只有 1 條時前端會顯示「最涼與最快是同一條」');
    }
    return add('Routes API key', OK, '', `實測回傳 ${n} 條路線`);
  }
  add('Routes API key', BAD, '核心產品 coolRoute 會回 500', `HTTP ${r.status} ${brief(r.text)}`);
}

async function checkCwa() {
  const key = env.CWA_API_KEY;
  if (!key) {
    return add('中央氣象署 key', MISSING, 'assessRisk 的氣溫濕度用預設值',
      'https://opendata.cwa.gov.tw/ 註冊取得授權碼，填 CWA_API_KEY');
  }
  if (!LIVE) return add('中央氣象署 key', OK, '', '（--live 可實際驗證）');

  const r = await probe(
    `https://opendata.cwa.gov.tw/api/v1/rest/datastore/O-A0003-001?Authorization=${encodeURIComponent(key)}&format=JSON`
  );
  if (!r.ok) return add('中央氣象署 key', BAD, 'assessRisk 會降級', `HTTP ${r.status} ${brief(r.text)}`);

  try {
    const d = JSON.parse(r.text);
    const n = (d.records?.Station || d.records?.location || []).length;
    if (n === 0) return add('中央氣象署 key', BAD, 'assessRisk 會降級', '回應裡沒有測站資料');
    add('中央氣象署 key', OK, '', `實測取得 ${n} 個測站`);
  } catch {
    add('中央氣象署 key', BAD, 'assessRisk 會降級', '回應不是合法 JSON');
  }
}

async function checkMoenv() {
  const key = env.MOENV_API_KEY;
  if (!key) {
    return add('環境部 key', MISSING, 'assessRisk 的 UVI 用預設值',
      'https://data.moenv.gov.tw/ 註冊取得 api_key，填 MOENV_API_KEY');
  }
  if (!LIVE) return add('環境部 key', OK, '', '（--live 可實際驗證）');

  const r = await probe(
    `https://data.moenv.gov.tw/api/v2/uv_s_01?api_key=${encodeURIComponent(key)}&format=JSON&limit=200`
  );
  if (!r.ok) return add('環境部 key', BAD, 'UVI 會用預設值', `HTTP ${r.status} ${brief(r.text)}`);

  try {
    const recs = JSON.parse(r.text).records || [];
    const tp = recs.find((x) => /[臺台]北/.test(String(x.county || x.sitename || '')));
    if (!tp) return add('環境部 key', BAD, 'UVI 會用預設值', `取得 ${recs.length} 筆但找不到台北測站`);
    add('環境部 key', OK, '', `台北測站 ${tp.sitename} UVI ${tp.uvi}`);
  } catch {
    add('環境部 key', BAD, 'UVI 會用預設值', '回應不是合法 JSON');
  }
}

async function checkGemini() {
  if (env.GEMINI_API_KEY) {
    if (!LIVE) return add('Gemini（AI Studio）', OK, '', '（--live 可實際驗證）');
    const model = env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
    const r = await probe(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
        body: JSON.stringify({ contents: [{ parts: [{ text: 'ping' }] }] }),
      }
    );
    return r.ok
      ? add('Gemini（AI Studio）', OK, '', `模型 ${model} 可用`)
      : add('Gemini（AI Studio）', BAD, 'decide 走規則式 fallback', `HTTP ${r.status} ${brief(r.text)}`);
  }

  // Vertex + ADC
  let token = null;
  let adcProject = null;
  try {
    const { GoogleAuth } = require(path.join(ROOT, 'functions', 'node_modules', 'google-auth-library'));
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    const client = await auth.getClient();
    const t = await client.getAccessToken();
    token = typeof t === 'string' ? t : t?.token;
    adcProject = await auth.getProjectId().catch(() => null);
  } catch (err) {
    return add('Gemini（Vertex + ADC）', MISSING, 'decide 走規則式 fallback',
      '本機跑 gcloud auth application-default login；部署後服務帳號需有 roles/aiplatform.user');
  }

  if (!token) {
    return add('Gemini（Vertex + ADC）', MISSING, 'decide 走規則式 fallback',
      'ADC 取不到 access token，跑 gcloud auth application-default login');
  }

  const p = env.GEMINI_PROJECT_ID || adcProject || projectId;
  if (!p) {
    return add('Gemini（Vertex + ADC）', BAD, 'decide 走規則式 fallback',
      'ADC 有了但取不到專案 ID，設 GEMINI_PROJECT_ID');
  }
  if (!LIVE) return add('Gemini（Vertex + ADC）', OK, '', `ADC 就緒，專案 ${p}（--live 可實際驗證）`);

  const loc = env.GEMINI_LOCATION || 'global';
  const model = env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
  const host = loc === 'global' ? 'aiplatform.googleapis.com' : `${loc}-aiplatform.googleapis.com`;
  const r = await probe(
    `https://${host}/v1/projects/${p}/locations/${loc}/publishers/google/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
        generationConfig: { maxOutputTokens: 8 },
      }),
    }
  );

  if (r.ok) return add('Gemini（Vertex + ADC）', OK, '', `${model} @ ${loc}，專案 ${p}`);
  const hint =
    r.status === 403
      ? '需啟用 aiplatform.googleapis.com 或授予 roles/aiplatform.user'
      : r.status === 404
        ? `該地區沒有 ${model}，把 GEMINI_LOCATION 設回 global`
        : brief(r.text);
  add('Gemini（Vertex + ADC）', BAD, 'decide 走規則式 fallback', `HTTP ${r.status} — ${hint}`);
}

function checkFrontend() {
  const mapsKey = configFilled('mapsApiKey');
  add(
    'Maps JS key（前端地圖）',
    mapsKey ? OK : MISSING,
    mapsKey ? '' : '地圖圖磚與熱區圖層不顯示',
    mapsKey ? '' : 'Cloud Console 啟用 Maps JavaScript API 後建 key，填 public/config.js 的 mapsApiKey'
  );

  const vapid = configFilled('vapidKey');
  add(
    'VAPID key（推播）',
    vapid ? OK : MISSING,
    vapid ? '' : 'FCM 推播不能用，Demo 第 5 步的橫幅出不來',
    vapid ? '' : 'Firebase Console → 專案設定 → Cloud Messaging → Web Push certificates → Generate key pair'
  );

  const fbKey = configFilled('apiKey');
  const senderId = configFilled('messagingSenderId');
  add(
    'firebaseConfig',
    fbKey && senderId ? OK : MISSING,
    fbKey && senderId ? '' : 'FCM 初始化會失敗',
    fbKey && senderId ? '' : 'Firebase Console → 專案設定 → 一般 → 你的應用程式 → SDK 設定與配置'
  );
}

function checkProject() {
  const isDefault = !projectId || projectId === 'coolpath-demo';
  add(
    'Firebase 專案 ID',
    isDefault ? MISSING : OK,
    isDefault ? '部署會失敗或部署到錯的專案' : '',
    isDefault ? '把 .firebaserc 的 coolpath-demo 改成實際專案 ID' : projectId
  );

  add(
    'firebase-tools',
    has('firebase') ? OK : MISSING,
    has('firebase') ? '' : '無法部署',
    has('firebase') ? '' : 'npm install -g firebase-tools && firebase login'
  );

  add(
    'gcloud',
    has('gcloud') ? OK : MISSING,
    has('gcloud') ? '' : '無法用指令啟用 API 或設 ADC（也可全部在 Console 網頁點）',
    has('gcloud') ? '' : 'https://cloud.google.com/sdk/docs/install'
  );
}

function checkLst() {
  const lst = require(path.join(ROOT, 'functions', 'lst.js'));
  const src = lst.source();
  const isReal = src === 'LANDSAT_8_9_SUMMER_MEDIAN';
  add(
    'LST 地表溫度資料',
    isReal ? OK : BAD,
    isReal ? '' : '所有溫度都是合成的，網頁會顯示紅色警告條',
    isReal ? `${lst.stats().points} 點，Landsat 實測` : '跑 tools/earthengine_lst_export.js 匯出後用 verify_lst_grid.js --install 安裝'
  );
}

/* ────────────────── 輸出 ────────────────── */

(async () => {
  console.log(`\n涼路 CoolPath 上線前檢查${LIVE ? '（--live：實際呼叫每支 API）' : ''}\n`);

  checkProject();
  checkFrontend();
  checkLst();
  await checkRoutes();
  await checkCwa();
  await checkMoenv();
  await checkGemini();

  const icon = { [OK]: '✓', [MISSING]: '·', [BAD]: '✗' };

  // 全形字元佔兩欄，用實際顯示寬度對齊
  const displayWidth = (s) =>
    [...s].reduce((n, c) => n + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  const col = Math.max(...rows.map((r) => displayWidth(r.item))) + 2;

  for (const r of rows) {
    const pad = ' '.repeat(col - displayWidth(r.item));
    console.log(`  ${icon[r.state]} ${r.item}${pad}${r.blocks || ''}`);
    if (r.fix) console.log(`      ${r.fix}`);
  }

  const bad = rows.filter((r) => r.state === BAD).length;
  const missing = rows.filter((r) => r.state === MISSING).length;
  const ok = rows.filter((r) => r.state === OK).length;

  console.log(`\n  ${ok} 項就緒　${missing} 項未設定　${bad} 項有問題`);

  if (!LIVE && ok > 0) {
    console.log(`\n  「有填」不等於「能用」。上台前至少跑一次：node tools/preflight.js --live`);
  }
  if (bad + missing === 0) {
    console.log(`\n  全部就緒。接著跑 firebase deploy，然後照 README 第三節的清單驗一遍。`);
  }
  console.log('');
})();
