/**
 * geo.js — polyline 解碼與沿線取樣的幾何工具
 * （指令包的結構只列了 lst.js，這裡把純幾何邏輯抽出來，避免 index.js 變成一坨）
 */

/** Google encoded polyline algorithm format，precision 5 */
function decodePolyline(encoded) {
  const points = [];
  if (typeof encoded !== 'string' || encoded.length === 0) return points;

  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let b;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 0;
    shift = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    points.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return points;
}

/** 兩點間公尺距離（haversine） */
function haversineM(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** polyline 總長度（公尺） */
function pathLengthM(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += haversineM(points[i - 1], points[i]);
  return total;
}

/**
 * 沿路徑等距重新取樣。polyline 的原始頂點是「轉彎處」，密度不均，
 * 直接拿來平均會讓彎多的路段被過度加權，所以要等距化。
 * @param {Array<{lat,lng}>} points
 * @param {number} intervalM 取樣間距（公尺）
 * @returns {Array<{lat,lng}>} 含頭尾
 */
function resample(points, intervalM) {
  if (points.length === 0) return [];
  if (points.length === 1) return [points[0]];

  const out = [points[0]];
  let carry = 0; // 上一段剩下沒走完的距離

  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const segLen = haversineM(a, b);
    if (segLen === 0) continue;

    let dist = intervalM - carry;
    while (dist <= segLen) {
      const f = dist / segLen;
      out.push({ lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f });
      dist += intervalM;
    }
    carry = (carry + segLen) % intervalM;
  }

  const last = points[points.length - 1];
  const tail = out[out.length - 1];
  if (haversineM(tail, last) > intervalM / 2) out.push(last);
  return out;
}

/**
 * 從路徑上依累積距離均勻取 n 個中繼點（不含頭尾）。
 * 給 Google Maps URL 的 waypoints 用 —— 中繼點決定 Google 會不會重現我們算的那條路。
 * @param {Array<{lat,lng}>} points
 * @param {number} n
 */
function pickWaypoints(points, n) {
  if (points.length < 3 || n < 1) return [];
  const total = pathLengthM(points);
  if (total === 0) return [];

  const targets = [];
  for (let k = 1; k <= n; k++) targets.push((total * k) / (n + 1));

  const picked = [];
  let acc = 0;
  let ti = 0;

  for (let i = 1; i < points.length && ti < targets.length; i++) {
    const segLen = haversineM(points[i - 1], points[i]);
    while (ti < targets.length && acc + segLen >= targets[ti]) {
      const f = segLen === 0 ? 0 : (targets[ti] - acc) / segLen;
      const a = points[i - 1];
      const b = points[i];
      picked.push({ lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f });
      ti++;
    }
    acc += segLen;
  }
  return picked;
}

module.exports = { decodePolyline, haversineM, pathLengthM, resample, pickWaypoints };
