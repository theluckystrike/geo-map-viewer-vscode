'use strict';
// Shapefile (.shp + .dbf) reader. Plain JS, no dependencies. Shape types 1, 3, 5, 8 and their Z and M variants.

class ShpError extends Error {}

function ringArea(ring) {
  let a = 0;
  for (let i = 0, n = ring.length, j = n - 1; i < n; j = i++) a += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  return a / 2; // > 0 for clockwise rings in a y-up system
}

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Shapefile rings: clockwise = outer, counter-clockwise = hole. Holes go to the outer ring that contains them. */
function ringsToPolygon(rings) {
  const outers = [], holes = [];
  for (const r of rings) (ringArea(r) >= 0 ? outers : holes).push(r);
  if (!outers.length) return { type: 'Polygon', coordinates: rings };
  const polys = outers.map(o => [o]);
  for (const h of holes) {
    const p = h[0];
    let k = polys.findIndex(poly => pointInRing(p[0], p[1], poly[0]));
    if (k < 0) k = 0;
    polys[k].push(h);
  }
  return polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys };
}

/**
 * Parse .shp bytes. Returns { type, bbox, geometries, bad } where geometries[i] is a GeoJSON geometry or null.
 * maxRecords stops early (the caller shows a message).
 */
function parseShp(bytes, maxRecords = 5000000) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 100) throw new ShpError('The .shp file is shorter than its 100-byte header.');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (dv.getInt32(0, false) !== 9994) throw new ShpError('This is not a shapefile: the .shp header code is not 9994.');
  const shapeType = dv.getInt32(32, true);
  const bbox = [dv.getFloat64(36, true), dv.getFloat64(44, true), dv.getFloat64(52, true), dv.getFloat64(60, true)];
  const geometries = [];
  let off = 100, bad = 0;
  while (off + 8 <= b.length && geometries.length < maxRecords) {
    const len = dv.getInt32(off + 4, false) * 2;
    const start = off + 8;
    off = start + len;
    if (len < 4 || off > b.length) { bad++; break; }
    const t = dv.getInt32(start, true);
    try {
      geometries.push(readShape(dv, start, len, t));
    } catch {
      bad++; geometries.push(null);
    }
  }
  return { type: shapeType, bbox, geometries, bad, truncated: off + 8 <= b.length && geometries.length >= maxRecords };
}

function readShape(dv, p, len, t) {
  if (t === 0) return null;
  const hasZ = t === 11 || t === 13 || t === 15 || t === 18;
  const base = t % 10;
  const end = p + len;
  if (base === 1) { // point
    const x = dv.getFloat64(p + 4, true), y = dv.getFloat64(p + 12, true);
    const c = [x, y];
    if (hasZ && p + 28 <= end) c.push(dv.getFloat64(p + 20, true));
    return { type: 'Point', coordinates: c };
  }
  if (base === 8) { // multipoint
    const n = dv.getInt32(p + 36, true);
    if (n < 0 || p + 40 + n * 16 > end) throw new ShpError('bad multipoint');
    const pts = [];
    for (let i = 0; i < n; i++) pts.push([dv.getFloat64(p + 40 + i * 16, true), dv.getFloat64(p + 48 + i * 16, true)]);
    if (hasZ) { const zo = p + 40 + n * 16 + 16; if (zo + n * 8 <= end) for (let i = 0; i < n; i++) pts[i].push(dv.getFloat64(zo + i * 8, true)); }
    return { type: 'MultiPoint', coordinates: pts };
  }
  if (base === 3 || base === 5) { // polyline, polygon
    const np = dv.getInt32(p + 36, true), n = dv.getInt32(p + 40, true);
    if (np < 0 || n < 0 || p + 44 + np * 4 + n * 16 > end) throw new ShpError('bad part table');
    const parts = [];
    for (let i = 0; i < np; i++) parts.push(dv.getInt32(p + 44 + i * 4, true));
    const po = p + 44 + np * 4;
    const pts = new Array(n);
    for (let i = 0; i < n; i++) pts[i] = [dv.getFloat64(po + i * 16, true), dv.getFloat64(po + i * 16 + 8, true)];
    if (hasZ) { const zo = po + n * 16 + 16; if (zo + n * 8 <= end) for (let i = 0; i < n; i++) pts[i].push(dv.getFloat64(zo + i * 8, true)); }
    const rings = parts.map((s, i) => pts.slice(s, i + 1 < parts.length ? parts[i + 1] : n)).filter(r => r.length);
    if (base === 3) return rings.length === 1 ? { type: 'LineString', coordinates: rings[0] } : { type: 'MultiLineString', coordinates: rings };
    return ringsToPolygon(rings);
  }
  if (t === 31) throw new ShpError('multipatch is not supported');
  throw new ShpError('unknown shape type ' + t);
}

