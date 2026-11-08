// Release gate in a real VS Code: installs the .vsix into an isolated profile, opens real, large and hostile
// files, drives the webview with real mouse and key events, watches every network request of the webview and
// its worker, saves screenshots and a JSON report.
// usage: node scripts/e2e-vscode.mjs <work> <port> <vsix> <workspaceDir> <shotDir> <outJson> [gpxReference.json]
import { launch, installVsix, sleep } from './vsc.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

const [work0, port, vsix, ws0, shotDir, outJson, gpxRef] = process.argv.slice(2);
const work = path.resolve(work0), ws = path.resolve(ws0);
const R = { install: null, steps: [], console: [], requests: [], hashes: {}, unchanged: null };
const hash = f => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');
for (const f of fs.readdirSync(ws)) { const p = fs.realpathSync(path.join(ws, f)); if (fs.statSync(p).size < 50e6) R.hashes[f] = hash(p); }
fs.rmSync(path.join(work, 'ud'), { recursive: true, force: true });
R.install = installVsix(work, vsix);
const clipBefore = (() => { try { return execSync('pbpaste', { encoding: 'utf8' }); } catch { return null; } })();
const assoc = { '*.geojson': 'geoMapViewer.mapOption', '*.kml': 'geoMapViewer.mapOption', '*.wkt': 'geoMapViewer.mapOption', '*.csv': 'geoMapViewer.mapOption', '*.zip': 'geoMapViewer.mapOption' };
const baseSettings = { 'files.simpleDialog.enable': true, 'workbench.secondarySideBar.defaultVisibility': 'hidden', 'workbench.auxiliaryBar.visible': false, 'window.titleBarStyle': 'custom', 'workbench.sideBar.location': 'left', 'workbench.editorAssociations': assoc };
const vs = await launch(work, Number(port), ws, baseSettings);
// Watch every request made by any target (webview frames and the map worker). Only the webview resource
// origin (the extension's own files) is allowed.
const sessions = new Set();
const watchNet = async () => {
  for (const sid of vs.attached.keys()) if (!sessions.has(sid)) { sessions.add(sid); vs.s.send('Network.enable', {}, sid).catch(() => {}); }
};
vs.s.on(m => {
  if (m.method === 'Network.requestWillBeSent') { const t = vs.attached.get(m.sessionId); R.requests.push({ url: m.params.request.url.slice(0, 200), type: m.params.type || '', target: t ? `${t.type} ${String(t.url).slice(0, 40)}` : 'workbench' }); }
  if (m.method === 'Target.attachedToTarget') setTimeout(watchNet, 50);
});
await watchNet();
// Requests from the extension: the webview frames and the map worker. VS Code's own workbench requests are listed apart.
const fromExtension = r => /^(iframe|worker|service_worker)/.test(r.target || '') || /vscode-webview|^blob:/.test(r.target || '');
const external = () => R.requests.filter(fromExtension).filter(r => !/^(vscode-|data:|blob:|https:\/\/[^/]*vscode-cdn\.net\/|vscode-webview:|devtools:)/.test(r.url) && !/^https:\/\/file\+\.vscode-resource/.test(r.url));

