'use strict';
// WKT and EWKT (SRID=4326;POINT(...)) to GeoJSON geometries. One geometry per line or per ';'-free statement.

class WktError extends Error {}

function tokenize(s) {
  const out = [];
  const re = /\s*([A-Za-z]+|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|NaN|[(),])/y;
  let m;
  re.lastIndex = 0;
  while (re.lastIndex < s.length) {
    const at = re.lastIndex;
    m = re.exec(s);
    if (!m) {
      if (/^\s*$/.test(s.slice(at))) break;
      throw new WktError(`Unexpected text at position ${at}: "${s.slice(at, at + 20)}"`);
    }
    out.push(m[1]);
  }
  return out;
}

function parseOne(text) {
  const t = tokenize(text);
  let i = 0;
  const peek = () => t[i];
  const next = () => t[i++];
  const expect = v => { const x = next(); if (x !== v) throw new WktError(`Expected "${v}" and found "${x === undefined ? 'end of text' : x}".`); };
  let dims = 2;
  const coord = () => {
    const c = [];
    while (peek() !== undefined && peek() !== ',' && peek() !== ')') {
      const v = Number(next());
      c.push(v);
    }
    if (c.length < 2) throw new WktError('A coordinate needs at least 2 numbers.');
    return c.slice(0, dims === 4 ? 3 : Math.min(c.length, 3));
  };
  const list = item => {
    expect('(');
    const out = [item()];
    while (peek() === ',') { next(); out.push(item()); }
    expect(')');
    return out;
  };
  const pointInMulti = () => { if (peek() === '(') { next(); const c = coord(); expect(')'); return c; } return coord(); };
  const geom = () => {
    const kind = String(next() || '').toUpperCase();
    dims = 2;
    while (/^(Z|M|ZM)$/i.test(peek() || '')) { const d = next().toUpperCase(); dims = d === 'ZM' ? 4 : 3; }
    if (String(peek()).toUpperCase() === 'EMPTY') { next(); return { type: TYPES[kind] || 'GeometryCollection', coordinates: [] , empty: true }; }
    switch (kind) {
      case 'POINT': { expect('('); const c = coord(); expect(')'); return { type: 'Point', coordinates: c }; }
      case 'LINESTRING': return { type: 'LineString', coordinates: list(coord) };
      case 'POLYGON': return { type: 'Polygon', coordinates: list(() => list(coord)) };
      case 'MULTIPOINT': return { type: 'MultiPoint', coordinates: list(pointInMulti) };
      case 'MULTILINESTRING': return { type: 'MultiLineString', coordinates: list(() => list(coord)) };
      case 'MULTIPOLYGON': return { type: 'MultiPolygon', coordinates: list(() => list(() => list(coord))) };
      case 'GEOMETRYCOLLECTION': return { type: 'GeometryCollection', geometries: list(geom) };
      default: throw new WktError(`Unknown WKT type "${kind}".`);
    }
  };
  const g = geom();
  if (i < t.length) throw new WktError(`Extra text after the geometry: "${t.slice(i, i + 4).join(' ')}"`);
  return g;
}

const TYPES = { POINT: 'Point', LINESTRING: 'LineString', POLYGON: 'Polygon', MULTIPOINT: 'MultiPoint', MULTILINESTRING: 'MultiLineString', MULTIPOLYGON: 'MultiPolygon', GEOMETRYCOLLECTION: 'GeometryCollection' };
const START = /\b(POINT|LINESTRING|POLYGON|MULTIPOINT|MULTILINESTRING|MULTIPOLYGON|GEOMETRYCOLLECTION)\b/gi;

/**
 * Parse a .wkt file: one or more geometries. Returns { fc, srid, errors }.
 * Geometries are split at each top-level keyword, so both one-per-line files and long single lines work.
 */
function parseWktText(text) {
  const src = String(text).replace(/^﻿/, '');
  let srid = null;
  const sm = /SRID\s*=\s*(\d+)\s*;/i.exec(src);
  if (sm) srid = Number(sm[1]);
  const clean = src.replace(/SRID\s*=\s*\d+\s*;/gi, ' ');
  // Split at top-level keywords (depth 0).
  const pieces = [];
  let depth = 0, start = -1;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && /[A-Za-z]/.test(ch) && (i === 0 || !/[A-Za-z]/.test(clean[i - 1]))) {
      START.lastIndex = i;
      const m = START.exec(clean);
      if (m && m.index === i) { if (start >= 0) pieces.push(clean.slice(start, i)); start = i; i += m[0].length - 1; }
    }
  }
  if (start >= 0) pieces.push(clean.slice(start));
  const features = [];
  const errors = [];
  pieces.forEach((p, k) => {
    const body = p.replace(/[;\s]+$/, '');
    try {
      const g = parseOne(body);
      features.push({ type: 'Feature', properties: { '#': k + 1, wkt: body.length > 120 ? body.slice(0, 117) + '...' : body }, geometry: g.empty ? null : g });
    } catch (e) {
      errors.push(`Geometry ${k + 1}: ${e.message}`);
    }
  });
  if (!pieces.length) errors.push('No WKT geometry was found (POINT, LINESTRING, POLYGON, MULTI..., GEOMETRYCOLLECTION).');
  return { fc: { type: 'FeatureCollection', features }, srid, errors };
}

module.exports = { parseWktText, parseOne, WktError };
