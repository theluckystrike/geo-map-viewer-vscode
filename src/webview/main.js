'use strict';
// Webview UI: toolbar, map stage, side panel (file, CRS, layers, tracks, selected feature) and attribute table.
// All parsing and drawing runs in a worker (see worker.js) on an OffscreenCanvas. Nothing here goes online:
// the CSP allows no remote origin, and the basemap ships inside the extension.
import WORKER_SOURCE from 'worker-source';
const { unmercX, unmercY, mercX, mercY } = require('../core/store');
const { fmtDistance, fmtDuration } = require('../core/stats');

/* global acquireVsCodeApi */
const vscode = acquireVsCodeApi();
const saved = vscode.getState() || {};
const $ = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids) if (c != null) e.append(c);
  return e;
};
const toU8 = v => (v instanceof Uint8Array ? v : v instanceof ArrayBuffer ? new Uint8Array(v) : ArrayBuffer.isView(v) ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : Array.isArray(v) ? Uint8Array.from(v) : v && v.type === 'Buffer' && Array.isArray(v.data) ? Uint8Array.from(v.data) : null);
const fmtInt = n => Number(n || 0).toLocaleString('en-US');

const S = {
  name: '', fmt: '', sizeText: '', loaded: false, error: null, sum: null,
  view: null, selected: -1, hidden: new Set(saved.hidden || []), basemap: saved.basemap !== false,
  showTable: !!saved.showTable, showSide: saved.showSide !== false, theme: 'dark', crsText: '',
  seq: 0, inflight: false, pending: false, rendered: null, sentViews: new Map(), frames: 0, lastStats: null,
  firstFrameAt: 0, t0: performance.now(), loadMs: 0, reportedRender: false, basemapReady: false, track: -1,
  tableQ: '', tableTotal: 0, tableCols: [], rowsSeq: 0, probeWaiters: new Map(),
};

/* ---------- layout ---------- */
const app = document.getElementById('app');
app.textContent = '';
const btn = (text, title, on, attrs = {}) => $('button', { type: 'button', title, onclick: on, ...attrs }, text);
const ui = {};
ui.fit = btn('Fit all', 'Zoom to all features (0)', () => fitAll());
ui.fitSel = btn('Zoom to selection', 'Zoom to the selected feature (F)', () => fitSelected(), { disabled: true });
ui.base = btn('Basemap', 'Show or hide the offline basemap (B)', () => { S.basemap = !S.basemap; syncToggles(); persist(); requestDraw(); });
ui.table = btn('Table', 'Show or hide the attribute table (T)', () => { S.showTable = !S.showTable; syncToggles(); persist(); layout(); });
ui.side = btn('Panel', 'Show or hide the side panel (P)', () => { S.showSide = !S.showSide; syncToggles(); persist(); layout(); });
ui.png = btn('Export PNG', 'Save the current map view as a PNG image', () => { ui.png.disabled = true; worker.postMessage({ type: 'png' }); });
ui.reload = btn('Reload', 'Read the file again', () => vscode.postMessage({ type: 'reload' }));
const toolbar = $('div', { class: 'toolbar', role: 'toolbar' }, ui.fit, ui.fitSel, $('span', { class: 'sep' }), ui.base, ui.table, ui.side,
  $('span', { class: 'sep' }), ui.png, ui.reload, $('span', { class: 'grow' }), ui.fileinfo = $('span', { class: 'fileinfo' }));