/** Decoder label from a .cpg file or the DBF language byte. */
function dbfEncoding(cpg, ldid) {
  const c = String(cpg || '').trim().toLowerCase();
  if (c) {
    if (/utf-?8/.test(c)) return 'utf-8';
    if (/^(\d{3,5})$/.test(c)) return { 1250: 'windows-1250', 1251: 'windows-1251', 1252: 'windows-1252', 1253: 'windows-1253', 1254: 'windows-1254', 1255: 'windows-1255', 1256: 'windows-1256', 1257: 'windows-1257', 1258: 'windows-1258', 437: 'ibm866', 850: 'windows-1252', 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5', 65001: 'utf-8' }[c] || 'utf-8';
    const m = /(?:iso-?8859-?|latin)(\d+)/.exec(c);
    if (m) return `iso-8859-${m[1]}`;
    return c;
  }
  const byLdid = { 0x57: 'windows-1252', 0x03: 'windows-1252', 0x01: 'ibm866', 0xc8: 'windows-1250', 0xc9: 'windows-1251', 0x4d: 'gbk', 0x13: 'shift_jis' };
  return byLdid[ldid] || 'utf-8';
}

function decoder(label) {
  try { return new TextDecoder(label); } catch { return new TextDecoder('utf-8'); }
}

/** Parse .dbf bytes. Returns { fields, rows } where rows are plain objects. */
function parseDbf(bytes, cpg, maxRows = 5000000) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 32) throw new ShpError('The .dbf file is shorter than its header.');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const n = dv.getUint32(4, true), headerLen = dv.getUint16(8, true), recLen = dv.getUint16(10, true);
  const dec = decoder(dbfEncoding(cpg, b[29]));
  const ascii = new TextDecoder('latin1');
  const fields = [];
  for (let o = 32; o + 32 <= headerLen && b[o] !== 0x0d; o += 32) {
    let nameEnd = o; while (nameEnd < o + 11 && b[nameEnd] !== 0) nameEnd++;
    fields.push({ name: dec.decode(b.subarray(o, nameEnd)).trim(), type: String.fromCharCode(b[o + 11]), len: b[o + 16], dec: b[o + 17] });
  }
  const rows = [];
  const count = Math.min(n, maxRows);
  for (let r = 0; r < count; r++) {
    const o = headerLen + r * recLen;
    if (o + recLen > b.length) break;
    const row = {};
    let fo = o + 1;
    for (const f of fields) {
      const raw = b.subarray(fo, fo + f.len);
      fo += f.len;
      let v;
      if (f.type === 'C' || f.type === 'M' || f.type === 'V') v = dec.decode(raw).replace(/[\s\0]+$/, '');
      else {
        const s = ascii.decode(raw).trim();
        if (f.type === 'N' || f.type === 'F' || f.type === 'O') v = s === '' || /^\*+$/.test(s) ? null : Number(s);
        else if (f.type === 'L') v = /^[YyTt]$/.test(s) ? true : /^[NnFf]$/.test(s) ? false : null;
        else if (f.type === 'D') v = /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s || null;
        else v = s;
      }
      row[f.name] = v;
    }
    rows.push(row);
  }
  return { fields, rows };
}

/** shp + optional dbf to a FeatureCollection. */
function shapefileToGeojson(shpBytes, dbfBytes, cpg) {
  const shp = parseShp(shpBytes);
  let dbf = null, dbfError = null;
  if (dbfBytes) { try { dbf = parseDbf(dbfBytes, cpg); } catch (e) { dbfError = e.message; } }
  const features = shp.geometries.map((g, i) => ({ type: 'Feature', properties: dbf && dbf.rows[i] ? dbf.rows[i] : { '#': i + 1 }, geometry: g }));
  return { fc: { type: 'FeatureCollection', features }, shapeType: shp.type, bad: shp.bad, truncated: shp.truncated, fields: dbf ? dbf.fields : [], dbfError };
}

module.exports = { parseShp, parseDbf, shapefileToGeojson, dbfEncoding, ringsToPolygon, ringArea, ShpError };
