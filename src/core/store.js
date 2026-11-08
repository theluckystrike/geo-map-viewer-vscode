'use strict';
// Packs GeoJSON features into flat typed arrays in Web Mercator units (0..1 for the whole world), so a
// 100 MB file draws, hit-tests and pans without walking JS objects. Pure: runs in the worker and in tests.

const MAX_LAT = 85.05112878;

class Grow {
  constructor(Type, n = 1024) { this.T = Type; this.a = new Type(n); this.n = 0; }
  push(v) { if (this.n === this.a.length) this.grow(); this.a[this.n++] = v; }
  push2(x, y) { if (this.n + 2 > this.a.length) this.grow(); this.a[this.n++] = x; this.a[this.n++] = y; }
  grow() { const b = new this.T(this.a.length * 2); b.set(this.a); this.a = b; }
  done() { return this.a.slice(0, this.n); }
}

function mercX(lon) { return (lon + 180) / 360; }
function mercY(lat) {
  const l = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI / 180;
  return (1 - Math.log(Math.tan(Math.PI / 4 + l / 2)) / Math.PI) / 2;
}
function unmercX(x) { return x * 360 - 180; }
function unmercY(y) { return Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI; }

const KIND = { point: 1, line: 2, polygon: 3 };
const okColor = c => (typeof c === 'string' && (/^#[0-9a-f]{3,8}$/i.test(c.trim()) || /^[a-z]{3,20}$/i.test(c.trim()) || /^rgba?\([\d\s.,%]+\)$/i.test(c.trim())) ? c.trim() : null);
const okNum = (v, lo, hi) => { const n = typeof v === 'string' ? Number(v) : v; return Number.isFinite(n) && n >= lo && n <= hi ? n : null; };

/** SimpleStyle (and the same keys that togeojson writes for KML styles). null = theme default. */
function styleOf(p) {
  if (!p || typeof p !== 'object') return null;
  const s = {
    stroke: okColor(p.stroke), sw: okNum(p['stroke-width'], 0, 50), so: okNum(p['stroke-opacity'], 0, 1),
    fill: okColor(p.fill), fo: okNum(p['fill-opacity'], 0, 1),
    mc: okColor(p['marker-color']) || okColor(p['icon-color']),
    ms: p['marker-size'] === 'small' ? 3 : p['marker-size'] === 'large' ? 7 : (okNum(p['icon-scale'], 0.1, 5) ? Math.round(5 * okNum(p['icon-scale'], 0.1, 5)) : null),
  };
  for (const k in s) if (s[k] !== null) return s;
  return null;
}

function nameOf(p, i) {
  if (p && typeof p === 'object') {
    for (const k of ['name', 'Name', 'NAME', 'title', 'Title', 'label', 'NAME_EN', 'name_en', 'ADMIN', 'admin', 'id', 'ID', 'fid', 'FID', 'OBJECTID']) {
      const v = p[k];
      if (v !== undefined && v !== null && v !== '' && typeof v !== 'object') return String(v).slice(0, 200);
    }
  }
  return `Feature ${i + 1}`;
}

/**
 * fc: GeoJSON FeatureCollection. opts: { forward(x, y) -> [lon, lat] | null (identity), layerOf: string[] | null,
 * layerByKind: boolean }
 * Returns the store; feature geometry objects are dropped as they are packed, so memory is freed early.
 */
function buildStore(fc, opts = {}) {
  const fwd = opts.forward || null;
  const coords = new Grow(Float64Array, 1 << 16);
  const elev = opts.keepZ ? new Grow(Float32Array, 1 << 15) : null;
  const partStart = new Grow(Int32Array, 1 << 12);
  const shapeKind = new Grow(Uint8Array, 1 << 12);
  const shapePart0 = new Grow(Int32Array, 1 << 12);
  const featShape0 = new Grow(Int32Array, 1 << 12);
  const featBox = new Grow(Float64Array, 1 << 12);
  const featLayer = new Grow(Uint16Array, 1 << 12);
  const featStyle = new Grow(Int32Array, 1 << 12);
  const props = [], names = [], styles = [], styleKeys = new Map();
  const layers = [], layerIdx = new Map();
  const counts = { point: 0, line: 0, polygon: 0, empty: 0 };
  let bad = 0, vertices = 0;
  let lonMin = Infinity, latMin = Infinity, lonMax = -Infinity, latMax = -Infinity;
  const features = Array.isArray(fc && fc.features) ? fc.features : [];

  const layerOfFeature = (i, kinds) => {
    let name;
    if (opts.layerOf) name = opts.layerOf[i] || '(top level)';
    else name = kinds.polygon ? 'Polygons' : kinds.line ? 'Lines' : kinds.point ? 'Points' : 'No geometry';
    let k = layerIdx.get(name);
    if (k === undefined) { k = layers.length; layerIdx.set(name, k); layers.push({ name, count: 0 }); }
    layers[k].count++;
    return k;
  };

  let bx0, by0, bx1, by1;
  const addPoint = (c) => {
    if (!Array.isArray(c) || c.length < 2) { bad++; return false; }
    let x = +c[0], y = +c[1];
    if (fwd) { const r = fwd(x, y); x = r[0]; y = r[1]; }
    if (!Number.isFinite(x) || !Number.isFinite(y) || y < -90 || y > 90 || x < -540 || x > 540) { bad++; return false; }
    if (x < lonMin) lonMin = x; if (x > lonMax) lonMax = x; if (y < latMin) latMin = y; if (y > latMax) latMax = y;
    const mx = mercX(x), my = mercY(y);
    coords.push2(mx, my);
    if (elev) elev.push(Number.isFinite(+c[2]) ? +c[2] : NaN);
    if (mx < bx0) bx0 = mx; if (mx > bx1) bx1 = mx; if (my < by0) by0 = my; if (my > by1) by1 = my;
    vertices++;
    return true;
  };
  const addPart = (ring, min) => {
    if (!Array.isArray(ring)) return false;
    const start = coords.n / 2;
    for (let i = 0; i < ring.length; i++) addPoint(ring[i]);
    const n = coords.n / 2 - start;
    if (n < min) { coords.n = start * 2; if (elev) elev.n = start; return false; }
    partStart.push(start);
    return true;
  };
  const addShape = (kind, parts, min) => {
    const p0 = partStart.n;
    let any = false;
    for (const r of parts) if (addPart(r, min)) any = true;
    if (!any) return false;
    shapeKind.push(kind); shapePart0.push(p0);
    return true;
  };
  const addGeom = (g, kinds, depth) => {
    if (!g || typeof g !== 'object' || depth > 8) return;
    const c = g.coordinates;
    switch (g.type) {
      case 'Point': if (addShape(KIND.point, [[c]], 1)) kinds.point = 1; break;
      case 'MultiPoint': if (Array.isArray(c)) for (const p of c) if (addShape(KIND.point, [[p]], 1)) kinds.point = 1; break;
      case 'LineString': if (addShape(KIND.line, [c], 2)) kinds.line = 1; break;
      case 'MultiLineString': if (Array.isArray(c) && addShape(KIND.line, c, 2)) kinds.line = 1; break;
      case 'Polygon': if (Array.isArray(c) && addShape(KIND.polygon, c, 3)) kinds.polygon = 1; break;
      case 'MultiPolygon': if (Array.isArray(c)) for (const poly of c) if (Array.isArray(poly) && addShape(KIND.polygon, poly, 3)) kinds.polygon = 1; break;
      case 'GeometryCollection': if (Array.isArray(g.geometries)) for (const s of g.geometries) addGeom(s, kinds, depth + 1); break;
      default: break;
    }
  };

  for (let i = 0; i < features.length; i++) {
    const f = features[i];
    const geom = f && (f.type === 'Feature' ? f.geometry : f.type ? f : null);
    const p = f && f.type === 'Feature' && f.properties && typeof f.properties === 'object' ? f.properties : {};
    bx0 = Infinity; by0 = Infinity; bx1 = -Infinity; by1 = -Infinity;
    featShape0.push(shapeKind.n);
    const kinds = {};
    addGeom(geom, kinds, 0);
    if (kinds.point) counts.point++; if (kinds.line) counts.line++; if (kinds.polygon) counts.polygon++;
    if (!kinds.point && !kinds.line && !kinds.polygon) { counts.empty++; bx0 = by0 = bx1 = by1 = NaN; }
    featBox.push(bx0); featBox.push(by0); featBox.push(bx1); featBox.push(by1);
    featLayer.push(layerOfFeature(i, kinds));
    const st = styleOf(p);
    if (st) {
      const key = JSON.stringify(st);
      let k = styleKeys.get(key);
      if (k === undefined) { k = styles.length; styles.push(st); styleKeys.set(key, k); }
      featStyle.push(k);
    } else featStyle.push(-1);
    if (f && f.id !== undefined && p.id === undefined) p['@id'] = f.id;
    props.push(p);
    names.push(nameOf(p, i));
    if (f && f.type === 'Feature' && opts.dropGeometry !== false) f.geometry = null;
  }
  featShape0.push(shapeKind.n);
  shapePart0.push(partStart.n);
  partStart.push(coords.n / 2);
  const n = props.length;
  return {
    n, coords: coords.done(), elev: elev ? elev.done() : null, partStart: partStart.done(), shapeKind: shapeKind.done(), shapePart0: shapePart0.done(),
    featShape0: featShape0.done(), featBox: featBox.done(), featLayer: featLayer.done(), featStyle: featStyle.done(),
    props, names, styles, layers, counts, bad, vertices,
    lonlatBox: Number.isFinite(lonMin) ? [lonMin, latMin, lonMax, latMax] : null,
  };
}

/** Union of property keys (first 5,000 features), capped at maxCols, in first-seen order. */
function columnsOf(store, maxCols = 60) {
  const seen = new Map();
  const lim = Math.min(store.n, 5000);
  for (let i = 0; i < lim; i++) {
    const p = store.props[i];
    for (const k in p) { if (k === 'coordinateProperties' || k === 'styleUrl' || k === 'styleHash' || k === 'styleMapHash') continue; if (!seen.has(k)) seen.set(k, seen.size); if (seen.size >= maxCols) break; }
    if (seen.size >= maxCols) break;
  }
  return [...seen.keys()];
}

function cell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') { try { const s = JSON.stringify(v); return s.length > 200 ? s.slice(0, 197) + '...' : s; } catch { return '[object]'; } }
  const s = String(v);
  return s.length > 200 ? s.slice(0, 197) + '...' : s;
}

/** Feature ids whose name or any property value contains q (case-insensitive). */
function filterIds(store, q, limit = 5000000) {
  const t = String(q || '').trim().toLowerCase();
  const out = [];
  for (let i = 0; i < store.n && out.length < limit; i++) {
    if (!t) { out.push(i); continue; }
    if (store.names[i].toLowerCase().includes(t)) { out.push(i); continue; }
    const p = store.props[i];
    for (const k in p) { const v = p[k]; if (v !== null && typeof v !== 'object' && String(v).toLowerCase().includes(t)) { out.push(i); break; } }
  }
  return out;
}

/** Union bbox (mercator) of the given features, or of all when ids is null. */
function boxOf(store, ids) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const each = i => {
    const b = store.featBox;
    if (!Number.isFinite(b[i * 4])) return;
    if (b[i * 4] < x0) x0 = b[i * 4]; if (b[i * 4 + 1] < y0) y0 = b[i * 4 + 1];
    if (b[i * 4 + 2] > x1) x1 = b[i * 4 + 2]; if (b[i * 4 + 3] > y1) y1 = b[i * 4 + 3];
  };
  if (ids) for (const i of ids) each(i); else for (let i = 0; i < store.n; i++) each(i);
  return Number.isFinite(x0) ? [x0, y0, x1, y1] : null;
}