ui.canvas = $('canvas', { tabindex: '0', 'aria-label': 'Map. Drag to pan, scroll to zoom, click a feature to see its properties.' });
ui.notice = $('div', { class: 'notice', hidden: true, role: 'status' });
ui.stage = $('div', { class: 'stage' }, ui.canvas, ui.notice);
ui.tableFilter = $('input', { type: 'search', placeholder: 'Filter rows (any value)', 'aria-label': 'Filter rows', spellcheck: 'false' });
ui.tableCount = $('span', { class: 'count' });
ui.tableFit = btn('Zoom to rows', 'Zoom to the filtered rows', () => worker.postMessage({ type: 'fitFiltered' }));
ui.tableWrap = $('div', { class: 'tablewrap', tabindex: '0' });
ui.tableSizer = $('div', { class: 'sizer' });
ui.tableInner = $('table', { class: 'grid' });
ui.tableHead = $('div', { class: 'thead' });
ui.tableWrap.append(ui.tableSizer, ui.tableInner);
ui.tablePanel = $('div', { class: 'tablepanel', hidden: true }, $('div', { class: 'tablebar' }, ui.tableFilter, ui.tableCount, ui.tableFit), ui.tableHead, ui.tableWrap);
ui.mapcol = $('div', { class: 'mapcol' }, ui.stage, ui.tablePanel);
ui.sideEl = $('div', { class: 'side' });
ui.main = $('div', { class: 'main' }, ui.mapcol, ui.sideEl);
ui.coords = $('button', { class: 'coords', title: 'Click to copy the coordinates under the cursor' }, '');
ui.hint = $('span', { class: 'hint' }, 'Opening the file...');
ui.timing = $('span', { class: 'timing' });
ui.status = $('div', { class: 'status' }, ui.coords, ui.hint, $('span', { class: 'grow' }), ui.timing);
app.append(toolbar, ui.main, ui.status);
const supportLine = document.getElementById('zovo-support');
if (supportLine) { supportLine.classList.remove('zovo-support-fixed'); ui.status.append(supportLine); }

function syncToggles() {
  ui.base.setAttribute('aria-pressed', String(S.basemap));
  ui.table.setAttribute('aria-pressed', String(S.showTable));
  ui.side.setAttribute('aria-pressed', String(S.showSide));
}
syncToggles();

function persist() { vscode.setState({ hidden: [...S.hidden], basemap: S.basemap, showTable: S.showTable, showSide: S.showSide, view: S.view }); }

function notice(text, kind) {
  ui.notice.hidden = !text;
  ui.notice.textContent = text || '';
  ui.notice.className = 'notice' + (kind ? ' ' + kind : '');
}

/* ---------- theme ---------- */
function themeKind() {
  const c = document.body.classList;
  return c.contains('vscode-light') || c.contains('vscode-high-contrast-light') ? 'light' : 'dark';
}
S.theme = themeKind();
new MutationObserver(() => { const t = themeKind(); if (t !== S.theme) { S.theme = t; requestDraw(); drawProfile(); } }).observe(document.body, { attributes: true, attributeFilter: ['class'] });

