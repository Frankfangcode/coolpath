/** http.js — 三支 function 共用的請求/回應小工具 */

const TIMEOUT_MS = 5000; // 硬性限制 4：所有外部 API 5 秒逾時

function sendJson(res, status, payload) {
  res.set('Cache-Control', 'no-store');
  res.status(status).type('application/json; charset=utf-8');
  res.send(JSON.stringify(payload, null, 2)); // 縮排過，方便直接在瀏覽器投影展示
}

/** 帶逾時的 fetch，絕不讓外部 API 把 function 掛住 */
async function fetchWithTimeout(url, options = {}, timeoutMs = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${text.slice(0, 300)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** 接受 "lat,lng" 字串或 {lat,lng} 物件 */
function parseLatLng(input) {
  if (!input) return null;
  if (typeof input === 'object') {
    const lat = Number(input.lat ?? input.latitude);
    const lng = Number(input.lng ?? input.lon ?? input.longitude);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  }
  const parts = String(input).split(',');
  if (parts.length !== 2) return null;
  const lat = Number(parts[0].trim());
  const lng = Number(parts[1].trim());
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/** GET query 與 POST body 都吃 */
function readParams(req) {
  return { ...(req.query || {}), ...(typeof req.body === 'object' && req.body ? req.body : {}) };
}

const round1 = (n) => (n === null || n === undefined ? null : Math.round(n * 10) / 10);

module.exports = { TIMEOUT_MS, sendJson, fetchWithTimeout, parseLatLng, readParams, round1 };