/**
 * Box to fit when the map opens. When the data spans more than half the world (for example Alaska's Aleutians
 * cross the antimeridian), fit the central 96% of feature centres instead, so the bulk of the data fills the view.
 */
function fitBoxOf(store) {
  const all = boxOf(store, null);
  if (!all || all[2] - all[0] <= 0.5 || store.n < 10) return all;
  const xs = [], ys = [];
  const b = store.featBox;
  for (let i = 0; i < store.n; i++) if (Number.isFinite(b[i * 4])) { xs.push((b[i * 4] + b[i * 4 + 2]) / 2); ys.push((b[i * 4 + 1] + b[i * 4 + 3]) / 2); }
  xs.sort((p, q) => p - q); ys.sort((p, q) => p - q);
  const q = (a, f) => a[Math.min(a.length - 1, Math.max(0, Math.round(f * (a.length - 1))))];
  const box = [q(xs, 0.02), q(ys, 0.02), q(xs, 0.98), q(ys, 0.98)];
  return box[2] - box[0] < (all[2] - all[0]) * 0.8 ? box : all;
}

function distSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l = dx * dx + dy * dy;
  let t = l ? ((px - ax) * dx + (py - ay) * dy) / l : 0;
  t = Math.max(0, Math.min(1, t));
  const x = ax + t * dx - px, y = ay + t * dy - py;
  return Math.sqrt(x * x + y * y);
}