const shots = [];
const shot = async name => { const f = path.join(shotDir, `geo-${String(shots.length + 1).padStart(2, '0')}-${name}.png`); await vs.shot(f); shots.push(f); return f; };
const SKIP = process.env.GATE_SKIP ? new RegExp(process.env.GATE_SKIP) : null;
const step = async (name, fn) => {
  const t0 = Date.now();
  if (SKIP && SKIP.test(name)) { R.steps.push({ name, ok: true, skipped: true }); console.log('SKIP', name); return; }
  try { const v = await fn(); R.steps.push({ name, ok: v !== false, value: v, ms: Date.now() - t0 }); console.log('PASS', name); }
  catch (e) { R.steps.push({ name, ok: false, error: String(e.message || e).slice(0, 800), ms: Date.now() - t0 }); console.log('FAIL', name, String(e.message || e).slice(0, 300)); try { await shot('FAIL-' + name.replace(/\W+/g, '_').slice(0, 40)); } catch {} }
};
let wv;
const E = expr => vs.wvEval(wv, expr);
const probe = async () => JSON.parse(await E(`JSON.stringify(window.geoMapProbe ? window.geoMapProbe() : null)`));
const getWv = async title => vs.waitFor(async () => (await vs.webviews()).find(w => w.title === title && w.w > 0), 25000);
const open = async file => { const t0 = Date.now(); vs.open(path.join(ws, file)); await sleep(600); wv = await getWv(file); if (!wv) throw new Error('no webview for ' + file); await watchNet(); return Date.now() - t0; };
const loaded = async (ms = 30000) => {
  const p = await vs.waitFor(async () => { const r = await probe(); return r && (r.loaded || r.error) && r.frames > 0 && (r.error || r.firstFrameMs != null) ? r : null; }, ms, 150);
  if (!p) throw new Error('not loaded in time: ' + JSON.stringify(await probe()).slice(0, 300));
  if (p.error) throw new Error('error: ' + p.error);
  await sleep(250); return probe();
};
const btn = t => `[...document.querySelectorAll('button')].find(b => b.textContent === ${JSON.stringify(t)})`;
const sideText = () => E(`document.querySelector('.side').innerText`);
const sideVal = async k => { const m = new RegExp('^' + k + '\\s+(.+)$', 'm').exec(await sideText()); return m ? m[1].trim() : null; };
/** Screen point (workbench coordinates) of a longitude/latitude in the current view. */
const lonlatPoint = async (lon, lat) => {
  const off = await vs.wvOffset();
  const p = JSON.parse(await E(`(() => { const p = window.geoMapProbe(); const m = window.geoMapMercOf(${lon}, ${lat}); const r = document.querySelector('.stage').getBoundingClientRect();
    return JSON.stringify({ x: r.left + r.width / 2 + (m.x - p.view.cx) * p.view.scale, y: r.top + r.height / 2 + (m.y - p.view.cy) * p.view.scale }); })()`));
  return { x: off.x + p.x, y: off.y + p.y };
};
const clickLonLat = async (lon, lat) => { const p = await lonlatPoint(lon, lat); await vs.click(p.x, p.y); await sleep(500); return probe(); };
const waitFrames = async (n0, ms = 15000) => vs.waitFor(async () => { const p = await probe(); return p.frames > n0 ? p : null; }, ms, 100);
const summary = p => ({ features: p.sum.features, counts: p.sum.counts, bad: p.sum.bad, layers: p.sum.layers.length, crs: p.sum.crs.name, loadMs: Math.round(p.loadMs), firstFrameMs: Math.round(p.firstFrameMs), drawMs: p.stats.ms, drawn: p.stats.drawn, warnings: p.sum.warnings, notes: p.sum.notes });