/* ---------- worker ---------- */
const worker = new Worker(URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' })));
const off = ui.canvas.transferControlToOffscreen();
worker.postMessage({ type: 'canvas', canvas: off }, [off]);

worker.onmessage = ev => {
  const m = ev.data;
  switch (m.type) {
    case 'progress': if (!S.loaded) { notice(m.text); ui.hint.textContent = m.text; } break;
    case 'basemapReady': S.basemapReady = true; requestDraw(); break;
    case 'loaded': onLoaded(m); break;
    case 'loadError': onError(m.message); break;
    case 'frame': onFrame(m); break;
    case 'hit': select(m.id, m.feature, false); break;
    case 'feature': select(m.feature ? m.feature.id : -1, m.feature, m.zoom); break;
    case 'rows': onRows(m); break;
    case 'box': if (m.box) fitBox(m.box); break;
    case 'png': ui.png.disabled = false; vscode.postMessage({ type: 'png', data: m.data }); break;
    case 'copyText': vscode.postMessage({ type: 'copy', text: m.text }); flash(m.what === 'feature' ? 'Feature copied as GeoJSON.' : 'Copied.'); break;
    case 'probe': { const r = S.probeWaiters.get(m.seq); if (r) { S.probeWaiters.delete(m.seq); r(m); } break; }
    case 'workerError': ui.hint.textContent = `Error (${m.during}): ${m.message}`; if (m.during === 'png') ui.png.disabled = false; break;
    default: break;
  }
};
worker.onerror = e => onError(`The map worker stopped: ${e.message || 'unknown error'}`);

/* ---------- host messages ---------- */
window.addEventListener('message', ev => {
  const m = ev.data;
  if (!m || typeof m !== 'object') return;
  switch (m.type) {
    case 'init':
      S.name = m.name; S.fmt = m.format; S.sizeText = m.sizeText;
      ui.fileinfo.textContent = `${m.label} · ${m.sizeText}`;
      if (m.basemapDefault === false && saved.basemap === undefined) { S.basemap = false; syncToggles(); }
      if (!m.plan.load) { onError(m.plan.message, 'big'); return; }
      if (m.plan.large) notice(`Opening a ${m.sizeText} file. The map stays usable while it loads.`);
      loadBasemap(m.basemapUrl);
      break;
    case 'bytes': {
      S.bytesCount = (S.bytesCount || 0) + 1;
      S.t0 = performance.now();
      const reload = S.loaded;
      S.keepView = reload && !!S.view;
      S.loaded = false; S.error = null;
      // Bytes can arrive as a Uint8Array view on a bigger buffer; send each as its own buffer and transfer it.
      const own = v => { const u = toU8(v); return u && (u.byteOffset || u.byteLength !== u.buffer.byteLength) ? u.slice() : u; };
      const data = own(m.data);
      if (!data) { S.dbg = Object.prototype.toString.call(m.data) + ' ' + (m.data && m.data.constructor && m.data.constructor.name) ; onError('The file could not be read.'); break; }
      const side = {};
      for (const [k, v] of Object.entries(m.side || {})) side[k] = typeof v === 'string' ? v : own(v);
      const transfer = [data.buffer, ...Object.values(side).filter(v => v instanceof Uint8Array).map(v => v.buffer)];
      worker.postMessage({ type: 'load', fmt: S.fmt, name: S.name, bytes: data, side, crs: S.crsText }, transfer);
      ui.hint.textContent = reload ? 'Reloading...' : 'Reading the file...';
      break;
    }
    case 'error': if (m.soft) flash(m.message); else onError(m.message); break;
    case 'saved': flash(m.cancelled ? 'Not saved.' : `Saved ${m.path}`); break;
    case 'copied': break;
    default: break;
  }
});

async function loadBasemap(url) {
  try {
    const json = await (await fetch(url)).json();
    worker.postMessage({ type: 'basemap', json });
  } catch (e) {
    ui.hint.textContent = 'The basemap could not be read; the data still draws.';
  }
}

/* ---------- view ---------- */
const MIN_SCALE = 128, MAX_SCALE = 256 * Math.pow(2, 26);
function size() { const r = ui.stage.getBoundingClientRect(); return { w: Math.max(1, Math.floor(r.width)), h: Math.max(1, Math.floor(r.height)) }; }
function clampView(v) {
  v.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, v.scale));
  v.cy = Math.max(-0.2, Math.min(1.2, v.cy));
  v.cx = Math.max(-1, Math.min(2, v.cx));
  return v;
}
function fitBox(b, pad = 32, auto = false) {
  const { w, h } = size();
  // Fits made by the viewer (on open) follow later resizes until the user moves the map, so a tab that opens
  // while its editor group is still being laid out (width 0) does not stay at the smallest zoom.
  S.autoFit = auto ? { b, pad } : null;
  if (w < 40 || h < 40) { S.autoFit = { b, pad }; return; }
  const bw = Math.max(b[2] - b[0], 1e-12), bh = Math.max(b[3] - b[1], 1e-12);
  let scale = Math.min((w - pad * 2) / bw, (h - pad * 2) / bh);
  if (!Number.isFinite(scale) || bw < 1e-9 && bh < 1e-9) scale = 256 * Math.pow(2, 15);
  scale = Math.min(scale, 256 * Math.pow(2, 18));
  S.view = clampView({ cx: (b[0] + b[2]) / 2, cy: (b[1] + b[3]) / 2, scale });
  persist(); requestDraw();
}
function fitAll(auto = false) {
  if (S.sum && (S.sum.fitBox || S.sum.mercBox)) fitBox(S.sum.fitBox || S.sum.mercBox, 32, auto); else fitBox([0, 0.15, 1, 0.85], 8, auto);
}
function fitSelected() { if (S.selFeature && S.selFeature.box) fitBox(S.selFeature.box, 60); }

