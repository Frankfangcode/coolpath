/**
 * agent.js — 任務 C 的判斷層。
 *
 * 重點是「決策」不是「生成文字」：從所有訊號中只挑出此刻最重要的一件事，
 * 並且要能判斷「不需要打擾使用者」。
 */

const { GoogleAuth } = require('google-auth-library');
const { fetchWithTimeout, round1 } = require('./http');

const SYSTEM_PROMPT = `你是「涼路 CoolPath」的決策代理人，服務對象是台北市準備出門的機車與行人使用者。

你的工作是「決策」，不是「生成文字」。從所有訊號中，只挑出此刻最重要的一件事來講。

規則（違反任何一條都算失敗）：
1. 只輸出一個 JSON 物件，不要加 markdown 圍欄、不要加任何說明文字。
2. 欄位固定為：level, shouldNotify, headline, action, reason, speech。
3. headline 一句話講結論，20 字內。
4. action 必須具體且含數字，例如「多花 5 分鐘，沿線平均地表溫度從 44 度降到 38 度」。
   絕不可寫「請多加注意」「建議做好防曬」這類沒有資訊量的空話。
5. reason 說明為什麼是這個等級，引用實際數值。
6. level 為 low 時，shouldNotify 必須為 false —— 系統要能判斷「不打擾使用者」。
   level 為 medium 或 high 時 shouldNotify 為 true。
7. speech 是口語化短句，30 字內，數字一律用國字（「四十二度」而非「42度」，避免 TTS 讀錯）。
8. 若提到補水，只能建議白開水或電解質飲料，絕不可提到含糖飲料或其他飲品。
9. 地表溫度可能是「夏季平均」或「最新可用晴空衛星觀測」，必須依輸入文字描述。
   兩者都絕不可說成「現在的溫度」「即時溫度」「這條路現在幾度」。
   最新可用觀測的不同像元可能來自不同日期，必須保留觀測年齡資訊。
10. 只講一件事。不要把所有指標都唸一遍。`;

function buildUserPrompt(risk, routes) {
  const coolest = routes.find((r) => r.label === 'coolest');
  const fastest = routes.find((r) => r.label === 'fastest');
  const hasNumber = (value) => value !== null && value !== undefined && Number.isFinite(Number(value));
  const latestObservation =
    hasNumber(risk.surfaceTempAgeDays) || routes.some((r) => hasNumber(r.maxObservationAgeDays));
  const tempNature = latestObservation
    ? '最新可用晴空衛星地表溫度（非即時；不同像元可能來自不同日期）'
    : '夏季平均地表溫度（非即時；氣候常態值）';

  const lines = [
    '【環境狀況】',
    `氣溫 ${risk.airTemp}°C，相對濕度 ${risk.humidity}%，體感溫度（Heat Index）${risk.feelsLike}°C`,
    `紫外線指數 UVI ${risk.uvi}（台北市測站，城市級數值，與路線無關）`,
    risk.surfaceTemp !== null && risk.surfaceTemp !== undefined
      ? `目的地${tempNature} ${risk.surfaceTemp}°C` +
        (hasNumber(risk.surfaceTempAgeDays)
          ? `，觀測距今 ${risk.surfaceTempAgeDays} 天`
          : '')
      : null,
    `規則判定風險等級：${risk.level}`,
    '',
    '【路線選項】',
  ];

  for (const r of routes) {
    const age = hasNumber(r.maxObservationAgeDays)
      ? `、沿線最舊像元距今 ${r.maxObservationAgeDays} 天`
      : '';
    lines.push(
      `- ${r.label}：${Math.round(r.durationSec / 60)} 分鐘、${(r.distanceM / 1000).toFixed(1)} 公里、` +
        `沿線平均地表溫度 ${r.heatScore}°C、最高路段 ${r.maxSurfaceTemp}°C` +
        `${age}（${r.samplePoints} 個取樣點）`
    );
  }

  if (coolest && fastest && coolest !== fastest) {
    const dMin = Math.round((coolest.durationSec - fastest.durationSec) / 60);
    const dTemp = round1(fastest.heatScore - coolest.heatScore);
    lines.push('', `【差異】最涼路線比最快路線多花 ${dMin} 分鐘，沿線平均地表溫度低 ${dTemp} 度。`);
  } else {
    lines.push('', '【差異】最涼與最快是同一條路線，沒有取捨問題。');
  }

  lines.push('', '請輸出 AgentDecision JSON。');
  return lines.filter((l) => l !== null).join('\n');
}

