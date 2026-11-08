// Builds the sample set from downloaded public files, plus the derived, large and hostile files for the gate.
// usage: node scripts/make-samples.mjs <rawDir> <samplesOut> [<gateExtrasOut>]
//   rawDir: Natural Earth 110m countries (shp, shx, dbf, prj, cpg) and populated places GeoJSON, TIGER
//   cb_2023_us_state_20m.zip, togeojson fixtures (styles.kml, networklink.kml, blue_hills.gpx,
//   Friday-Evening-Run.gpx), USGS earthquakes-week.csv.
//   gateExtrasOut (never in the repo): a 100 MB GeoJSON, a KMZ zip bomb, a hostile KML and bad coordinates.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const proj4 = require('proj4');
const fflate = require('fflate');
const { parseShp, parseDbf } = require('../src/core/shp.js');
const { safeUnzip } = require('../src/core/zip.js');

const [raw, out, extra] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const cp = (a, b) => fs.copyFileSync(path.join(raw, a), path.join(out, b));

// 1-7: real files, renamed
cp('ne_110m_populated_places_simple.geojson', 'populated-places.geojson');
for (const e of ['shp', 'shx', 'dbf', 'prj', 'cpg']) cp(`ne_110m_admin_0_countries.${e}`, `countries.${e}`);
cp('cb_2023_us_state_20m.zip', 'us-states-tiger.zip');
fs.copyFileSync(new URL('../node_modules/world-atlas/countries-110m.json', import.meta.url), path.join(out, 'world-110m.topojson'));
cp('styles.kml', 'styled-placemarks.kml');
cp('blue_hills.gpx', 'blue-hills-hike.gpx');
cp('Friday-Evening-Run.gpx', 'evening-run.gpx');
cp('earthquakes-week.csv', 'earthquakes-week.csv');

// 8: KMZ with an embedded icon (styles.kml as doc.kml + a 16x16 PNG made here)
const png = (() => {
  // smallest valid PNG: 1x1 orange pixel
  return Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', 'base64'));
})();
const kmlText = fs.readFileSync(path.join(raw, 'styles.kml'), 'utf8').replace(/https:\/\/earth\.google\.com\/earth\/rpc\/cc\/icon\?[^<]*/g, 'files/icon.png');
fs.writeFileSync(path.join(out, 'placemarks-with-icon.kmz'), fflate.zipSync({ 'doc.kml': fflate.strToU8(kmlText), 'files/icon.png': [png, { level: 0 }] }));

// 9: TIGER states reprojected to EPSG:5070 (NAD83 / Conus Albers) as a shapefile with an ESRI .prj
const z = safeUnzip(fs.readFileSync(path.join(raw, 'cb_2023_us_state_20m.zip')), n => /\.(shp|dbf)$/i.test(n)).files;
const shp = parseShp(z['cb_2023_us_state_20m.shp']);
const dbf = parseDbf(z['cb_2023_us_state_20m.dbf'], 'utf-8');
const P5070 = '+proj=aea +lat_0=23 +lon_0=-96 +lat_1=29.5 +lat_2=45.5 +x_0=0 +y_0=0 +datum=NAD83 +units=m +no_defs';
const toAlbers = proj4('+proj=longlat +datum=NAD83 +no_defs', P5070);
const polys = shp.geometries.map(g => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).map(p => p.map(r => r.map(c => toAlbers.forward([c[0], c[1]])))));
writeShapefile(path.join(out, 'us-states-albers'), polys, dbf.rows.map(r => ({ NAME: r.NAME, STUSPS: r.STUSPS, GEOID: r.GEOID })));
fs.writeFileSync(path.join(out, 'us-states-albers.prj'), 'PROJCS["NAD_1983_Contiguous_USA_Albers",GEOGCS["GCS_North_American_1983",DATUM["D_North_American_1983",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Albers"],PARAMETER["False_Easting",0.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",-96.0],PARAMETER["Standard_Parallel_1",29.5],PARAMETER["Standard_Parallel_2",45.5],PARAMETER["Latitude_Of_Origin",23.0],UNIT["Meter",1.0]]');