function viewMsg() {
  const { w, h } = size();
  return { cx: S.view.cx, cy: S.view.cy, scale: S.view.scale, w, h, dpr: Math.min(2, window.devicePixelRatio || 1) };
}
function requestDraw() {
  if (!S.view) return;
  if (S.inflight) { S.pending = true; applyPreview(); return; }
  S.inflight = true; S.pending = false;
  const seq = ++S.seq;
  const v = viewMsg();
  S.sentViews.set(seq, v);
  worker.postMessage({ type: 'draw', seq, view: v, theme: S.theme, hidden: [...S.hidden], selected: S.selected, basemap: S.basemap && S.basemapReady });
  applyPreview();
}
/** While the worker draws, move the last frame with a CSS transform, so panning and zooming feel instant. */
function applyPreview() {
  const r = S.rendered, v = S.view;
  if (!r || !v) { ui.canvas.style.transform = ''; return; }
  const k = v.scale / r.scale;
  const tx = (r.w / 2) * (1 - k) + (r.cx - v.cx) * v.scale + (size().w - r.w) / 2;
  const ty = (r.h / 2) * (1 - k) + (r.cy - v.cy) * v.scale + (size().h - r.h) / 2;
  ui.canvas.style.transform = Math.abs(k - 1) < 1e-9 && Math.abs(tx) < 0.01 && Math.abs(ty) < 0.01 ? '' : `translate(${tx}px, ${ty}px) scale(${k})`;
}
function onFrame(m) {
  S.inflight = false;
  const v = S.sentViews.get(m.seq);
  S.sentViews.delete(m.seq);
  if (v) { S.rendered = v; ui.canvas.style.width = v.w + 'px'; ui.canvas.style.height = v.h + 'px'; }
  S.frames = m.frames; S.lastStats = m.stats;
  requestAnimationFrame(applyPreview);
  if (S.loaded && !S.firstFrameAt) {
    S.firstFrameAt = performance.now();
    ui.timing.textContent = `${(S.loadMs / 1000).toFixed(2)} s to read · ${(m.stats.ms)} ms to draw`;
    if (!S.reportedRender) { S.reportedRender = true; vscode.postMessage({ type: 'rendered', ok: true, features: S.sum.features }); }
  }
  if (S.pending) requestDraw();
}

/* ---------- loaded ---------- */
function onLoaded(m) {
  S.sum = m; S.loaded = true; S.error = null; S.loadMs = performance.now() - S.t0; S.firstFrameAt = 0;
  notice('');
  for (const h of [...S.hidden]) if (h >= m.layers.length) S.hidden.delete(h);
  if (S.selected >= m.features) S.selected = -1;
  if (!S.keepView) { S.view = null; if (saved.view && saved.view.scale && !S.restored) { S.restored = true; S.view = clampView({ ...saved.view }); } }
  if (!S.view) fitAll(true); else requestDraw();
  S.keepView = false;
  ui.hint.textContent = m.features ? 'Drag to pan, scroll to zoom, click a feature for its properties.' : 'The file has no features.';
  if (!m.features || m.counts.empty === m.features) notice(m.warnings.join('\n') || 'Nothing to draw.', 'big');
  renderSide();
  S.tableQ = ui.tableFilter.value;
  if (S.showTable) requestRows(true);
  layout();
  if (S.track < 0 && m.tracks.length) S.track = 0;
  drawProfile();
}

function onError(message, kind = 'error') {
  S.error = message; S.loaded = false;
  notice(message, kind);
  ui.hint.textContent = kind === 'big' ? 'File not opened.' : 'The file could not be opened.';
  if (!S.reportedRender) { S.reportedRender = true; vscode.postMessage({ type: 'rendered', ok: false }); }
  if (!S.view) fitBox([0, 0.15, 1, 0.85], 8, true);
  renderSide();
}

let flashTimer = 0;
function flash(text) {
  const prev = ui.hint.dataset.prev || ui.hint.textContent;
  ui.hint.dataset.prev = prev;
  ui.hint.textContent = text;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { ui.hint.textContent = ui.hint.dataset.prev; delete ui.hint.dataset.prev; }, 3500);
}

/* ---------- side panel ---------- */
function kv(k, v) { return $('div', { class: 'row' }, $('span', { class: 'k' }, k), $('span', { class: 'v' }, v)); }
function section(title, ...kids) { return $('section', {}, $('h2', {}, title), ...kids); }

