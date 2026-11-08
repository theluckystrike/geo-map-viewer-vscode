'use strict';
// Track statistics for GPX tracks and any line with elevation: distance, duration, moving time,
// elevation gain and loss, and a downsampled elevation profile.

const R = 6371008.8; // mean Earth radius in metres (IUGG)
const MOVING_MPS = 1000 / 3600; // below 1 km/h counts as stopped (the gpxpy default)

function haversine(lon1, lat1, lon2, lat2) {
  const toR = Math.PI / 180;
  const dLat = (lat2 - lat1) * toR, dLon = (lon2 - lon1) * toR;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function parseTime(t) {
  if (t == null || t === '') return NaN;
  const v = typeof t === 'number' ? t : Date.parse(t);
  return Number.isFinite(v) ? v : NaN;
}

/**
 * segments: array of coordinate arrays [[lon, lat, ele?], ...]; times: matching arrays of ISO strings (or empty).
 * Returns { points, distance (m), duration (s) | null, moving (s) | null, gain, loss, minEle, maxEle, hasEle, profile: [[d, ele], ...] }.
 */
function trackStats(segments, times, maxProfile = 600) {
  let distance = 0, moving = 0, gain = 0, loss = 0, points = 0, tMin = Infinity, tMax = -Infinity;
  let minEle = Infinity, maxEle = -Infinity, hasEle = false;
  const prof = [];
  segments.forEach((seg, si) => {
    const ts = (times && times[si]) || [];
    let prev = null, prevT = NaN;
    for (let i = 0; i < seg.length; i++) {
      const c = seg[i];
      if (!c || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) continue;
      points++;
      const ele = Number.isFinite(c[2]) ? c[2] : NaN;
      const t = parseTime(ts[i]);
      if (Number.isFinite(t)) { if (t < tMin) tMin = t; if (t > tMax) tMax = t; }
      if (prev) {
        const d = haversine(prev[0], prev[1], c[0], c[1]);
        distance += d;
        if (Number.isFinite(t) && Number.isFinite(prevT) && t > prevT) {
          // Moving speed uses the 3D step (climbing slowly is still moving), as gpxpy does.
          const de = Number.isFinite(ele) && Number.isFinite(prev[2]) ? ele - prev[2] : 0;
          const dt = (t - prevT) / 1000;
          if (Math.sqrt(d * d + de * de) / dt > MOVING_MPS) moving += dt;
        }
        if (Number.isFinite(ele) && Number.isFinite(prev[2])) {
          const de = ele - prev[2];
          if (de > 0) gain += de; else loss -= de;
        }
      }
      if (Number.isFinite(ele)) { hasEle = true; if (ele < minEle) minEle = ele; if (ele > maxEle) maxEle = ele; prof.push([distance, ele]); }
      prev = c; prevT = t;
    }
  });
  let profile = prof;
  if (prof.length > maxProfile) {
    profile = [];
    const step = prof.length / maxProfile;
    for (let i = 0; i < maxProfile; i++) profile.push(prof[Math.floor(i * step)]);
    profile.push(prof[prof.length - 1]);
  }
  return {
    // duration is the elapsed time from the first to the last time stamp (pauses between segments included)
    points, distance, duration: tMax > tMin ? (tMax - tMin) / 1000 : null, moving: tMax > tMin ? moving : null,
    gain: hasEle ? gain : null, loss: hasEle ? loss : null,
    minEle: hasEle ? minEle : null, maxEle: hasEle ? maxEle : null, hasEle, profile,
  };
}

function fmtDistance(m) {
  if (!Number.isFinite(m)) return '-';
  return m >= 1000 ? `${(m / 1000).toFixed(m >= 100000 ? 0 : 2)} km` : `${Math.round(m)} m`;
}

function fmtDuration(s) {
  if (s == null || !Number.isFinite(s)) return '-';
  const h = Math.floor(s / 3600), mi = Math.floor((s % 3600) / 60), se = Math.round(s % 60);
  return h ? `${h} h ${String(mi).padStart(2, '0')} min` : `${mi} min ${String(se).padStart(2, '0')} s`;
}

module.exports = { trackStats, haversine, fmtDistance, fmtDuration, R, MOVING_MPS };