// 10: populated places in EPSG:3857 with a GeoJSON "crs" member
const pp = JSON.parse(fs.readFileSync(path.join(raw, 'ne_110m_populated_places_simple.geojson'), 'utf8'));
const merc = proj4('EPSG:4326', 'EPSG:3857');
const pp3857 = { type: 'FeatureCollection', crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::3857' } },
  features: pp.features.map(f => ({ type: 'Feature', properties: { name: f.properties.name, adm0name: f.properties.adm0name, pop_max: f.properties.pop_max }, geometry: { type: 'Point', coordinates: merc.forward(f.geometry.coordinates).map(v => Math.round(v * 100) / 100) } })) };
fs.writeFileSync(path.join(out, 'populated-places-3857.geojson'), JSON.stringify(pp3857));

// 11: WKT (EWKT with SRID), a few shapes around Paris
fs.writeFileSync(path.join(out, 'paris-shapes.wkt'), [
  'SRID=4326;POINT(2.2945 48.8584)',
  'LINESTRING(2.2945 48.8584, 2.3376 48.8606, 2.3499 48.8530, 2.3522 48.8566)',
  'POLYGON((2.2242 48.8156, 2.4699 48.8156, 2.4699 48.9022, 2.2242 48.9022, 2.2242 48.8156),(2.32 48.85, 2.36 48.85, 2.36 48.87, 2.32 48.87, 2.32 48.85))',
  'MULTIPOINT((2.3376 48.8606),(2.3499 48.8530))',
].join('\n') + '\n');