function renderSide() {
  const el = ui.sideEl;
  el.textContent = '';
  const m = S.sum;
  if (!m) {
    el.append(section('File', kv('Name', S.name || '-'), kv('Size', S.sizeText || '-')), crsBox());
    return;
  }
  const c = m.counts;
  const geo = [c.point && `${fmtInt(c.point)} point`, c.line && `${fmtInt(c.line)} line`, c.polygon && `${fmtInt(c.polygon)} polygon`, c.empty && `${fmtInt(c.empty)} empty`].filter(Boolean).join(', ');
  const b = m.lonlatBox;
  el.append(section('File',
    kv('Name', S.name), kv('Format', m.kind), kv('Size', S.sizeText), kv('Features', fmtInt(m.features)), kv('Geometry', geo || '-'),
    kv('Vertices', fmtInt(m.vertices)),
    b ? kv('Extent', `${b[1].toFixed(4)}, ${b[0].toFixed(4)} to ${b[3].toFixed(4)}, ${b[2].toFixed(4)}`) : null,
    kv('Read in', `${(S.loadMs / 1000).toFixed(2)} s`)));
  el.append(crsBox());
  const msgs = [...m.warnings.map(t => ['warn', t]), ...m.notes.map(t => ['note', t])];
  if (msgs.length) el.append(section('Notes', ...msgs.map(([k, t]) => $('p', { class: 'msg ' + k }, t))));
  if (m.layers.length) {
    el.append(section('Layers', ...m.layers.map((l, i) => {
      const cb = $('input', { type: 'checkbox', 'aria-label': `Show layer ${l.name}` });
      cb.checked = !S.hidden.has(i);
      cb.addEventListener('change', () => { if (cb.checked) S.hidden.delete(i); else S.hidden.add(i); persist(); requestDraw(); });
      return $('label', { class: 'layer' }, cb, $('span', { class: 'lname', title: l.name }, l.name || '(top level)'), $('span', { class: 'lcount' }, fmtInt(l.count)));
    })));
  }
  if (m.tracks.length) el.append(trackSection());
  el.append(ui.selBox = $('section', { class: 'selbox' }));
  renderSelected();
}

function crsBox() {
  const input = $('input', { type: 'text', value: S.crsText, placeholder: 'EPSG code, proj4 or WKT', 'aria-label': 'Source CRS', spellcheck: 'false' });
  const apply = () => { S.crsText = input.value.trim(); S.keepView = false; worker.postMessage({ type: 'reparse', crs: S.crsText }); ui.hint.textContent = 'Reading with the new CRS...'; };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') apply(); });
  const crs = S.sum ? S.sum.crs : null;
  const src = crs ? { you: 'typed by you', file: 'from the file', guess: 'guessed from the numbers', default: 'longitude/latitude, the default' }[crs.source] || '' : '';
  return section('Coordinate system',
    crs ? kv('Source', `${crs.name}${src ? ` (${src})` : ''}`) : null,
    kv('Shown in', 'Web Mercator (lon/lat readout)'),
    $('div', { class: 'crsrow' }, input, btn('Apply', 'Read the file again with this CRS', apply)));
}

function trackSection() {
  const m = S.sum;
  const list = m.tracks.slice(0, 20);
  const rows = list.map((t, i) => {
    const r = $('button', { class: 'track' + (i === S.track ? ' on' : ''), type: 'button', title: 'Show this track on the map and in the profile' },
      $('span', { class: 'tname' }, t.name),
      $('span', { class: 'tval' }, fmtDistance(t.distance)));
    r.addEventListener('click', () => { S.track = i; renderSide(); drawProfile(); worker.postMessage({ type: 'feature', id: t.id, zoom: true }); });
    return r;
  });
  const t = list[Math.max(0, S.track)] || list[0];
  const stats = $('div', { class: 'stats' },
    kv('Distance', fmtDistance(t.distance)),
    kv('Duration', fmtDuration(t.duration)),
    kv('Moving time', fmtDuration(t.moving)),
    kv('Avg speed', t.moving ? `${((t.distance / t.moving) * 3.6).toFixed(1)} km/h moving` : '-'),
    kv('Elevation gain', t.gain != null ? `${Math.round(t.gain)} m` : '-'),
    kv('Elevation loss', t.loss != null ? `${Math.round(t.loss)} m` : '-'),
    kv('Min / max', t.minEle != null ? `${Math.round(t.minEle)} m / ${Math.round(t.maxEle)} m` : '-'),
    kv('Points', fmtInt(t.points)));
  ui.profile = $('canvas', { class: 'profile', 'aria-label': 'Elevation profile' });
  return section(m.tracks.length > 1 ? `Tracks (${m.tracks.length})` : 'Track', ...(list.length > 1 ? rows : []), stats, t.hasEle ? ui.profile : $('p', { class: 'msg note' }, 'No elevation in this track.'));
}