/**
 * Feature under the point (mercator x, y) with tolerance tol (mercator units). Priority: a point or line within
 * tol, then the smallest polygon that contains the point, then a polygon edge within tol (for polygons too small
 * to click inside). hidden: Set of hidden layer indexes.
 */
function hitTest(store, x, y, tol, hidden) {
  const { coords, partStart, shapeKind, shapePart0, featShape0, featBox, featLayer } = store;
  let best = -1, bestD = Infinity, bestPoly = -1, bestArea = Infinity, bestEdge = -1, edgeD = Infinity;
  for (let f = store.n - 1; f >= 0; f--) {
    if (hidden && hidden.has(featLayer[f])) continue;
    const b = f * 4;
    if (!(x >= featBox[b] - tol && x <= featBox[b + 2] + tol && y >= featBox[b + 1] - tol && y <= featBox[b + 3] + tol)) continue;
    for (let s = featShape0[f]; s < featShape0[f + 1]; s++) {
      const k = shapeKind[s];
      let inside = false;
      for (let p = shapePart0[s]; p < shapePart0[s + 1]; p++) {
        const a = partStart[p], e = partStart[p + 1];
        if (k === 1) {
          const d = Math.hypot(coords[a * 2] - x, coords[a * 2 + 1] - y);
          if (d <= tol && d < bestD) { bestD = d; best = f; }
          continue;
        }
        for (let i = a; i < e - 1; i++) {
          const d = distSeg(x, y, coords[i * 2], coords[i * 2 + 1], coords[i * 2 + 2], coords[i * 2 + 3]);
          if (d <= tol) {
            if (k === 2) { if (d < bestD) { bestD = d; best = f; } } else if (d < edgeD) { edgeD = d; bestEdge = f; }
          }
        }
        if (k === 3) {
          for (let i = a, j = e - 1; i < e; j = i++) {
            const xi = coords[i * 2], yi = coords[i * 2 + 1], xj = coords[j * 2], yj = coords[j * 2 + 1];
            if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
          }
        }
      }
      if (inside) {
        const area = (featBox[b + 2] - featBox[b]) * (featBox[b + 3] - featBox[b + 1]);
        if (area < bestArea) { bestArea = area; bestPoly = f; }
      }
    }
  }
  return best >= 0 ? best : bestPoly >= 0 ? bestPoly : bestEdge;
}

module.exports = { buildStore, columnsOf, filterIds, boxOf, fitBoxOf, hitTest, cell, styleOf, nameOf, mercX, mercY, unmercX, unmercY, KIND, MAX_LAT };