try {
  await sleep(2500);
  await vs.command('View: Close Primary Side Bar').catch(() => {});

  await step('countries.shp (Natural Earth, .prj + .dbf + .cpg) opens as the default editor: 177 polygons, attributes, CRS from .prj', async () => {
    const ms = await open('countries.shp'); const p = await loaded();
    if (p.sum.features !== 177 || p.sum.counts.polygon !== 177 || !/WGS/.test(p.sum.crs.name) || p.stats.drawn < 100) throw new Error(JSON.stringify(summary(p)));
    return { openMs: ms, ...summary(p) };
  });
  await step('click Brazil on the map: properties in the panel, outline drawn', async () => {
    const p = await clickLonLat(-52, -10);
    const t = await sideText();
    if (p.selName !== 'Brazil' || !/BRA/.test(t)) throw new Error(JSON.stringify({ sel: p.selName }));
    return { selected: p.selName, hasIso: /BRA/.test(t) };
  });
  await step('attribute table: 177 rows, filter "Europe" keeps the European rows, click a row zooms to it', async () => {
    await vs.wvClick(wv, btn('Table')); await sleep(800);
    const all = await vs.waitFor(async () => (await probe()).tableTotal === 177 && E(`document.querySelectorAll('table.grid tbody tr').length`), 8000);
    await vs.wvClick(wv, `document.querySelector('.tablebar input')`); await vs.type('Europe'); await sleep(900);
    const filtered = await probe();
    const scale0 = filtered.view.scale;
    await vs.wvClick(wv, `[...document.querySelectorAll('table.grid tbody tr')].find(r => r.children[1].textContent === 'France').children[1]`); await sleep(900);
    const p = await probe();
    await vs.wvClick(wv, btn('Fit all')); await sleep(700);
    await shot('countries-shapefile-table-selection');
    if (!all || filtered.tableTotal < 30 || filtered.tableTotal > 60 || p.selName !== 'France' || !(p.view.scale > scale0)) throw new Error(JSON.stringify({ all, rows: filtered.tableTotal, sel: p.selName, s0: scale0, s1: p.view.scale }));
    return { rowsShown: all, filteredEurope: filtered.tableTotal, selectedRow: p.selName, zoomedIn: +(p.view.scale / scale0).toFixed(1) };
  });
  await step('pan by mouse drag, zoom by wheel and keyboard; status line shows coordinates', async () => {
    const p0 = await probe();
    const a = await lonlatPoint(0, 20);
    await vs.s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x, y: a.y }, vs.wb);
    await vs.s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', clickCount: 1 }, vs.wb);
    for (let i = 1; i <= 10; i++) await vs.s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x + i * 12, y: a.y + i * 4, button: 'left', buttons: 1 }, vs.wb);
    await vs.s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: a.x + 120, y: a.y + 40, button: 'left', clickCount: 1 }, vs.wb);
    await sleep(400);
    const p1 = await probe();
    await vs.s.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: a.x, y: a.y, deltaX: 0, deltaY: -400 }, vs.wb); await sleep(500);
    const p2 = await probe();
    await vs.key('-', 'Minus', 0, 189); await sleep(300);
    const p3 = await probe();
    const coords = await E(`document.querySelector('.coords').textContent`);
    if (!(p1.view.cx < p0.view.cx) || !(p2.view.scale > p1.view.scale) || !(p3.view.scale < p2.view.scale) || !/^-?\d+\.\d{5}, -?\d+\.\d{5} · zoom/.test(coords)) throw new Error(JSON.stringify({ p0: p0.view, p1: p1.view, p2: p2.view, p3: p3.view, coords }));
    return { panned: +(p0.view.cx - p1.view.cx).toFixed(4), wheelZoom: +(p2.view.scale / p1.view.scale).toFixed(2), keyZoomOut: +(p3.view.scale / p2.view.scale).toFixed(2), coords };
  });
  await step('Export PNG through the save dialog writes a PNG of the map', async () => {
    const target = path.join(work, 'map-export.png'); fs.rmSync(target, { force: true });
    await vs.wvClick(wv, btn('Export PNG')); await sleep(1500);
    const ib = JSON.parse(await vs.wbEval(`JSON.stringify(document.querySelector('.quick-input-widget input').getBoundingClientRect())`));
    await vs.click(ib.x + ib.width / 2, ib.y + ib.height / 2); await vs.key('a', 'KeyA', 4, 65); await vs.type(target);
    await sleep(300); await vs.key('Enter', 'Enter'); await sleep(1500);
    const ok = await vs.waitFor(() => fs.existsSync(target) && fs.statSync(target).size > 1000, 8000);
    if (!ok) { await shot('png-dialog'); await vs.key('Escape', 'Escape'); throw new Error('no file'); }
    const head = fs.readFileSync(target).subarray(0, 24);
    fs.copyFileSync(target, path.join(shotDir, 'export-countries.png'));
    return { bytes: fs.statSync(target).size, width: head.readUInt32BE(16), height: head.readUInt32BE(20), sig: head.subarray(1, 4).toString() };
  });

  await step('populated-places.geojson (Natural Earth): 243 points; click Tokyo', async () => {
    await open('populated-places.geojson'); const p = await loaded();
    await sleep(300);
    const s = await clickLonLat(139.75, 35.69);
    if (p.sum.features !== 243 || p.sum.counts.point !== 243 || !/Tokyo/.test(s.selName || '')) throw new Error(JSON.stringify({ ...summary(p), sel: s.selName }));
    return { ...summary(p), selected: s.selName };
  });
  await step('populated-places-3857.geojson (crs EPSG:3857 member): reprojected, Tokyo is at the same place', async () => {
    await open('populated-places-3857.geojson'); const p = await loaded();
    const s = await clickLonLat(139.75, 35.69);
    if (!/3857/.test(p.sum.crs.name) || !/Tokyo/.test(s.selName || '')) throw new Error(JSON.stringify({ ...summary(p), sel: s.selName }));
    return { ...summary(p), selected: s.selName };
  });
  await step('us-states-albers.shp (EPSG:5070 .prj, projected metres): Denver lands in Colorado, Austin in Texas', async () => {
    await open('us-states-albers.shp'); const p = await loaded();
    await E(`document.querySelector('.tablebar input').value = ''`);
    const a = await clickLonLat(-104.99, 39.74); const b = await clickLonLat(-97.74, 30.27);
    await shot('us-states-albers-projected');
    if (!/Albers/.test(p.sum.crs.name) || a.selName !== 'Colorado' || b.selName !== 'Texas') throw new Error(JSON.stringify({ ...summary(p), a: a.selName, b: b.selName }));
    return { ...summary(p), denver: a.selName, austin: b.selName, extent: p.sum.lonlatBox.map(v => +v.toFixed(2)) };
  });
  await step('us-states-tiger.zip (Census TIGER zipped shapefile, NAD83): 52 states', async () => {
    await open('us-states-tiger.zip'); const p = await loaded();
    const a = await clickLonLat(-104.99, 39.74);
    if (p.sum.features !== 52 || a.selName !== 'Colorado') throw new Error(JSON.stringify({ ...summary(p), a: a.selName }));
    return { ...summary(p), denver: a.selName };
  });
  await step('world-110m.topojson: 2 TopoJSON objects as layers; hiding one draws fewer features', async () => {
    await open('world-110m.topojson'); const p = await loaded();
    const d0 = p.stats.drawn;
    await vs.wvClick(wv, `document.querySelector('.layer input')`); await sleep(700);
    const p1 = await probe();
    await vs.wvClick(wv, `document.querySelector('.layer input')`); await sleep(500);
    if (p.sum.layers.length !== 2 || !(p1.stats.drawn < d0) || p1.hidden.length !== 1) throw new Error(JSON.stringify({ layers: p.sum.layers, d0, d1: p1.stats.drawn }));
    return { ...summary(p), layerNames: p.sum.layers.map(l => l.name), drawnAll: d0, drawnOneHidden: p1.stats.drawn };
  });
  await step('styled-placemarks.kml: KML styles and a folder; 6 remote icon links not fetched', async () => {
    await open('styled-placemarks.kml'); const p = await loaded();
    if (p.sum.features !== 2 || !p.sum.notes.some(n => /remote link/.test(n)) || p.sum.styled < 1) throw new Error(JSON.stringify(summary(p)));
    return { ...summary(p), styles: p.sum.styled };
  });
  await step('placemarks-with-icon.kmz (embedded icon): opens, 2 features', async () => {
    await open('placemarks-with-icon.kmz'); const p = await loaded();
    if (p.sum.features !== 2) throw new Error(JSON.stringify(summary(p)));
    return summary(p);
  });
  await step('blue-hills-hike.gpx: 3 tracks + 46 waypoints; distance, duration, moving time, gain within 1% of gpxpy / hand calculation', async () => {
    await open('blue-hills-hike.gpx'); const p = await loaded();
    const ref = gpxRef ? JSON.parse(fs.readFileSync(gpxRef, 'utf8')) : [];
    const cmp = p.sum.tracks.map(t => {
      const r = ref.find(x => x.name === t.name) || {};
      const pc = (a, b) => (b ? +(100 * (a - b) / b).toFixed(3) : null);
      return { name: t.name, distance_m: Math.round(t.distance), vsGpxpy: pc(t.distance, r.gpxpy_len2d), vsHand: pc(t.distance, r.hand_len), duration_s: t.duration, vsGpxpyDuration: pc(t.duration, r.gpxpy_duration_s), moving_s: t.moving, vsGpxpyMoving: pc(t.moving, r.gpxpy_moving_s), gain_m: +t.gain.toFixed(1), vsHandGain: pc(t.gain, r.hand_gain_raw) };
    });
    const profile = await E(`(() => { const c = document.querySelector('canvas.profile'); return c ? c.width + 'x' + c.height : null; })()`);
    await shot('blue-hills-gpx-track-stats');
    const worst = Math.max(...cmp.flatMap(c => [c.vsGpxpy, c.vsHand, c.vsGpxpyDuration, c.vsGpxpyMoving, c.vsHandGain].map(v => Math.abs(v ?? 99))));
    if (p.sum.tracks.length !== 3 || p.sum.counts.point !== 46 || worst > 1 || !profile) throw new Error(JSON.stringify({ cmp, worst, profile }));
    return { tracks: cmp, worstPercent: worst, profileCanvas: profile, panelDistance: await sideVal('Distance') };
  });
  await step('evening-run.gpx (Strava-style run): 1 track with stats', async () => {
    await open('evening-run.gpx'); const p = await loaded();
    if (p.sum.tracks.length !== 1 || !(p.sum.tracks[0].distance > 50)) throw new Error(JSON.stringify(summary(p)));
    return { ...summary(p), distance: Math.round(p.sum.tracks[0].distance), duration: p.sum.tracks[0].duration };
  });
  await step('earthquakes-week.csv (USGS, latitude/longitude columns): every row a point', async () => {
    await open('earthquakes-week.csv'); const p = await loaded();
    const rows = fs.readFileSync(fs.realpathSync(path.join(ws, 'earthquakes-week.csv')), 'utf8').trim().split('\n').length - 1;
    if (p.sum.features !== rows || p.sum.counts.point !== rows) throw new Error(JSON.stringify({ ...summary(p), rows }));
    return { ...summary(p), csvRows: rows };
  });
  await step('paris-shapes.wkt (EWKT with SRID): point, line, polygon with a hole, multipoint', async () => {
    await open('paris-shapes.wkt'); const p = await loaded();
    if (p.sum.features !== 4 || p.sum.counts.polygon !== 1 || p.sum.counts.line !== 1) throw new Error(JSON.stringify(summary(p)));
    return summary(p);
  });

  await step('LARGE large-200k-parcels.geojson (129 MB, 200,000 polygons): map in < 10 s, VS Code stays responsive', async () => {
    const lat = [];
    let stop = false;
    const t0 = Date.now();
    vs.open(path.join(ws, 'large-200k-parcels.geojson'));
    const pinger = (async () => { while (!stop) { const a = Date.now(); try { await vs.wbEval('1+1'); } catch {} lat.push(Date.now() - a); await sleep(100); } })();
    await sleep(500);
    wv = await getWv('large-200k-parcels.geojson'); await watchNet();
    const uiLat = [];
    const p = await vs.waitFor(async () => { const a = Date.now(); const r = await probe(); uiLat.push(Date.now() - a); return r && (r.loaded || r.error) && r.firstFrameMs != null ? r : null; }, 60000, 200);
    const wall = Date.now() - t0;
    stop = true; await pinger;
    if (!p || p.error) throw new Error('not loaded: ' + JSON.stringify(p).slice(0, 300));
    // pan and zoom on the big file
    const frames0 = p.frames;
    const c = await lonlatPoint(-96, 37);
    const z0 = Date.now();
    for (let i = 0; i < 4; i++) { await vs.s.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: c.x, y: c.y, deltaX: 0, deltaY: -300 }, vs.wb); await sleep(60); }
    const pz = await vs.waitFor(async () => { const r = await probe(); return r.frames > frames0 + 1 ? r : null; }, 15000, 100);
    const zoomMs = Date.now() - z0;
    await sleep(800);
    await shot('large-200k-parcels');
    const maxWb = Math.max(...lat), maxUi = Math.max(...uiLat);
    if (p.sum.features !== 200000 || wall > 10000 || maxWb > 1000) throw new Error(JSON.stringify({ wall, maxWb, maxUi, ...summary(p) }));
    return { ...summary(p), wallMsToMap: wall, workbenchMaxLatencyMs: maxWb, workbenchPings: lat.length, webviewMaxLatencyMs: maxUi, zoomFramesMs: zoomMs, drawMsZoomed: pz && pz.stats.ms, dotsZoomed: pz && pz.stats.dots };
  });

  await step('HOSTILE hostile-zip-bomb.kmz (1.5 GB of KML in 1.5 MB): stopped with a message, no freeze', async () => {
    const t0 = Date.now();
    await open('hostile-zip-bomb.kmz');
    const t = await vs.waitFor(async () => { const r = await probe(); return r && r.error ? r.error : null; }, 20000, 150);
    const ms = Date.now() - t0;
    const alive = await vs.wbEval('1+1');
    await shot('hostile-zip-bomb');
    if (!/zip bomb/.test(t || '') || ms > 10000 || alive !== 2) throw new Error(JSON.stringify({ t, ms }));
    return { message: t, ms };
  });
  await step('HOSTILE hostile-remote-links.kml (2 NetworkLinks, remote icons, overlay, external entity): nothing fetched, warnings shown', async () => {
    const before = external().length;
    await open('hostile-remote-links.kml'); const p = await loaded();
    await sleep(1500);
    const ext = external().slice(before);
    await shot('hostile-remote-links');
    if (ext.length || !p.sum.warnings.some(w => /NetworkLink/.test(w)) || !p.sum.warnings.some(w => /entities/.test(w))) throw new Error(JSON.stringify({ ext, ...summary(p) }));
    return { ...summary(p), externalRequests: ext.length };
  });
  await step('HOSTILE hostile-entity-bomb.kml (billion laughs): no expansion, opens at once', async () => {
    const t0 = Date.now();
    await open('hostile-entity-bomb.kml'); const p = await loaded();
    const ms = Date.now() - t0;
    if (ms > 8000 || !p.sum.warnings.some(w => /entities/.test(w))) throw new Error(JSON.stringify({ ms, ...summary(p) }));
    return { ...summary(p), ms };
  });
  await step('HOSTILE hostile-bad-coords.geojson (NaN, latitude 1000, string coordinates, a 1,000,000-vertex ring): good features drawn, bad ones reported', async () => {
    const t0 = Date.now();
    await open('hostile-bad-coords.geojson'); const p = await loaded();
    const ms = Date.now() - t0;
    await shot('hostile-bad-coords');
    if (p.sum.features !== 7 || !(p.sum.bad >= 2) || p.sum.vertices < 1000000 || ms > 10000) throw new Error(JSON.stringify({ ms, ...summary(p) }));
    return { ...summary(p), ms, vertices: p.sum.vertices };
  });
  await step('HOSTILE networklink-fixture.kml (togeojson NetworkLink fixture): link not loaded', async () => {
    await open('networklink-fixture.kml'); const p = await loaded();
    if (!p.sum.warnings.some(w => /NetworkLink/.test(w))) throw new Error(JSON.stringify(summary(p)));
    return summary(p);
  });

  await step('map title-bar button: a .geojson open as text gets "Open Map Preview to the Side"', async () => {
    const sp = path.join(vs.ud, 'User', 'settings.json');
    fs.writeFileSync(sp, JSON.stringify({ ...JSON.parse(fs.readFileSync(sp, 'utf8')), 'workbench.editorAssociations': {} }, null, 1));
    await sleep(1500);
    // a fresh copy, so it opens as text (paris-shapes.wkt is already open on the map from an earlier step)
    fs.copyFileSync(fs.realpathSync(path.join(ws, 'paris-shapes.wkt')), path.join(ws, 'live-edit.wkt'));
    await sleep(500);
    vs.open(path.join(ws, 'live-edit.wkt')); await sleep(1500);
    const has = await vs.waitFor(() => vs.wbEval(`!!document.querySelector('.editor-actions [aria-label="Open Map Preview to the Side"], .editor-actions a[aria-label*="Open Map Preview"]')`), 8000);
    if (!has) throw new Error('no title button');
    await vs.wbEval(`document.querySelector('.editor-actions [aria-label*="Open Map Preview"]').click(), 1`);
    wv = await getWv('live-edit.wkt'); const p = await loaded();
    const groups = await vs.wbEval(`document.querySelectorAll('.editor-group-container').length`);
    await shot('title-button-side-preview');
    if (p.sum.features !== 4 || groups < 2) throw new Error(JSON.stringify({ groups, ...summary(p) }));
    return { button: true, editorGroups: groups, features: p.sum.features };
  });
  await step('live preview: typing in the text editor redraws the map without saving', async () => {
    const n0 = (await probe()).sum.features;
    // click into the text editor (left group), then go to the end of the file
    const ed = JSON.parse(await vs.wbEval(`JSON.stringify(document.querySelector('.editor-group-container .monaco-editor .view-lines').getBoundingClientRect())`));
    await vs.click(ed.x + 200, ed.y + 60); await sleep(300);
    await vs.key('a', 'KeyA', 4, 65); // Cmd+A (CDP modifier 4 = Meta), then replace the text without saving
    await vs.type('POINT(2.3522 48.8566)\nPOINT(2.2945 48.8584)\nLINESTRING(2.2945 48.8584, 2.3522 48.8566)\n'); await sleep(2000);
    const p = await probe();
    await vs.command('File: Revert File'); await sleep(1500);
    const p2 = await probe();
    if (p.sum.features !== 3 || p.sum.counts.line !== 1 || p2.sum.features !== n0) throw new Error(JSON.stringify({ n0, typed: p.sum.features, reverted: p2.sum.features }));
    return { before: n0, afterTyping: p.sum.features, afterRevert: p2.sum.features, scaleKept: p.view.scale > 1000 };
  });

  await step('light theme: map, panel and basemap follow the theme', async () => {
    const s = JSON.parse(fs.readFileSync(path.join(vs.ud, 'User', 'settings.json'), 'utf8'));
    fs.writeFileSync(path.join(vs.ud, 'User', 'settings.json'), JSON.stringify({ ...s, 'workbench.colorTheme': 'Default Light Modern', 'workbench.editorAssociations': assoc }, null, 1));
    await sleep(2000);
    await vs.key('Escape', 'Escape');
    await open('blue-hills-hike.gpx'); await loaded();
    await vs.waitFor(async () => (await probe()).theme === 'light', 8000);
    await sleep(800);
    const p = await probe();
    await shot('blue-hills-gpx-light');
    await open('countries.shp'); await loaded(); await sleep(600);
    await shot('countries-light');
    if (p.theme !== 'light') throw new Error(JSON.stringify({ theme: p.theme }));
    return { theme: p.theme };
  });
  await step('no request left the machine during the whole run (webview frames and the map worker)', async () => {
    const ext = external();
    if (ext.length) throw new Error(JSON.stringify(ext.slice(0, 10)));
    return { totalRequests: R.requests.length, external: 0, sample: [...new Set(R.requests.map(r => r.url.replace(/\/Users\/[^ ]*$/, '/...').slice(0, 70)))].slice(0, 6) };
  });
} finally {
  R.console = vs.console.filter(c => !/copilot|CloudSandboxApi|LESS API|reading 'selection'|github\.|api proposal/i.test(c.text));
  R.logErrors = [];
  for (const f of vs.extHostLogs()) { const t = fs.readFileSync(f, 'utf8'); for (const l of t.split('\n')) if (/\[error\]/.test(l) && /geo|zovo|map/i.test(l)) R.logErrors.push(l.slice(0, 300)); }
  await vs.close();
  fs.rmSync(path.join(ws, 'live-edit.wkt'), { force: true });
  if (clipBefore !== null) try { execSync('pbcopy', { input: clipBefore }); } catch {}
  R.workbenchExternal = R.requests.filter(r => !fromExtension(r) && /^https?:/.test(r.url) && !/vscode-cdn\.net|vscode-resource/.test(r.url)).map(r => r.url).slice(0, 10);
  R.unchanged = Object.entries(R.hashes).every(([f, h]) => hash(fs.realpathSync(path.join(ws, f))) === h);
  R.shots = shots;
  fs.writeFileSync(outJson, JSON.stringify(R, null, 1));
  console.log(JSON.stringify({ skipped: R.steps.filter(s => s.skipped).length, workbenchExternal: R.workbenchExternal, pass: R.steps.filter(s => s.ok && !s.skipped).length, of: R.steps.length, console: R.console.slice(0, 12), logErrors: R.logErrors.slice(0, 8), unchanged: R.unchanged, install: R.install.code, external: external().length }, null, 1));
}