function drawProfile() {
  const cv = ui.profile;
  if (!cv || !S.sum || !S.sum.tracks.length || !cv.isConnected) return;
  const t = S.sum.tracks[Math.max(0, S.track)];
  const p = t && t.profile;
  const W = cv.clientWidth || 260, H = 110, dpr = Math.min(2, window.devicePixelRatio || 1);
  cv.width = W * dpr; cv.height = H * dpr; cv.style.height = H + 'px';
  const c = cv.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, W, H);
  if (!p || p.length < 2) return;
  const cs = getComputedStyle(document.body);
  const fg = cs.getPropertyValue('--vscode-foreground').trim() || '#ccc';
  const accent = cs.getPropertyValue('--vscode-charts-orange').trim() || '#ffb74d';
  const d1 = p[p.length - 1][0] || 1;
  let e0 = Infinity, e1 = -Infinity;
  for (const [, e] of p) { if (e < e0) e0 = e; if (e > e1) e1 = e; }
  if (e1 - e0 < 10) { e1 += 5; e0 -= 5; }
  const L = 34, B = 16, T = 6, R = 6;
  const X = d => L + (d / d1) * (W - L - R), Y = e => T + (1 - (e - e0) / (e1 - e0)) * (H - T - B);
  c.beginPath(); c.moveTo(X(p[0][0]), H - B);
  for (const [d, e] of p) c.lineTo(X(d), Y(e));
  c.lineTo(X(d1), H - B); c.closePath();
  c.globalAlpha = 0.25; c.fillStyle = accent; c.fill();
  c.globalAlpha = 1; c.beginPath();
  p.forEach(([d, e], i) => (i ? c.lineTo(X(d), Y(e)) : c.moveTo(X(d), Y(e))));
  c.strokeStyle = accent; c.lineWidth = 1.5; c.stroke();
  c.fillStyle = fg; c.font = '10px sans-serif'; c.globalAlpha = 0.8;
  c.fillText(`${Math.round(e1)} m`, 2, T + 8); c.fillText(`${Math.round(e0)} m`, 2, H - B);
  c.fillText(fmtDistance(d1), W - R - c.measureText(fmtDistance(d1)).width, H - 3); c.fillText('0', L, H - 3);
}

function select(id, feature, zoom) {
  S.selected = id; S.selFeature = feature;
  ui.fitSel.disabled = !(feature && feature.box);
  renderSelected();
  if (zoom && feature && feature.box) fitBox(feature.box, 60); else requestDraw();
  markRows();
}

function renderSelected() {
  const box = ui.selBox;
  if (!box) return;
  box.textContent = '';
  const f = S.selFeature;
  if (!f) { box.append($('h2', {}, 'Feature'), $('p', { class: 'msg note' }, 'Click a feature on the map or a row in the table.')); return; }
  const copy = btn('Copy GeoJSON', 'Copy this feature as GeoJSON (longitude/latitude)', () => worker.postMessage({ type: 'copyFeature', id: f.id }));
  const props = f.entries.length ? $('table', { class: 'props' }, ...f.entries.map(([k, v]) => $('tr', {}, $('th', {}, k), $('td', {}, v)))) : $('p', { class: 'msg note' }, 'No properties.');
  box.append($('h2', {}, 'Feature', $('span', { class: 'grow' }), copy),
    $('div', { class: 'fname' }, f.name),
    $('div', { class: 'stats' }, kv('Type', f.kind), kv('Vertices', fmtInt(f.vertices)), f.layer ? kv('Layer', f.layer) : null),
    props);
}

