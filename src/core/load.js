'use strict';
// One entry point for every format: bytes in, a GeoJSON FeatureCollection plus layer names, CRS and notes out.
// Pure (no DOM, no network): runs in the webview worker and in Node tests.
const topojson = require('topojson-client');
const { parseWktText } = require('./wkt');
const { csvToGeojson } = require('./csv');
const { shapefileToGeojson } = require('./shp');
const { safeUnzip } = require('./zip');
const { kmlToGeojson, gpxToGeojson } = require('./xmlgeo');
const { makeTransform, transformFromUser, geojsonCrs } = require('./crs');
const { trackStats } = require('./stats');

class LoadError extends Error {}

const utf8 = b => new TextDecoder('utf-8').decode(b);

/** JSON.parse, and on failure a second try with bare NaN / Infinity turned into null (Python writes them). */
function parseJsonLenient(text, notes) {
  try { return JSON.parse(text); } catch (e1) {
    if (/\bNaN\b|\bInfinity\b/.test(text)) {
      const fixed = text.replace(/([:[,]\s*)-?(?:NaN|Infinity)(?=\s*[,\]}])/g, '$1null');
      try { const v = JSON.parse(fixed); notes.push('The file has NaN or Infinity values, which JSON does not allow. They were read as empty values.'); return v; } catch {}
    }
    // GeoJSON Text Sequences / newline-delimited GeoJSON: one Feature per line.
    const lines = text.split(/\r?\n|\x1e/).filter(l => l.trim());
    if (lines.length > 1 && /^\s*\{/.test(lines[0])) {
      try { const feats = lines.map(l => JSON.parse(l)); notes.push(`Read as newline-delimited GeoJSON (${feats.length} lines).`); return { type: 'FeatureCollection', features: feats }; } catch {}
    }
    const m = /position (\d+)/.exec(e1.message);
    let where = '';
    if (m) { const pos = Number(m[1]); const before = text.slice(0, pos); where = ` (line ${before.split('\n').length}, near "${text.slice(Math.max(0, pos - 15), pos + 15).replace(/\s+/g, ' ')}")`; }
    throw new LoadError(`This file is not valid JSON${where}. ${e1.message}`);
  }
}

/** Any GeoJSON object (or TopoJSON) to { fc, layerOf, crsInput, kind }. */
function normalizeJson(obj, notes) {
  if (!obj || typeof obj !== 'object') throw new LoadError('The JSON has no GeoJSON in it.');
  if (obj.type === 'Topology' && obj.objects && typeof obj.objects === 'object') {
    const features = [], layerOf = [];
    for (const [name, o] of Object.entries(obj.objects)) {
      let f;
      try { f = topojson.feature(obj, o); } catch (e) { notes.push(`TopoJSON object "${name}" could not be read: ${e.message}`); continue; }
      const list = f.type === 'FeatureCollection' ? f.features : [f];
      for (const x of list) { features.push(x); layerOf.push(name); }
    }
    return { fc: { type: 'FeatureCollection', features }, layerOf, crsInput: null, kind: 'TopoJSON' };
  }
  const crsInput = geojsonCrs(obj);
  if (obj.type === 'FeatureCollection') return { fc: { type: 'FeatureCollection', features: Array.isArray(obj.features) ? obj.features : [] }, crsInput, kind: 'GeoJSON' };
  if (obj.type === 'Feature') return { fc: { type: 'FeatureCollection', features: [obj] }, crsInput, kind: 'GeoJSON' };
  if (/^(Point|MultiPoint|LineString|MultiLineString|Polygon|MultiPolygon|GeometryCollection)$/.test(obj.type)) {
    return { fc: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: obj }] }, crsInput, kind: 'GeoJSON' };
  }
  if (Array.isArray(obj) && obj.length && obj[0] && obj[0].type === 'Feature') return { fc: { type: 'FeatureCollection', features: obj }, crsInput: null, kind: 'GeoJSON' };
  // Common wrappers: { data: FeatureCollection }, { geojson: ... }
  for (const k of ['data', 'geojson', 'geometry', 'features']) {
    const v = obj[k];
    if (v && typeof v === 'object' && (v.type === 'FeatureCollection' || v.type === 'Feature' || v.type === 'Topology')) return normalizeJson(v, notes);
  }
  throw new LoadError('This JSON is not GeoJSON or TopoJSON: there is no "type": "FeatureCollection", "Feature", a geometry or "Topology" at the top level.');
}

/** Sample up to 20,000 coordinates; report how many are outside longitude/latitude range and the raw extent. */
function scanCoords(fc) {
  let n = 0, out = 0, merc = 0;
  const visit = c => {
    if (n >= 20000 || !Array.isArray(c)) return;
    if (typeof c[0] === 'number') {
      n++;
      const x = c[0], y = c[1];
      if (!(Math.abs(x) <= 180 && Math.abs(y) <= 90)) { out++; if (Math.abs(x) <= 20037509 && Math.abs(y) <= 20048967) merc++; }
      return;
    }
    for (const s of c) visit(s);
  };
  const g = geom => { if (!geom || n >= 20000) return; if (geom.type === 'GeometryCollection') (geom.geometries || []).forEach(g); else visit(geom.coordinates); };
  for (const f of fc.features) { if (n >= 20000) break; g(f && (f.type === 'Feature' ? f.geometry : f)); }
  return { n, out, merc };
}