if (extra) {
  fs.mkdirSync(extra, { recursive: true });
  // hostile 1: NetworkLink + remote icons + an entity declaration
  fs.writeFileSync(path.join(extra, 'hostile-remote-links.kml'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE kml [ <!ENTITY ext SYSTEM "https://example.com/secret.txt"> <!ENTITY a "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"> ]>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Remote links &a;</name>
<Style id="remote"><IconStyle><Icon><href>https://example.com/tracker.png?id=1</href></Icon></IconStyle></Style>
<NetworkLink><name>Live layer</name><Link><href>https://example.com/live.kml</href><refreshMode>onInterval</refreshMode><refreshInterval>1</refreshInterval></Link></NetworkLink>
<NetworkLink><name>Second</name><Url><href>http://example.org/more.kmz</href></Url></NetworkLink>
<GroundOverlay><name>Remote image</name><Icon><href>https://example.com/overlay.jpg</href></Icon><LatLonBox><north>52.6</north><south>52.4</south><east>13.5</east><west>13.2</west></LatLonBox></GroundOverlay>
<Folder><name>Visible</name><Placemark><name>Berlin &ext;</name><styleUrl>#remote</styleUrl><Point><coordinates>13.405,52.52</coordinates></Point></Placemark>
<Placemark><name>Potsdam</name><styleUrl>#remote</styleUrl><Point><coordinates>13.0645,52.3906</coordinates></Point></Placemark></Folder>
</Document></kml>
`);
  // hostile 2: billion laughs
  let ents = '<!ENTITY lol "lol">';
  for (let i = 1; i <= 9; i++) ents += `<!ENTITY lol${i} "${`&lol${i === 1 ? '' : i - 1};`.repeat(10)}">`;
  fs.writeFileSync(path.join(extra, 'hostile-entity-bomb.kml'), `<?xml version="1.0"?>\n<!DOCTYPE kml [${ents}]>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><name>&lol9;</name><Point><coordinates>0,0</coordinates></Point></Placemark></Document></kml>\n`);
  // hostile 3: KMZ zip bomb, doc.kml unpacks to 1.5 GB of spaces (streamed, so this script stays small)
  {
    const chunks = [];
    const zip = new fflate.Zip((err, data) => { if (err) throw err; chunks.push(data); });
    const f = new fflate.ZipDeflate('doc.kml', { level: 9 });
    zip.add(f);
    f.push(fflate.strToU8('<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>'));
    const block = new Uint8Array(16 * 1024 * 1024).fill(0x20);
    for (let i = 0; i < 96; i++) f.push(block);
    f.push(fflate.strToU8('</name></Document></kml>'), true);
    zip.end();
    fs.writeFileSync(path.join(extra, 'hostile-zip-bomb.kmz'), Buffer.concat(chunks.map(c => Buffer.from(c))));
  }
  // hostile 4: bad coordinates: bare NaN, latitude 1000, a 1,000,000-vertex ring, strings, nulls
  {
    const w = fs.createWriteStream(path.join(extra, 'hostile-bad-coords.geojson'));
    w.write('{"type":"FeatureCollection","features":[\n');
    w.write('{"type":"Feature","properties":{"name":"NaN point"},"geometry":{"type":"Point","coordinates":[NaN, 10]}},\n');
    w.write('{"type":"Feature","properties":{"name":"lat 1000"},"geometry":{"type":"Point","coordinates":[10, 1000]}},\n');
    w.write('{"type":"Feature","properties":{"name":"string coords"},"geometry":{"type":"LineString","coordinates":[["a","b"],[1,2],[3,4]]}},\n');
    w.write('{"type":"Feature","properties":{"name":"null geometry"},"geometry":null},\n');
    w.write('{"type":"Feature","properties":{"name":"deep nesting"},"geometry":{"type":"Polygon","coordinates":[[[[[[1,2]]]]]]}},\n');
    w.write('{"type":"Feature","properties":{"name":"good point"},"geometry":{"type":"Point","coordinates":[-0.1276,51.5072]}},\n');
    w.write('{"type":"Feature","properties":{"name":"1M-vertex ring"},"geometry":{"type":"Polygon","coordinates":[[');
    const N = 1000000;
    let buf = [];
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2;
      const r = 3 + 0.4 * Math.sin(a * 40);
      buf.push(`[${(10 + r * Math.cos(a)).toFixed(6)},${(50 + r * Math.sin(a) * 0.6).toFixed(6)}]`);
      if (buf.length === 50000) { w.write(buf.join(',') + (i < N ? ',' : '')); buf = []; }
    }
    if (buf.length) w.write(buf.join(','));
    w.write(']]}}\n]}\n');
    await new Promise(r => w.end(r));
  }
  // large: about 100 MB GeoJSON, 200,000 polygons with properties (streamed)
  {
    const w = fs.createWriteStream(path.join(extra, 'large-200k-parcels.geojson'));
    w.write('{"type":"FeatureCollection","features":[\n');
    // mulberry32: 32-bit integer math, so every parcel gets its own place (a float LCG repeats after a few hundred)
    let seed = 42;
    const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const N = 200000;
    for (let i = 0; i < N; i++) {
      const cx = -125 + rnd() * 58, cy = 25 + rnd() * 24, r = 0.02 + rnd() * 0.05;
      const ring = [];
      const n = 16 + Math.floor(rnd() * 8);
      for (let k = 0; k < n; k++) { const a = (k / n) * Math.PI * 2; const rr = r * (0.7 + rnd() * 0.3); ring.push(`[${(cx + rr * Math.cos(a)).toFixed(6)},${(cy + rr * Math.sin(a)).toFixed(6)}]`); }
      ring.push(ring[0]);
      const s = `{"type":"Feature","properties":{"parcel_id":"P${String(i).padStart(7, '0')}","zone":"${['R1', 'R2', 'C1', 'I1', 'AG'][i % 5]}","area_ha":${(r * r * 3000).toFixed(2)},"owner":"Owner ${i % 997}","year":${1950 + (i % 70)}},"geometry":{"type":"Polygon","coordinates":[[${ring.join(',')}]]}}${i < N - 1 ? ',' : ''}\n`;
      if (!w.write(s)) await new Promise(r => w.once('drain', r));
    }
    w.write(']}\n');
    await new Promise(r => w.end(r));
  }
  // also the real NetworkLink fixture
  fs.copyFileSync(path.join(raw, 'networklink.kml'), path.join(extra, 'networklink-fixture.kml'));
}
for (const d of [out, extra].filter(Boolean)) for (const f of fs.readdirSync(d).sort()) console.log(d === out ? 'samples' : 'extra', f, fs.statSync(path.join(d, f)).size);

/** Minimal polygon shapefile writer (shp, shx, dbf with C fields). */
function writeShapefile(base, polygons, rows) {
  const recs = polygons.map(rings2 => {
    const rings = rings2.flat();
    const n = rings.reduce((s, r) => s + r.length, 0);
    const len = 44 + 4 * rings.length + 16 * n;
    const b = Buffer.alloc(8 + len);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of rings) for (const [x, y] of r) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    b.writeInt32LE(5, 8); b.writeDoubleLE(x0, 12); b.writeDoubleLE(y0, 20); b.writeDoubleLE(x1, 28); b.writeDoubleLE(y1, 36);
    b.writeInt32LE(rings.length, 44); b.writeInt32LE(n, 48);
    let o = 52, k = 0;
    for (const r of rings) { b.writeInt32LE(k, o); o += 4; k += r.length; }
    for (const r of rings) for (const [x, y] of r) { b.writeDoubleLE(x, o); b.writeDoubleLE(y, o + 8); o += 16; }
    return { b, len, box: [x0, y0, x1, y1] };
  });
  const box = recs.reduce((a, r) => [Math.min(a[0], r.box[0]), Math.min(a[1], r.box[1]), Math.max(a[2], r.box[2]), Math.max(a[3], r.box[3])], [Infinity, Infinity, -Infinity, -Infinity]);
  const header = total => { const h = Buffer.alloc(100); h.writeInt32BE(9994, 0); h.writeInt32BE(total / 2, 24); h.writeInt32LE(1000, 28); h.writeInt32LE(5, 32); box.forEach((v, i) => h.writeDoubleLE(v, 36 + i * 8)); return h; };
  let off = 100;
  const shx = [];
  recs.forEach((r, i) => { r.b.writeInt32BE(i + 1, 0); r.b.writeInt32BE(r.len / 2, 4); shx.push([off, r.len]); off += 8 + r.len; });
  fs.writeFileSync(base + '.shp', Buffer.concat([header(off), ...recs.map(r => r.b)]));
  const sx = Buffer.alloc(8 * shx.length); shx.forEach(([o, l], i) => { sx.writeInt32BE(o / 2, i * 8); sx.writeInt32BE(l / 2, i * 8 + 4); });
  fs.writeFileSync(base + '.shx', Buffer.concat([header(100 + sx.length), sx]));
  const fields = Object.keys(rows[0]).map(name => ({ name, len: Math.max(1, ...rows.map(r => Buffer.byteLength(String(r[name] ?? ''), 'utf8'))) }));
  const hl = 32 + 32 * fields.length + 1, rl = 1 + fields.reduce((s, f) => s + f.len, 0);
  const d = Buffer.alloc(hl + rl * rows.length + 1, 0x20);
  d.fill(0, 0, hl);
  d[0] = 3; d[1] = 126; d[2] = 11; d[3] = 8; d.writeUInt32LE(rows.length, 4); d.writeUInt16LE(hl, 8); d.writeUInt16LE(rl, 10);
  fields.forEach((f, i) => { d.write(f.name, 32 + i * 32, 'latin1'); d[32 + i * 32 + 11] = 0x43; d[32 + i * 32 + 16] = f.len; });
  d[hl - 1] = 0x0d;
  rows.forEach((r, i) => { let o = hl + i * rl + 1; for (const f of fields) { d.write(String(r[f.name] ?? ''), o, 'utf8'); o += f.len; } });
  d[d.length - 1] = 0x1a;
  fs.writeFileSync(base + '.dbf', d);
  fs.writeFileSync(base + '.cpg', 'UTF-8');
}