/* ---------- attribute table ---------- */
const ROW_H = 22;
let rowsTimer = 0;
function requestRows(reset) {
  if (!S.loaded || !S.showTable) return;
  if (reset) ui.tableWrap.scrollTop = 0;
  const first = Math.max(0, Math.floor(ui.tableWrap.scrollTop / ROW_H) - 10);
  const count = Math.ceil(ui.tableWrap.clientHeight / ROW_H) + 30;
  worker.postMessage({ type: 'rows', seq: ++S.rowsSeq, start: first, count, q: S.tableQ });
}
ui.tableWrap.addEventListener('scroll', () => { clearTimeout(rowsTimer); rowsTimer = setTimeout(() => requestRows(false), 16); });
ui.tableFilter.addEventListener('input', () => { clearTimeout(rowsTimer); rowsTimer = setTimeout(() => { S.tableQ = ui.tableFilter.value; requestRows(true); }, 200); });

// One listener on the table (rows are rebuilt while scrolling): a press on a row selects it and zooms to it.
ui.tableInner.addEventListener('pointerdown', e => {
  const tr = e.target.closest && e.target.closest('tbody tr');
  if (tr && e.button === 0) worker.postMessage({ type: 'feature', id: Number(tr.dataset.id), zoom: true });
});
let lastRowsKey = '';
function onRows(m) {
  if (m.seq !== S.rowsSeq) return;
  const key = `${S.sum ? S.sum.features : 0}|${m.start}|${m.total}|${m.q}|${m.rows.length}|${m.rows.length ? m.rows[0][0] : ''}`;
  if (key === lastRowsKey && ui.tableInner.rows.length) return; // same window: keep the DOM (a click may be in progress)
  lastRowsKey = key;
  S.tableTotal = m.total; S.tableCols = m.cols;
  ui.tableCount.textContent = `${fmtInt(m.total)} of ${fmtInt(S.sum.features)} rows`;
  ui.tableSizer.style.height = `${m.total * ROW_H + ROW_H}px`;
  const head = $('tr', {}, $('th', { class: 'num' }, '#'), $('th', {}, 'Name'), ...m.cols.map(c => $('th', { title: c }, c)));
  const body = m.rows.map(r => {
    return $('tr', { 'data-id': r[0], class: r[0] === S.selected ? 'sel' : '' }, $('td', { class: 'num' }, String(r[0] + 1)), ...r.slice(1).map(v => $('td', { title: v.length > 40 ? v : null }, v)));
  });
  ui.tableInner.textContent = '';
  ui.tableInner.append($('thead', {}, head), $('tbody', {}, ...body));
  ui.tableInner.style.transform = `translateY(${m.start * ROW_H}px)`;
}
function markRows() {
  for (const tr of ui.tableInner.querySelectorAll('tbody tr')) tr.classList.toggle('sel', Number(tr.dataset.id) === S.selected);
}

/* ---------- layout ---------- */
function layout() {
  ui.tablePanel.hidden = !S.showTable;
  ui.sideEl.hidden = !S.showSide;
  if (S.showTable) requestRows(false);
  requestDraw();
  drawProfile();
}
new ResizeObserver(() => { if (S.autoFit) fitBox(S.autoFit.b, S.autoFit.pad, true); else requestDraw(); }).observe(ui.stage);

