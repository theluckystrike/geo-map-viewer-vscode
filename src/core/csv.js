'use strict';
// CSV or TSV with latitude/longitude columns (or a WKT column) to GeoJSON points.
const { parseOne } = require('./wkt');

const LAT = ['lat', 'latitude', 'lat_dd', 'y', 'point_y', 'ylat', 'decimallatitude', 'lat_deg'];
const LON = ['lon', 'lng', 'long', 'longitude', 'lon_dd', 'x', 'point_x', 'xlon', 'decimallongitude', 'lon_deg'];
const WKT = ['wkt', 'geometry', 'geom', 'the_geom', 'shape'];

function sniffDelimiter(line) {
  const counts = { ',': 0, ';': 0, '\t': 0, '|': 0 };
  let q = false;
  for (const ch of line) { if (ch === '"') q = !q; else if (!q && ch in counts) counts[ch]++; }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][1] > 0 ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] : ',';
}

/** RFC 4180 rows. Stops after maxRows. */
function parseRows(text, delim, maxRows) {
  const rows = [];
  let row = [], field = '', q = false, i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } q = false; i++; continue; }
      field += ch; i++; continue;
    }
    if (ch === '"' && field === '') { q = true; i++; continue; }
    if (ch === delim) { row.push(field); field = ''; i++; continue; }
    if (ch === '\n' || ch === '\r') {
      row.push(field); field = '';
      if (ch === '\r' && text[i + 1] === '\n') i++;
      i++;
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
      if (rows.length >= maxRows) return { rows, truncated: true };
      continue;
    }
    field += ch; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return { rows, truncated: false };
}

function pick(header, names) {
  const h = header.map(s => String(s).trim().toLowerCase().replace(/[\s"]/g, ''));
  for (const n of names) { const k = h.indexOf(n); if (k >= 0) return k; }
  return -1;
}

/** Parse a coordinate cell: decimal degrees, comma decimals, or degrees with N/S/E/W. */
function num(s) {
  let t = String(s).trim();
  if (!t) return NaN;
  let sign = 1;
  if (/[SW]$/i.test(t)) { sign = -1; t = t.slice(0, -1); } else if (/[NE]$/i.test(t)) t = t.slice(0, -1);
  if (/^-?\d+,\d+$/.test(t)) t = t.replace(',', '.');
  const v = Number(t);
  return Number.isFinite(v) ? v * sign : NaN;
}

/**
 * Returns { fc, latCol, lonCol, wktCol, skipped, error, truncated }.
 * maxRows defaults to 2,000,000 rows.
 */
function csvToGeojson(text, maxRows = 2000000) {
  const src = String(text).replace(/^﻿/, '');
  const firstLine = src.slice(0, src.indexOf('\n') >= 0 ? src.indexOf('\n') : src.length);
  const delim = sniffDelimiter(firstLine);
  const { rows, truncated } = parseRows(src, delim, maxRows + 1);
  if (rows.length < 2) return { error: 'The CSV file has no data rows.' };
  const header = rows[0].map(s => String(s).trim());
  const lat = pick(header, LAT), lon = pick(header, LON), wkt = pick(header, WKT);
  if ((lat < 0 || lon < 0) && wkt < 0) {
    return { error: `No coordinate columns were found. Name them lat and lon (or latitude/longitude, y/x), or add a WKT column. Columns: ${header.slice(0, 20).join(', ')}` };
  }
  const features = [];
  let skipped = 0;
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const props = {};
    for (let c = 0; c < header.length; c++) props[header[c] || `column ${c + 1}`] = row[c] === undefined ? '' : row[c];
    let geometry = null;
    if (lat >= 0 && lon >= 0) {
      const y = num(row[lat]), x = num(row[lon]);
      if (Number.isFinite(x) && Number.isFinite(y)) geometry = { type: 'Point', coordinates: [x, y] };
    }
    if (!geometry && wkt >= 0 && row[wkt]) {
      try { geometry = parseOne(String(row[wkt]).replace(/^SRID=\d+;/i, '')); if (geometry.empty) geometry = null; } catch { geometry = null; }
    }
    if (!geometry) { skipped++; continue; }
    features.push({ type: 'Feature', properties: props, geometry });
  }
  return {
    fc: { type: 'FeatureCollection', features }, skipped, truncated,
    latCol: lat >= 0 ? header[lat] : null, lonCol: lon >= 0 ? header[lon] : null, wktCol: wkt >= 0 ? header[wkt] : null,
  };
}

module.exports = { csvToGeojson, parseRows, sniffDelimiter, num };