function pickByExt(files, re) {
  return Object.keys(files).filter(k => re.test(k) && !/(^|\/)__MACOSX\//.test(k));
}

/**
 * input: { fmt, name, bytes: Uint8Array, side: { dbf?, prj?, cpg? } (Uint8Array or string), crs?: string typed by the user }
 * Returns { fc, layerOf, transform, kind, notes, warnings, tracks, info }.
 */
function loadGeo(input) {
  const { fmt, bytes } = input;
  const side = input.side || {};
  const notes = [], warnings = [];
  let fc, layerOf = null, crsInput = null, kind = '', info = {};
  if (!bytes || !bytes.length) throw new LoadError('The file is empty.');
  switch (fmt) {
    case 'geojson': case 'json': case 'topojson': {
      const r = normalizeJson(parseJsonLenient(utf8(bytes), notes), notes);
      ({ fc, kind, crsInput } = r); layerOf = r.layerOf || null;
      break;
    }
    case 'kml': case 'kmz': {
      let text;
      if (fmt === 'kmz') {
        const z = safeUnzip(bytes, n => /\.kml$/i.test(n));
        const kmls = pickByExt(z.files, /\.kml$/i);
        if (!kmls.length) throw new LoadError(`This KMZ has no .kml file inside. Entries: ${z.names.slice(0, 10).join(', ')}`);
        const main = kmls.find(k => /(^|\/)doc\.kml$/i.test(k)) || kmls.sort((a, b) => a.split('/').length - b.split('/').length)[0];
        text = utf8(z.files[main]);
        info.kmzEntries = z.names.length;
        if (kmls.length > 1) notes.push(`The KMZ has ${kmls.length} KML files; ${main} is shown.`);
      } else text = utf8(bytes);
      const r = kmlToGeojson(text);
      if (r.error) throw new LoadError(r.error);
      fc = r.fc; layerOf = r.layerOf; kind = fmt.toUpperCase();
      if (r.entities) warnings.push(`The file declares ${r.entities} XML entities. They were removed before reading, so an entity bomb cannot expand.`);
      if (r.networkLinks) warnings.push(`The KML has ${r.networkLinks} NetworkLink${r.networkLinks > 1 ? 's' : ''} to other files. They are not loaded: the viewer never goes online.`);
      if (r.remoteRefs) notes.push(`${r.remoteRefs} remote link${r.remoteRefs > 1 ? 's' : ''} (icons or overlays) were not loaded. Markers are drawn as dots.`);
      if (r.errors && r.errors.length) notes.push(`XML notes: ${r.errors.slice(0, 2).join('; ')}`);
      info.networkLinks = r.networkLinks; info.remoteRefs = r.remoteRefs; info.entities = r.entities;
      break;
    }
    case 'gpx': {
      const r = gpxToGeojson(utf8(bytes));
      if (r.error) throw new LoadError(r.error);
      fc = r.fc; layerOf = r.layerOf; kind = 'GPX';
      if (r.entities) warnings.push(`The file declares ${r.entities} XML entities. They were removed before reading, so an entity bomb cannot expand.`);
      break;
    }
    case 'shp': {
      const cpg = side.cpg ? (typeof side.cpg === 'string' ? side.cpg : utf8(side.cpg)) : '';
      const r = shapefileToGeojson(bytes, side.dbf || null, cpg);
      fc = r.fc; kind = 'Shapefile';
      if (!side.dbf) notes.push('No .dbf file next to the .shp, so there are no attributes.');
      if (r.dbfError) warnings.push(`The .dbf could not be read: ${r.dbfError}`);
      if (r.bad) warnings.push(`${r.bad} shape records could not be read.`);
      if (side.prj) crsInput = { wkt: typeof side.prj === 'string' ? side.prj : utf8(side.prj) };
      else notes.push('No .prj file next to the .shp. Coordinates are read as longitude/latitude unless you set a CRS.');
      info.shapeType = r.shapeType; info.fields = r.fields.length;
      break;
    }
    case 'zip': {
      const z = safeUnzip(bytes, n => /\.(shp|dbf|prj|cpg|geojson|json|kml|gpx)$/i.test(n));
      const shps = pickByExt(z.files, /\.shp$/i);
      if (shps.length) {
        const features = [];
        layerOf = [];
        let firstPrj = null;
        for (const s of shps) {
          const base = s.replace(/\.shp$/i, '');
          const find = ext => z.files[Object.keys(z.files).find(k => k.toLowerCase() === `${base}.${ext}`.toLowerCase())];
          const r = shapefileToGeojson(z.files[s], find('dbf') || null, find('cpg') ? utf8(find('cpg')) : '');
          const prj = find('prj');
          if (prj && !firstPrj) firstPrj = utf8(prj);
          const layer = base.split('/').pop();
          for (const f of r.fc.features) { features.push(f); layerOf.push(layer); }
          if (r.bad) warnings.push(`${layer}: ${r.bad} shape records could not be read.`);
        }
        if (shps.length > 1) notes.push(`${shps.length} shapefiles in the ZIP, one layer each. The CRS of the first .prj is used for all.`);
        fc = { type: 'FeatureCollection', features };
        kind = 'Zipped shapefile';
        if (firstPrj) crsInput = { wkt: firstPrj };
        break;
      }
      const other = pickByExt(z.files, /\.(geojson|json|kml|gpx)$/i)[0];
      if (!other) throw new LoadError(`No shapefile (.shp), GeoJSON, KML or GPX inside this ZIP. Entries: ${z.names.slice(0, 10).join(', ')}`);
      const ext = other.split('.').pop().toLowerCase();
      const r = loadGeo({ ...input, fmt: ext === 'json' ? 'geojson' : ext, bytes: z.files[other] });
      r.notes.unshift(`Showing ${other} from the ZIP.`);
      return r;
    }
    case 'wkt': {
      const r = parseWktText(utf8(bytes));
      fc = r.fc; kind = 'WKT';
      if (r.srid && r.srid !== 4326) crsInput = { epsg: r.srid };
      if (r.errors.length) (fc.features.length ? warnings : notes).push(...r.errors.slice(0, 3));
      if (!fc.features.length) throw new LoadError(r.errors[0] || 'No WKT geometry was found.');
      break;
    }
    case 'csv': {
      const r = csvToGeojson(utf8(bytes));
      if (r.error) throw new LoadError(r.error);
      fc = r.fc; kind = 'CSV';
      notes.push(r.latCol ? `Coordinates from the columns ${r.latCol} and ${r.lonCol}.` : `Geometry from the WKT column ${r.wktCol}.`);
      if (r.skipped) notes.push(`${r.skipped} rows have no valid coordinates and are not on the map.`);
      if (r.truncated) warnings.push('Only the first 2,000,000 rows are shown.');
      break;
    }
    default:
      throw new LoadError(`Unknown format: ${fmt}`);
  }

  // CRS: what the user typed wins, then the file's own CRS, then a guess for raw Web Mercator numbers.
  let transform;
  if (input.crs && String(input.crs).trim()) {
    transform = transformFromUser(input.crs);
    if (!transform.ok) throw new LoadError(transform.error);
    transform.source = 'you';
  } else if (crsInput) {
    transform = makeTransform(crsInput);
    if (!transform.ok) { warnings.push(transform.error); transform = makeTransform({}); }
    transform.source = 'file';
  } else {
    transform = makeTransform({});
    transform.source = 'default';
    if (kind !== 'GPX' && kind !== 'KML' && kind !== 'KMZ') {
      const s = scanCoords(fc);
      if (s.n && s.out / s.n > 0.5) {
        if (s.merc === s.out) {
          transform = makeTransform({ epsg: 3857 }); transform.source = 'guess';
          notes.push('The coordinates are not longitude/latitude and fit Web Mercator, so they are read as EPSG:3857. Type another CRS in the panel if the map looks wrong.');
        } else {
          warnings.push(`${Math.round((100 * s.out) / s.n)}% of the coordinates are outside longitude/latitude range. Type the CRS of the file (an EPSG code, proj4 string or WKT) in the panel.`);
          info.needsCrs = true;
        }
      }
    }
  }

  // Track stats for GPX tracks and lines with elevation (up to 200 lines).
  const tracks = [];
  const lineIdx = [];
  fc.features.forEach((f, i) => { const g = f && f.geometry; if (g && (g.type === 'LineString' || g.type === 'MultiLineString')) lineIdx.push(i); });
  if (lineIdx.length && lineIdx.length <= 200) {
    for (const i of lineIdx) {
      const f = fc.features[i];
      const g = f.geometry;
      let segs = g.type === 'LineString' ? [g.coordinates] : g.coordinates;
      if (!transform.identity) segs = segs.map(s => s.map(c => { const r = transform.forward(c[0], c[1]); return [r[0], r[1], c[2]]; }));
      const cp = f.properties && f.properties.coordinateProperties;
      let times = cp && cp.times;
      if (times && g.type === 'LineString') times = [times];
      const st = trackStats(segs, times || null);
      if (kind === 'GPX' || st.hasEle || st.duration != null) tracks.push({ id: i, name: (f.properties && (f.properties.name || f.properties._gpxType)) || `Line ${i + 1}`, ...st, profile: tracks.length < 50 ? st.profile : [] });
    }
  }
  return { fc, layerOf, transform, kind, notes, warnings, tracks, info };
}

module.exports = { loadGeo, parseJsonLenient, normalizeJson, scanCoords, LoadError };