/* ---------- pointer ---------- */
let drag = null;
ui.canvas.addEventListener('pointerdown', e => {
  if (e.button !== 0 || !S.view) return;
  ui.canvas.setPointerCapture(e.pointerId);
  drag = { x: e.clientX, y: e.clientY, cx: S.view.cx, cy: S.view.cy, moved: false };
});
ui.canvas.addEventListener('pointermove', e => {
  updateCoords(e);
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
  if (!drag.moved) return;
  S.autoFit = null;
  S.view.cx = drag.cx - dx / S.view.scale;
  S.view.cy = drag.cy - dy / S.view.scale;
  clampView(S.view); requestDraw();
});
ui.canvas.addEventListener('pointerup', e => {
  if (!drag) return;
  const d = drag; drag = null;
  if (d.moved) { persist(); return; }
  const p = toMerc(e);
  if (p && S.loaded) worker.postMessage({ type: 'hit', x: p.x, y: p.y, tol: 6 / S.view.scale, hidden: [...S.hidden] });
});
ui.canvas.addEventListener('dblclick', e => zoomAt(e, 2));
ui.canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const k = Math.pow(2, -e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0022));
  zoomAt(e, k);
}, { passive: false });
function toMerc(e) {
  if (!S.view) return null;
  const r = ui.stage.getBoundingClientRect();
  return { x: S.view.cx + (e.clientX - r.left - r.width / 2) / S.view.scale, y: S.view.cy + (e.clientY - r.top - r.height / 2) / S.view.scale };
}
function zoomAt(e, k) {
  const p = toMerc(e);
  if (!p) return;
  S.autoFit = null;
  const v = S.view;
  const ns = Math.max(MIN_SCALE, Math.min(MAX_SCALE, v.scale * k));
  const kk = ns / v.scale;
  v.cx = p.x - (p.x - v.cx) / kk; v.cy = p.y - (p.y - v.cy) / kk; v.scale = ns;
  clampView(v); requestDraw(); persistSoon();
}
let persistTimer = 0;
function persistSoon() { clearTimeout(persistTimer); persistTimer = setTimeout(persist, 400); }
let lastLL = null;
function updateCoords(e) {
  const p = toMerc(e);
  if (!p) return;
  const lon = unmercX(p.x), lat = unmercY(p.y);
  if (p.y < 0 || p.y > 1) { ui.coords.textContent = ''; lastLL = null; return; }
  lastLL = [lat, lon];
  const z = Math.log2(S.view.scale / 256);
  ui.coords.textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)} · zoom ${z.toFixed(1)}`;
}
ui.coords.addEventListener('click', () => { if (lastLL) { vscode.postMessage({ type: 'copy', text: `${lastLL[0].toFixed(6)}, ${lastLL[1].toFixed(6)}` }); flash('Coordinates copied (latitude, longitude).'); } });

ui.canvas.addEventListener('keydown', e => {
  if (!S.view) return;
  const v = S.view, step = 80 / v.scale;
  const keys = {
    ArrowLeft: () => { v.cx -= step; }, ArrowRight: () => { v.cx += step; }, ArrowUp: () => { v.cy -= step; }, ArrowDown: () => { v.cy += step; },
    '+': () => { v.scale *= 1.5; }, '=': () => { v.scale *= 1.5; }, '-': () => { v.scale /= 1.5; },
  };
  if (keys[e.key]) { S.autoFit = null; keys[e.key](); clampView(v); requestDraw(); persistSoon(); e.preventDefault(); return; }
  if (e.key === '0') fitAll();
  else if (e.key === 'f' || e.key === 'F') fitSelected();
  else if (e.key === 'b' || e.key === 'B') ui.base.click();
  else if (e.key === 't' || e.key === 'T') ui.table.click();
  else if (e.key === 'p' || e.key === 'P') ui.side.click();
  else if (e.key === 'Escape') select(-1, null, false);
});

/* ---------- test probe (read by the real VS Code gate) ---------- */
window.geoMapProbe = () => ({
  loaded: S.loaded, error: S.error, bytesCount: S.bytesCount || 0, frames: S.frames, stats: S.lastStats, view: S.view, selected: S.selected,
  selName: S.selFeature ? S.selFeature.name : null, sum: S.sum ? { ...S.sum, tracks: S.sum.tracks.map(t => ({ ...t, profile: t.profile.length })) } : null,
  theme: S.theme, basemap: S.basemap && S.basemapReady, hidden: [...S.hidden], tableTotal: S.tableTotal, loadMs: S.loadMs,
  firstFrameMs: S.firstFrameAt ? S.firstFrameAt - S.t0 : null, notice: ui.notice.hidden ? '' : ui.notice.textContent,
});
window.geoMapInk = () => new Promise(r => { const seq = Math.random(); S.probeWaiters.set(seq, r); worker.postMessage({ type: 'probe', seq }); });
window.geoMapMercOf = (lon, lat) => ({ x: mercX(lon), y: mercY(lat) });

renderSide();
vscode.postMessage({ type: 'ready' });