/** 阿拉伯數字轉國字，給 speech 用（避免 TTS 把 42 唸成「四二」） */
function toChineseNumber(n) {
  const digits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  const num = Number(n);
  if (!Number.isFinite(num) || num < 0) return String(n);

  // 小數：整數部分照規則，小數點後逐字唸
  if (!Number.isInteger(num)) {
    const [i, d] = String(num).split('.');
    return `${toChineseNumber(Number(i))}點${d.split('').map((c) => digits[Number(c)]).join('')}`;
  }
  if (num < 10) return digits[num];
  if (num < 20) return num === 10 ? '十' : `十${digits[num % 10]}`;
  if (num < 100) {
    const t = Math.floor(num / 10);
    const o = num % 10;
    return `${digits[t]}十${o ? digits[o] : ''}`;
  }
  return String(num).split('').map((d) => digits[Number(d)]).join('');
}

/** 規則式預設 decision：Gemini 掛掉或吐垃圾時頂上，內容一樣要具體、一樣要含數字 */
function fallbackDecision(risk, routes) {
  const coolest = routes.find((r) => r.label === 'coolest') || routes[0];
  const fastest = routes.find((r) => r.label === 'fastest') || null;
  const level = risk.level || 'medium';
  const shouldNotify = level !== 'low'; // low 一律不打擾

  if (!coolest || !fastest || coolest === fastest) {
    return {
      level,
      shouldNotify,
      headline: shouldNotify ? `體感 ${risk.feelsLike} 度，出門前先補水` : '目前狀況舒適，安心出門',
      action: shouldNotify
        ? `出發前喝 500 毫升白開水，UVI ${risk.uvi} 建議戴帽子或撐傘`
        : `體感 ${risk.feelsLike} 度、UVI ${risk.uvi}，維持原路線即可`,
      reason: `體感 ${risk.feelsLike} 度、UVI ${risk.uvi}，最涼與最快是同一條路線`,
      speech: shouldNotify
        ? `體感${toChineseNumber(risk.feelsLike)}度，出發前先喝白開水。`
        : '目前狀況舒適，可以出發。',
      meta: { source: 'rule-based-fallback' },
    };
  }

  const dMin = Math.round((coolest.durationSec - fastest.durationSec) / 60);
  const dTemp = round1(fastest.heatScore - coolest.heatScore);

  return {
    level,
    shouldNotify,
    headline: shouldNotify ? `建議改走最涼路線，低 ${dTemp} 度` : '目前狀況舒適，走最快路線即可',
    action: shouldNotify
      ? `多花 ${dMin} 分鐘，沿線平均地表溫度從 ${fastest.heatScore} 度降到 ${coolest.heatScore} 度`
      : `維持最快路線，${Math.round(fastest.durationSec / 60)} 分鐘可到`,
    reason: `體感 ${risk.feelsLike} 度，UVI ${risk.uvi}，最快路線最高路段達 ${fastest.maxSurfaceTemp} 度`,
    speech: shouldNotify
      ? `建議改走最涼路線，多花${toChineseNumber(dMin)}分鐘，沿線平均低${toChineseNumber(dTemp)}度。`
      : '目前狀況舒適，走最快的路線就好。',
    meta: { source: 'rule-based-fallback' },
  };
}

