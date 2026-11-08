'use strict';
// Web worker: parses the file, packs it, draws the map on the transferred OffscreenCanvas and answers
// hit tests and table pages. The webview UI thread never touches the big data, so VS Code stays responsive.
const { loadGeo } = require('../core/load');
const { buildStore, columnsOf, filterIds, boxOf, fitBoxOf, hitTest, cell, unmercX, unmercY } = require('../core/store');
const { render, PALETTES } = require('../core/render');

let canvas = null, ctx = null, base = null, store = null, input = null, result = null, columns = [];
let filterKey = null, filtered = null;
let frames = 0, lastStats = null, lastView = null;

const post = (m, t) => self.postMessage(m, t || []);

function basemapStore(json) {
  const features = [];
  const layerOf = [];
  for (const c of json.countries) { features.push({ type: 'Feature', properties: { name: c.n }, geometry: { type: 'MultiPolygon', coordinates: c.p.map(poly => poly.map(r => pairs(r))) } }); layerOf.push('land'); }
  for (const l of json.lakes) { features.push({ type: 'Feature', properties: { name: l.n }, geometry: { type: 'MultiPolygon', coordinates: l.p.map(poly => poly.map(r => pairs(r))) } }); layerOf.push('lakes'); }
  return buildStore({ type: 'FeatureCollection', features }, { layerOf });
}
function pairs(flat) { const o = []; for (let i = 0; i < flat.length; i += 2) o.push([flat[i], flat[i + 1]]); return o; }

function summary(ms) {
  const r = result;
  const box = store.lonlatBox;
  return {
    type: 'loaded', ms,
    kind: r.kind, features: store.n, counts: store.counts, vertices: store.vertices, bad: store.bad,
    layers: store.layers, columns, lonlatBox: box, mercBox: boxOf(store, null), fitBox: fitBoxOf(store),
    crs: { name: r.transform.name, source: r.transform.source }, notes: r.notes, warnings: r.warnings, info: r.info,
    tracks: r.tracks.map(t => ({ id: t.id, name: String(t.name).slice(0, 120), points: t.points, distance: t.distance, duration: t.duration, moving: t.moving, gain: t.gain, loss: t.loss, minEle: t.minEle, maxEle: t.maxEle, hasEle: t.hasEle, profile: t.profile })),
    styled: store.styles.length,
  };
}

function load(crs) {
  const t0 = Date.now();
  result = null; store = null; filtered = null; filterKey = null;
  try {
    post({ type: 'progress', text: 'Reading the file...' });
    result = loadGeo({ ...input, crs });
    post({ type: 'progress', text: `Packing ${result.fc.features.length.toLocaleString('en-US')} features...` });
    store = buildStore(result.fc, { forward: result.transform.identity ? null : result.transform.forward, layerOf: result.layerOf });
    result.fc = null; // geometry is in the store now
    columns = columnsOf(store);
    if (!store.n) result.warnings.push('The file has no features.');
    else if (store.counts.empty === store.n) result.warnings.push('No feature has a geometry that can be drawn.');
    if (store.bad) result.warnings.push(`${store.bad.toLocaleString('en-US')} coordinates are not valid longitude/latitude (NaN, empty, or latitude beyond 90) and were left out.`);
    post(summary(Date.now() - t0));
  } catch (e) {
    post({ type: 'loadError', message: e && e.message ? e.message : String(e), ms: Date.now() - t0 });
  }
}

function draw(m) {
  if (!ctx) return;
  const v = m.view;
  const W = Math.max(1, Math.round(v.w * v.dpr)), H = Math.max(1, Math.round(v.h * v.dpr));
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  const pal = { ...(PALETTES[m.theme] || PALETTES.dark) };
  lastStats = render(ctx, { base, store, view: v, pal, hidden: new Set(m.hidden || []), selected: m.selected, basemap: m.basemap });
  lastView = v;
  frames++;
  post({ type: 'frame', seq: m.seq, stats: lastStats, frames });
}

function feature(id) {
  if (!store || id < 0 || id >= store.n) return null;
  const p = store.props[id];
  const entries = [];
  for (const k in p) { if (k === 'coordinateProperties') continue; entries.push([k, cell(p[k])]); if (entries.length >= 300) break; }
  const b = store.featBox;
  const box = Number.isFinite(b[id * 4]) ? [b[id * 4], b[id * 4 + 1], b[id * 4 + 2], b[id * 4 + 3]] : null;
  let kind = [];
  for (let s = store.featShape0[id]; s < store.featShape0[id + 1]; s++) kind.push(store.shapeKind[s]);
  kind = [...new Set(kind)].map(k => ['', 'Point', 'Line', 'Polygon'][k]).join(', ') || 'No geometry';
  const verts = store.partStart[store.shapePart0[store.featShape0[id + 1]]] - store.partStart[store.shapePart0[store.featShape0[id]]];
  return { id, name: store.names[id], entries, box, kind, vertices: verts, layer: store.layers[store.featLayer[id]].name };
}

