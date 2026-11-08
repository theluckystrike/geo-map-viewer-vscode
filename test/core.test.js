'use strict';
// Unit tests for the parsers, the guarded unzip, CRS handling, track stats, the packed store and the renderer.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const fflate = require('fflate');
const P = require('../src/core/protocol');
const { parseWktText } = require('../src/core/wkt');
const { csvToGeojson } = require('../src/core/csv');
const { parseShp, parseDbf, dbfEncoding } = require('../src/core/shp');
const { safeUnzip, ZipLimitError } = require('../src/core/zip');
const { kmlToGeojson, gpxToGeojson, sanitizeXml } = require('../src/core/xmlgeo');
const { makeTransform, transformFromUser, epsgOf, geojsonCrs } = require('../src/core/crs');
const { trackStats, haversine } = require('../src/core/stats');
const { buildStore, hitTest, filterIds, columnsOf, boxOf, fitBoxOf, mercX, mercY, unmercX, unmercY } = require('../src/core/store');
const { loadGeo, LoadError } = require('../src/core/load');
const { render, PALETTES } = require('../src/core/render');
const { buildHtml } = require('../src/html');

const S = f => path.join(__dirname, '..', 'samples', f);
const bytes = f => new Uint8Array(fs.readFileSync(S(f)));
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} ${a} vs ${b}`);

test('formatOf and size plan', () => {
  assert.strictEqual(P.formatOf('a.GeoJSON'), 'geojson');
  assert.strictEqual(P.formatOf('x.geo.json'), 'geojson');
  assert.strictEqual(P.formatOf('t.tsv'), 'csv');
  assert.strictEqual(P.formatOf('a.kmz'), 'kmz');
  assert.strictEqual(P.formatOf('a.txt'), null);
  assert.strictEqual(P.sizePlan(10 * P.MB, 512).load, true);
  const big = P.sizePlan(600 * P.MB, 512);
  assert.strictEqual(big.load, false);
  assert.match(big.message, /600\.0 MB.*512\.0 MB.*not read/);
  assert.strictEqual(P.sizePlan(30 * P.MB, 512).large, true);
});

test('webview messages are checked', () => {
  assert.strictEqual(P.validateWebviewMessage({ type: 'ready' }).ok, true);
  assert.strictEqual(P.validateWebviewMessage({ type: 'evil' }).ok, false);
  assert.strictEqual(P.validateWebviewMessage({ type: 'png', data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) }).ok, false);
  assert.strictEqual(P.validateWebviewMessage({ type: 'png', data: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]) }).ok, true);
  assert.strictEqual(P.validateWebviewMessage({ type: 'copy', text: 5 }).ok, false);
  assert.deepStrictEqual(P.validateWebviewMessage({ type: 'rendered', ok: 'yes' }).msg, { type: 'rendered', ok: false, features: 0 });
});

test('CSP: nothing remote, worker from blob only, scripts by nonce', () => {
  const h = buildHtml({ cspSource: 'vscode-webview://x', scriptUri: 'vscode-webview://x/a.js', styleUri: 'vscode-webview://x/a.css', title: 't<"', nonce: 'abc', showSupportLinks: true });
  const csp = /content="([^"]+)"/.exec(h)[1];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'nonce-abc'/);
  assert.match(csp, /worker-src blob:/);
  assert.match(csp, /connect-src vscode-webview:\/\/x(;|$)/);
  assert.doesNotMatch(csp, /https?:/);
  assert.doesNotMatch(h, /<title>t<"/);
});

test('WKT: types, Z, EMPTY, SRID, GEOMETRYCOLLECTION, errors', () => {
  const r = parseWktText('SRID=3857;POINT Z (1 2 3)\nLINESTRING EMPTY\nGEOMETRYCOLLECTION(POINT(1 1),LINESTRING(0 0,1 1))\nPOLYGON((0 0, 1 0))x');
  assert.strictEqual(r.srid, 3857);
  assert.deepStrictEqual(r.fc.features[0].geometry, { type: 'Point', coordinates: [1, 2, 3] });
  assert.strictEqual(r.fc.features[1].geometry, null);
  assert.strictEqual(r.fc.features[2].geometry.geometries.length, 2);
  assert.ok(r.errors.length >= 1);
  const w = parseWktText(fs.readFileSync(S('paris-shapes.wkt'), 'utf8'));
  assert.strictEqual(w.fc.features.length, 4);
  assert.strictEqual(w.fc.features[2].geometry.coordinates.length, 2, 'polygon with a hole');
});

test('CSV: delimiter, quoted fields, comma decimals, N/S/E/W, WKT column, skipped rows', () => {
  const r = csvToGeojson('name;Latitude;Longitude\n"A; B";52,5;13,4\nC;10S;20W\nbad;x;y\n');
  assert.strictEqual(r.fc.features.length, 2);
  assert.deepStrictEqual(r.fc.features[0].geometry.coordinates, [13.4, 52.5]);
  assert.deepStrictEqual(r.fc.features[1].geometry.coordinates, [-20, -10]);
  assert.strictEqual(r.skipped, 1);
  assert.strictEqual(r.fc.features[0].properties.name, 'A; B');
  const w = csvToGeojson('id,wkt\n1,"POINT(1 2)"\n2,"LINESTRING(0 0, 1 1)"\n');
  assert.strictEqual(w.fc.features.length, 2);
  assert.match(csvToGeojson('a,b\n1,2\n').error, /No coordinate columns/);
  const q = csvToGeojson(fs.readFileSync(S('earthquakes-week.csv'), 'utf8'));
  assert.ok(q.fc.features.length > 100);
  assert.strictEqual(q.latCol, 'latitude');
});

test('shapefile: Natural Earth countries (.shp + .dbf + .cpg)', () => {
  const shp = parseShp(bytes('countries.shp'));
  assert.strictEqual(shp.type, 5);
  assert.strictEqual(shp.geometries.length, 177);
  const dbf = parseDbf(bytes('countries.dbf'), fs.readFileSync(S('countries.cpg'), 'utf8'));
  assert.strictEqual(dbf.rows.length, 177);
  assert.ok(dbf.rows.some(r => r.NAME === 'Brazil' && r.ISO_A3 === 'BRA'));
  assert.ok(dbf.rows.some(r => r.NAME === "Côte d'Ivoire"), 'UTF-8 names decoded');
  assert.strictEqual(dbfEncoding('1252'), 'windows-1252');
  assert.strictEqual(dbfEncoding('', 0x57), 'windows-1252');
  assert.throws(() => parseShp(new Uint8Array(200)), /not a shapefile/);
});

test('guarded unzip: real ZIP, zip bomb stopped early, not a ZIP', () => {
  const z = safeUnzip(bytes('us-states-tiger.zip'), n => /\.(shp|dbf)$/.test(n));
  assert.deepStrictEqual(Object.keys(z.files).sort(), ['cb_2023_us_state_20m.dbf', 'cb_2023_us_state_20m.shp']);
  assert.strictEqual(z.names.length, 7);
  // 200 MB of zeros packs into about 200 KB
  const bomb = fflate.zipSync({ 'doc.kml': [new Uint8Array(200 * 1024 * 1024), { level: 9 }] });
  assert.ok(bomb.length < 1024 * 1024);
  const t0 = Date.now();
  assert.throws(() => safeUnzip(bomb, () => true), e => e instanceof ZipLimitError && /zip bomb/.test(e.message));
  assert.ok(Date.now() - t0 < 5000);
  assert.throws(() => safeUnzip(new Uint8Array([1, 2, 3, 4]), () => true), /not a ZIP/);
  assert.throws(() => safeUnzip(fflate.zipSync({ 'a.kml': fflate.strToU8('x'.repeat(5000)) }), () => true, { maxEntryBytes: 1000 }), /stopped/);
});

test('KML: styles, folders as layers, NetworkLink counted and never followed, entity bomb removed', () => {
  const k = kmlToGeojson(fs.readFileSync(S('styled-placemarks.kml'), 'utf8'));
  assert.strictEqual(k.fc.features.length, 2);
  assert.ok(k.remoteRefs >= 6);
  let ents = '<!ENTITY lol "lol">';
  for (let i = 1; i <= 9; i++) ents += `<!ENTITY lol${i} "${`&lol${i === 1 ? '' : i - 1};`.repeat(10)}">`;
  const t0 = Date.now();
  const b = kmlToGeojson(`<?xml version="1.0"?><!DOCTYPE kml [${ents}]><kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><name>&lol9;</name><Point><coordinates>1,2</coordinates></Point></Placemark></Document></kml>`);
  assert.ok(Date.now() - t0 < 1000);
  assert.strictEqual(b.entities, 10);
  assert.ok(!JSON.stringify(b.fc).includes('lollollol'));
  const n = kmlToGeojson('<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Folder><name>F</name><Placemark><Point><coordinates>1,2</coordinates></Point></Placemark></Folder><NetworkLink><Link><href>https://x.test/a.kml</href></Link></NetworkLink></Document></kml>');
  assert.strictEqual(n.networkLinks, 1);
  assert.strictEqual(n.layerOf[0], 'F');
  assert.ok(!JSON.stringify(n.fc).includes('"x.test'), 'the link target is not loaded');
  assert.strictEqual(sanitizeXml('<!DOCTYPE x [<!ENTITY a "b">]><x/>').clean, '<x/>');
});

test('GPX stats match gpxpy 1.6.2 and a hand calculation within 1% (blue-hills-hike.gpx)', () => {
  // Reference: gpxpy length_2d / moving data (1 km/h) / time bounds, and a hand haversine sum with raw elevation gain.
  const ref = {
    'BIG LOOP': { gpxpy: 15403.2, hand: 15385.9, duration: 10550, moving: 6249, gain: 282.5 },
    'BUCK HILL': { gpxpy: 18185.6, hand: 18165.3, duration: 12581, moving: 7201, gain: 375.4 },
    'SHORT LOOP': { gpxpy: 18366.5, hand: 18346.0, duration: 19744, moving: 8282, gain: 573.3 },
  };
  const r = loadGeo({ fmt: 'gpx', bytes: bytes('blue-hills-hike.gpx') });
  assert.strictEqual(r.tracks.length, 3);
  for (const t of r.tracks) {
    const x = ref[t.name];
    near(t.distance, x.gpxpy, x.gpxpy * 0.01, `${t.name} distance vs gpxpy`);
    near(t.distance, x.hand, x.hand * 0.001, `${t.name} distance vs hand`);
    near(t.duration, x.duration, x.duration * 0.01, `${t.name} duration`);
    near(t.moving, x.moving, x.moving * 0.01, `${t.name} moving`);
    near(t.gain, x.gain, x.gain * 0.01, `${t.name} gain`);
    assert.ok(t.profile.length > 10);
  }
  near(haversine(0, 0, 1, 0), 111195, 2, 'one degree at the equator');
  const s = trackStats([[[0, 0, 10], [0.001, 0, 20], [0.002, 0, 15]]], [['2020-01-01T00:00:00Z', '2020-01-01T00:01:00Z', '2020-01-01T00:02:00Z']]);
  assert.strictEqual(s.duration, 120);
  assert.strictEqual(s.gain, 10);
  assert.strictEqual(s.loss, 5);
  const g = gpxToGeojson(fs.readFileSync(S('evening-run.gpx'), 'utf8'));
  assert.strictEqual(g.fc.features.length, 1);
});

test('CRS: EPSG codes, .prj WKT, GeoJSON crs member, user input', () => {
  assert.strictEqual(epsgOf('urn:ogc:def:crs:EPSG::3857'), 3857);
  assert.strictEqual(epsgOf('urn:ogc:def:crs:OGC:1.3:CRS84'), 4326);
  assert.strictEqual(epsgOf('EPSG:27700'), 27700);
  const m = makeTransform({ epsg: 3857 }).forward(1113194.9, 1118889.97);
  near(m[0], 10, 1e-6); near(m[1], 10, 1e-6);
  const bng = makeTransform({ epsg: 27700 }).forward(530000, 180000);
  near(bng[0], -0.128, 0.002); near(bng[1], 51.504, 0.002);
  const utm = transformFromUser('32633').forward(500000, 5000000);
  near(utm[0], 15, 1e-6);
  const prj = fs.readFileSync(S('us-states-albers.prj'), 'utf8');
  const al = makeTransform({ wkt: prj });
  assert.match(al.name, /Albers/);
  const back = al.forward(0, 0); // 23N 96W is the origin of EPSG:5070
  near(back[0], -96, 1e-6); near(back[1], 23, 1e-6);
  assert.strictEqual(makeTransform({ epsg: 99999 }).ok, false);
  assert.strictEqual(transformFromUser('hello').ok, false);
  assert.deepStrictEqual(geojsonCrs({ crs: { type: 'name', properties: { name: 'EPSG:2154' } } }), { epsg: 2154 });
});

test('loadGeo: every sample opens with the right counts and places', () => {
  const rows = [
    ['populated-places.geojson', 'geojson', 243], ['populated-places-3857.geojson', 'geojson', 243], ['world-110m.topojson', 'topojson', 178],
    ['styled-placemarks.kml', 'kml', 2], ['placemarks-with-icon.kmz', 'kmz', 2], ['blue-hills-hike.gpx', 'gpx', 49], ['evening-run.gpx', 'gpx', 1],
    ['paris-shapes.wkt', 'wkt', 4], ['us-states-tiger.zip', 'zip', 52],
  ];
  for (const [f, fmt, n] of rows) {
    const r = loadGeo({ fmt, name: f, bytes: bytes(f) });
    const s = buildStore(r.fc, { forward: r.transform.identity ? null : r.transform.forward, layerOf: r.layerOf });
    assert.strictEqual(s.n, n, f);
    assert.strictEqual(s.bad, 0, f);
  }
  // projected shapefile: Denver is in Colorado
  const side = { dbf: bytes('us-states-albers.dbf'), prj: fs.readFileSync(S('us-states-albers.prj'), 'utf8'), cpg: 'UTF-8' };
  const r = loadGeo({ fmt: 'shp', name: 'us-states-albers.shp', bytes: bytes('us-states-albers.shp'), side });
  const s = buildStore(r.fc, { forward: r.transform.forward });
  assert.strictEqual(s.names[hitTest(s, mercX(-104.99), mercY(39.74), 1e-6)], 'Colorado');
  assert.strictEqual(s.names[hitTest(s, mercX(-97.74), mercY(30.27), 1e-6)], 'Texas');
  const fit = fitBoxOf(s), all = boxOf(s, null);
  assert.ok(all[2] - all[0] > 0.9, 'Aleutians cross the antimeridian');
  assert.ok(fit[2] - fit[0] < 0.3 && unmercX(fit[0]) < -120 && unmercX(fit[2]) > -80, 'fit box covers the states, not the whole world');
  // EPSG:3857 GeoJSON lands where the 4326 one does
  const a = buildStore(loadGeo({ fmt: 'geojson', bytes: bytes('populated-places.geojson') }).fc);
  const b3857 = loadGeo({ fmt: 'geojson', bytes: bytes('populated-places-3857.geojson') });
  const b = buildStore(b3857.fc, { forward: b3857.transform.forward });
  const box = (st) => boxOf(st, null);
  box(a).forEach((v, i) => near(v, box(b)[i], 1e-7));
});

test('loadGeo: raw Web Mercator numbers without a crs are detected; broken files give plain messages', () => {
  const fc = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [1113194.9, 1118889.97] } }] };
  const r = loadGeo({ fmt: 'geojson', bytes: new TextEncoder().encode(JSON.stringify(fc)) });
  assert.strictEqual(r.transform.source, 'guess');
  assert.throws(() => loadGeo({ fmt: 'geojson', bytes: new TextEncoder().encode('{"type": "Feat') }), e => e instanceof LoadError && /not valid JSON/.test(e.message));
  assert.throws(() => loadGeo({ fmt: 'json', bytes: new TextEncoder().encode('{"a": 1}') }), /not GeoJSON/);
  assert.throws(() => loadGeo({ fmt: 'geojson', bytes: new Uint8Array(0) }), /empty/);
  const nan = loadGeo({ fmt: 'geojson', bytes: new TextEncoder().encode('{"type":"FeatureCollection","features":[{"type":"Feature","properties":{},"geometry":{"type":"Point","coordinates":[NaN, 1]}}]}') });
  assert.ok(nan.notes.some(n => /NaN/.test(n)));
  const seq = loadGeo({ fmt: 'geojson', bytes: new TextEncoder().encode('{"type":"Feature","properties":{},"geometry":{"type":"Point","coordinates":[1,2]}}\n{"type":"Feature","properties":{},"geometry":{"type":"Point","coordinates":[3,4]}}\n') });
  assert.strictEqual(seq.fc.features.length, 2);
});

test('store: bad coordinates dropped and counted, styles, table helpers, hit priority', () => {
  const fc = { type: 'FeatureCollection', features: [
    { type: 'Feature', properties: { name: 'ok', stroke: '#ff0000', 'marker-color': 'javascript:x' }, geometry: { type: 'Point', coordinates: [10, 20] } },
    { type: 'Feature', properties: { name: 'lat 1000' }, geometry: { type: 'Point', coordinates: [10, 1000] } },
    { type: 'Feature', properties: { name: 'nested' }, geometry: { type: 'Polygon', coordinates: [[[[1, 2]]]] } },
    { type: 'Feature', properties: { name: 'square', city: 'Lyon' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]]] } },
    { type: 'Feature', properties: { name: 'inner' }, geometry: { type: 'Polygon', coordinates: [[[1, 1], [2, 1], [2, 2], [1, 2], [1, 1]]] } },
  ] };
  const s = buildStore(fc);
  assert.strictEqual(s.n, 5);
  assert.strictEqual(s.counts.empty, 2);
  assert.ok(s.bad >= 2);
  assert.strictEqual(s.styles.length, 1);
  assert.strictEqual(s.styles[0].stroke, '#ff0000');
  assert.strictEqual(s.styles[0].mc, null, 'unsafe color dropped');
  assert.deepStrictEqual(filterIds(s, 'lyon'), [3]);
  assert.ok(columnsOf(s).includes('city'));
  const id = hitTest(s, mercX(1.5), mercY(1.5), 1e-9);
  assert.strictEqual(s.names[id], 'inner', 'smallest containing polygon');
  assert.strictEqual(s.names[hitTest(s, mercX(3), mercY(3), 1e-9)], 'square');
  near(unmercX(mercX(12.34)), 12.34, 1e-9); near(unmercY(mercY(-45.6)), -45.6, 1e-9);
});

test('renderer: draws within budget, tiny features become dots, selection outlined', () => {
  const calls = { fill: 0, stroke: 0, lineTo: 0, fillRect: 0 };
  const ctx = new Proxy({}, { get: (t, k) => (k in calls ? (...a) => { calls[k]++; } : typeof k === 'string' && /^(set|begin|move|close|arc|rect|measure|stroke|fill)/.test(k) ? (k === 'measureText' ? () => ({ width: 10 }) : () => {}) : t[k]), set: (t, k, v) => { t[k] = v; return true; } });
  const fc = { type: 'FeatureCollection', features: [] };
  for (let i = 0; i < 2000; i++) fc.features.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[i * 0.01, 0], [i * 0.01 + 0.001, 0], [i * 0.01 + 0.001, 0.001], [i * 0.01, 0]]] } });
  const store = buildStore(fc);
  const view = { cx: mercX(10), cy: mercY(0), scale: 512, w: 800, h: 600, dpr: 1 };
  const out = render(ctx, { base: null, store, view, pal: PALETTES.dark, hidden: new Set(), selected: 5, basemap: false });
  assert.ok(out.dots > 1900, 'world zoom: tiny squares as dots');
  const zoomed = render(ctx, { base: null, store, view: { ...view, cx: mercX(0.0005), cy: mercY(0.0005), scale: 256 * 2 ** 18 }, pal: PALETTES.light, hidden: new Set(), selected: -1 });
  assert.ok(zoomed.drawn >= 1 && zoomed.culled > 1000, 'zoomed in: off-screen features culled');
});