/** 剝掉 ```json 圍欄，抓出第一個 JSON 物件 */
function extractJson(text) {
  let s = String(text || '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('回應中找不到 JSON 物件');
  return JSON.parse(s.slice(start, end + 1));
}

/**
 * 把模型輸出修正成符合資料契約的樣子。
 * 模型偶爾會漏欄位、或在 low 的時候還是把 shouldNotify 設成 true，
 * 這些是產品規則，不能交給模型自由發揮。
 */
function normalizeDecision(raw, risk, routes) {
  const fb = fallbackDecision(risk, routes);
  const level = ['low', 'medium', 'high'].includes(raw.level) ? raw.level : risk.level;
  const str = (v, alt) => (typeof v === 'string' && v.trim() ? v.trim() : alt);

  return {
    level,
    shouldNotify: level === 'low' ? false : raw.shouldNotify !== false, // low 一定不打擾
    headline: str(raw.headline, fb.headline),
    action: str(raw.action, fb.action),
    reason: str(raw.reason, fb.reason),
    speech: str(raw.speech, fb.speech),
    meta: { source: 'gemini' },
  };
}

/* ────────────────────────── 呼叫 Gemini ──────────────────────────
 *
 * 兩條路，預設走 Vertex AI：
 *
 *   vertex   （預設）用 Application Default Credentials，不需要任何 API key。
 *            Cloud Functions 的執行服務帳號自帶 ADC，部署上去就能用；
 *            本機開發跑 `gcloud auth application-default login` 即可。
 *            需要：專案啟用 aiplatform.googleapis.com，
 *                 服務帳號有 roles/aiplatform.user。
 *
 *   aistudio 設了 GEMINI_API_KEY 就走這條（generativelanguage.googleapis.com）。
 *            沒有 GCP 專案權限時的後路。
 *
 * 用 GEMINI_BACKEND 可以強制指定。
 */

const DEFAULT_MODEL = 'gemini-3.1-flash-lite';
const DEFAULT_LOCATION = 'global'; // Vertex 的 global endpoint，模型可用性最完整

function geminiBackend() {
  const forced = String(process.env.GEMINI_BACKEND || '').toLowerCase();
  if (forced === 'vertex' || forced === 'aistudio') return forced;
  return process.env.GEMINI_API_KEY ? 'aistudio' : 'vertex';
}

/** Vertex 的 endpoint：global 沒有區域前綴，其他區域有 */
function vertexEndpoint(projectId, location, model) {
  const host =
    location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;
  return (
    `https://${host}/v1/projects/${projectId}/locations/${location}` +
    `/publishers/google/models/${model}:generateContent`
  );
}

/**
 * 組出送給模型的請求。抽成純函式，測試才能在不連網的情況下驗證
 * endpoint、認證標頭與 body 都對。
 */
function buildGeminiRequest({ backend, projectId, location, model, apiKey, risk, routes }) {
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts: [{ text: buildUserPrompt(risk, routes) }] }],
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 512,
      responseMimeType: 'application/json',
      thinkingConfig: { thinkingBudget: 0 }, // 關掉思考，換取穩定的低延遲
    },
  };

  if (backend === 'vertex') {
    if (!projectId) {
      throw new Error(
        'Vertex 需要專案 ID，但 ADC 與環境變數都取不到。' +
          '請設 GCLOUD_PROJECT，或改設 GEMINI_API_KEY 走 AI Studio。'
      );
    }
    return {
      url: vertexEndpoint(projectId, location, model),
      // Authorization 由 callGemini 帶入 ADC access token
      headers: { 'Content-Type': 'application/json' },
      body,
    };
  }

  if (!apiKey) throw new Error('GEMINI_API_KEY 未設定');
  return {
    url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body,
  };
}

// GoogleAuth 實例重複使用，token 會自己快取與更新，不必每次請求都重新取
let auth = null;
function getAuth() {
  if (!auth) {
    auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  }
  return auth;
}

/** 從 ADC 取 access token 與專案 ID */
async function getAdc() {
  const a = getAuth();
  const client = await a.getClient();
  const [token, projectId] = await Promise.all([
    client.getAccessToken(),
    a.getProjectId().catch(() => null),
  ]);
  const accessToken = typeof token === 'string' ? token : token && token.token;
  if (!accessToken) throw new Error('ADC 取不到 access token');
  return { accessToken, projectId };
}

async function callGemini(risk, routes) {
  const backend = geminiBackend();
  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const location = process.env.GEMINI_LOCATION || DEFAULT_LOCATION;

  let accessToken = null;
  let projectId =
    process.env.GEMINI_PROJECT_ID || process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;

  if (backend === 'vertex') {
    try {
      const adc = await getAdc();
      accessToken = adc.accessToken;
      projectId = projectId || adc.projectId;
    } catch (err) {
      throw new Error(
        `ADC 認證失敗：${err.message}。` +
          '本機請跑 gcloud auth application-default login；' +
          '部署後請確認服務帳號有 roles/aiplatform.user'
      );
    }
  }

  const req = buildGeminiRequest({
    backend,
    projectId,
    location,
    model,
    apiKey: process.env.GEMINI_API_KEY,
    risk,
    routes,
  });

  const headers = { ...req.headers };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  const data = await fetchWithTimeout(
    req.url,
    { method: 'POST', headers, body: JSON.stringify(req.body) },
    8000 // Gemini 給 8 秒（其他外部 API 是 5 秒）；失敗有規則式 fallback 兜底
  );

  const text = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  if (!text) throw new Error('Gemini 回應為空');
  return extractJson(text);
}

module.exports = {
  SYSTEM_PROMPT,
  buildUserPrompt,
  toChineseNumber,
  fallbackDecision,
  extractJson,
  normalizeDecision,
  callGemini,
  // 以下匯出供測試使用
  geminiBackend,
  vertexEndpoint,
  buildGeminiRequest,
};