/** The feature as GeoJSON in longitude/latitude, rebuilt from the store (for Copy). */
function featureGeojson(id) {
  const { coords, partStart, shapeKind, shapePart0, featShape0 } = store;
  const geoms = [];
  for (let s = featShape0[id]; s < featShape0[id + 1]; s++) {
    const parts = [];
    for (let p = shapePart0[s]; p < shapePart0[s + 1]; p++) {
      const ring = [];
      for (let i = partStart[p]; i < partStart[p + 1]; i++) ring.push([+unmercX(coords[i * 2]).toFixed(7), +unmercY(coords[i * 2 + 1]).toFixed(7)]);
      parts.push(ring);
    }
    const k = shapeKind[s];
    geoms.push(k === 1 ? { type: 'Point', coordinates: parts[0][0] } : k === 2 ? (parts.length === 1 ? { type: 'LineString', coordinates: parts[0] } : { type: 'MultiLineString', coordinates: parts }) : { type: 'Polygon', coordinates: parts });
  }
  const props = { ...store.props[id] };
  delete props.coordinateProperties;
  return { type: 'Feature', properties: props, geometry: geoms.length === 1 ? geoms[0] : geoms.length ? { type: 'GeometryCollection', geometries: geoms } : null };
}

self.onmessage = async ev => {
  const m = ev.data || {};
  try {
    switch (m.type) {
      case 'canvas': canvas = m.canvas; ctx = canvas.getContext('2d', { alpha: false }); break;
      case 'basemap': { const t0 = Date.now(); base = basemapStore(m.json); post({ type: 'basemapReady', ms: Date.now() - t0 }); break; }
      case 'load': input = { fmt: m.fmt, name: m.name, bytes: m.bytes, side: m.side || {} }; load(m.crs || ''); break;
      case 'reparse': if (input) load(m.crs || ''); break;
      case 'draw': draw(m); break;
      case 'hit': {
        const id = store ? hitTest(store, m.x, m.y, m.tol, new Set(m.hidden || [])) : -1;
        post({ type: 'hit', seq: m.seq, id, feature: id >= 0 ? feature(id) : null });
        break;
      }
      case 'feature': post({ type: 'feature', feature: feature(m.id), zoom: !!m.zoom }); break;
      case 'copyFeature': if (store && m.id >= 0 && m.id < store.n) post({ type: 'copyText', text: JSON.stringify(featureGeojson(m.id), null, 2), what: 'feature' }); break;
      case 'rows': {
        if (!store) break;
        const key = String(m.q || '');
        if (key !== filterKey) { filterKey = key; filtered = filterIds(store, key); }
        const ids = filtered.slice(m.start, m.start + m.count);
        const cols = columns.slice(0, 40);
        const rows = ids.map(i => [i, store.names[i], ...cols.map(c => cell(store.props[i][c]))]);
        post({ type: 'rows', seq: m.seq, start: m.start, total: filtered.length, cols, rows, q: key });
        break;
      }
      case 'fitFiltered': if (store && filtered) post({ type: 'box', box: boxOf(store, filtered.length > 200000 ? null : filtered) }); break;
      case 'png': {
        if (!canvas) break;
        const blob = await canvas.convertToBlob({ type: 'image/png' });
        const data = new Uint8Array(await blob.arrayBuffer());
        post({ type: 'png', data }, [data.buffer]);
        break;
      }
      case 'probe': {
        let ink = 0;
        if (ctx && canvas.width > 2) {
          const w = canvas.width, h = canvas.height;
          const img = ctx.getImageData(0, 0, w, h).data;
          const bg = [img[0], img[1], img[2]];
          let n = 0;
          for (let i = 0; i < img.length; i += 4 * 7) { n++; if (Math.abs(img[i] - bg[0]) + Math.abs(img[i + 1] - bg[1]) + Math.abs(img[i + 2] - bg[2]) > 30) ink++; }
          ink = ink / Math.max(1, n);
        }
        post({ type: 'probe', seq: m.seq, ink, frames, stats: lastStats, view: lastView, features: store ? store.n : 0 });
        break;
      }
      default: break;
    }
  } catch (e) {
    post({ type: 'workerError', message: e && e.message ? e.message : String(e), during: m.type });
  }
};
