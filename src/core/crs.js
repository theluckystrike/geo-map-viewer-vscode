'use strict';
// Coordinate reference systems: .prj (WKT), GeoJSON "crs" members, EPSG codes typed by the user.
// Everything is reprojected to longitude/latitude (WGS 84) with proj4. No lookup goes to the network:
// codes outside the table below need a .prj file or a proj4 string.
const proj4 = require('proj4');

const DEFS = {
  4326: '+proj=longlat +datum=WGS84 +no_defs',
  4269: '+proj=longlat +datum=NAD83 +no_defs',
  4258: '+proj=longlat +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +no_defs',
  4283: '+proj=longlat +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +no_defs',
  4617: '+proj=longlat +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +no_defs',
  3857: '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs',
  3395: '+proj=merc +lon_0=0 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs',
  27700: '+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 +units=m +no_defs',
  2154: '+proj=lcc +lat_0=46.5 +lon_0=3 +lat_1=49 +lat_2=44 +x_0=700000 +y_0=6600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  28992: '+proj=sterea +lat_0=52.1561605555556 +lon_0=5.38763888888889 +k=0.9999079 +x_0=155000 +y_0=463000 +ellps=bessel +towgs84=565.417,50.3319,465.552,-0.398957,0.343988,-1.8774,4.0725 +units=m +no_defs',
  3035: '+proj=laea +lat_0=52 +lon_0=10 +x_0=4321000 +y_0=3210000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  5070: '+proj=aea +lat_0=23 +lon_0=-96 +lat_1=29.5 +lat_2=45.5 +x_0=0 +y_0=0 +datum=NAD83 +units=m +no_defs',
  3577: '+proj=aea +lat_0=0 +lon_0=132 +lat_1=-18 +lat_2=-36 +x_0=0 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  2193: '+proj=tmerc +lat_0=0 +lon_0=173 +k=0.9996 +x_0=1600000 +y_0=10000000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  2056: '+proj=somerc +lat_0=46.9524055555556 +lon_0=7.43958333333333 +k_0=1 +x_0=2600000 +y_0=1200000 +ellps=bessel +towgs84=674.374,15.056,405.346,0,0,0,0 +units=m +no_defs',
  3006: '+proj=utm +zone=33 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  2263: '+proj=lcc +lat_0=40.1666666666667 +lon_0=-74 +lat_1=41.0333333333333 +lat_2=40.6666666666667 +x_0=300000 +y_0=0 +datum=NAD83 +units=us-ft +no_defs',
};
DEFS[900913] = DEFS[3857];
DEFS[102100] = DEFS[3857];
for (let z = 1; z <= 60; z++) {
  DEFS[32600 + z] = `+proj=utm +zone=${z} +datum=WGS84 +units=m +no_defs`;
  DEFS[32700 + z] = `+proj=utm +zone=${z} +south +datum=WGS84 +units=m +no_defs`;
}
for (let z = 1; z <= 23; z++) DEFS[26900 + z] = `+proj=utm +zone=${z} +datum=NAD83 +units=m +no_defs`;
for (let z = 28; z <= 38; z++) DEFS[25800 + z] = `+proj=utm +zone=${z} +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs`;

const NAMES = { 4326: 'WGS 84', 4269: 'NAD83', 4258: 'ETRS89', 3857: 'WGS 84 / Pseudo-Mercator', 27700: 'OSGB 1936 / British National Grid', 2154: 'RGF93 / Lambert-93', 28992: 'Amersfoort / RD New', 3035: 'ETRS89 / LAEA Europe', 5070: 'NAD83 / Conus Albers', 3577: 'GDA94 / Australian Albers', 2193: 'NZGD2000 / NZTM', 2056: 'CH1903+ / LV95', 3006: 'SWEREF99 TM', 2263: 'NAD83 / New York Long Island (ftUS)', 3395: 'WGS 84 / World Mercator' };

const LONLAT = new Set([4326, 4269, 4258, 4283, 4617]);

/** EPSG code from "EPSG:3857", "urn:ogc:def:crs:EPSG::3857", "3857" or OGC CRS84. 4326 for CRS84. */
function epsgOf(s) {
  const t = String(s || '').trim();
  if (/CRS84$/i.test(t)) return 4326;
  const m = /EPSG(?::+|\/[\d.]+\/|::?)(\d{4,6})\s*$/i.exec(t) || /^(\d{4,6})$/.exec(t) || /EPSG\D{0,8}(\d{4,6})/i.exec(t);
  return m ? Number(m[1]) : null;
}

/** Name of a projection WKT: the first quoted string. */
function wktName(wkt) {
  const m = /^\s*(?:PROJCS|GEOGCS|PROJCRS|GEOGCRS|GEODCRS)\s*\[\s*"([^"]*)"/i.exec(String(wkt || ''));
  return m ? m[1] : '';
}

/**
 * Build a transform from a CRS description to lon/lat.
 * input: { epsg?, wkt?, proj4? } Returns { ok, name, identity, forward(x, y) -> [lon, lat], error? }.
 */
function makeTransform(input) {
  let def = null, name = '', epsg = null;
  if (input.epsg != null) {
    epsg = Number(input.epsg);
    if (LONLAT.has(epsg) && epsg !== 4326) def = DEFS[epsg];
    else if (epsg === 4326) return { ok: true, identity: true, name: 'EPSG:4326 WGS 84', forward: (x, y) => [x, y] };
    else def = DEFS[epsg];
    name = `EPSG:${epsg}${NAMES[epsg] ? ' ' + NAMES[epsg] : (epsg > 32600 && epsg < 32800 ? ` WGS 84 / UTM zone ${epsg % 100}${epsg > 32700 ? 'S' : 'N'}` : '')}`;
    if (!def) return { ok: false, name, error: `EPSG:${epsg} is not in the built-in list. Put a .prj file next to the data, or paste its proj4 string or WKT.` };
  } else if (input.wkt) {
    def = String(input.wkt).trim();
    name = wktName(def) || 'from .prj';
    const auth = /AUTHORITY\s*\[\s*"EPSG"\s*,\s*"?(\d+)"?\s*\]\s*\]\s*$/i.exec(def);
    if (auth && DEFS[Number(auth[1])]) { epsg = Number(auth[1]); }
    if (/^GEOGCS/i.test(def) && /WGS[ _]?84|D_WGS_1984/i.test(def)) return { ok: true, identity: true, name: name || 'WGS 84', forward: (x, y) => [x, y] };
    if (/WGS_1984_Web_Mercator|Pseudo[-_ ]Mercator|Popular Visualisation/i.test(def)) def = DEFS[3857];
  } else if (input.proj4) {
    def = String(input.proj4).trim();
    name = def.length > 60 ? def.slice(0, 57) + '...' : def;
  } else {
    return { ok: true, identity: true, name: 'EPSG:4326 WGS 84', forward: (x, y) => [x, y] };
  }
  let conv;
  try {
    conv = proj4(def, 'EPSG:4326');
    const t = conv.forward([0, 0]);
    if (!Array.isArray(t)) throw new Error('no result');
  } catch (e) {
    return { ok: false, name, error: `The CRS could not be read: ${e && e.message ? e.message : e}` };
  }
  return {
    ok: true, identity: false, name, epsg,
    forward: (x, y) => { try { const r = conv.forward([x, y]); return r; } catch { return [NaN, NaN]; } },
  };
}

/** From a typed string: EPSG code, proj4 string or WKT. */
function transformFromUser(s) {
  const t = String(s || '').trim();
  if (!t) return makeTransform({});
  if (/^\s*\+proj=/.test(t)) return makeTransform({ proj4: t });
  if (/^\s*(PROJCS|GEOGCS|PROJCRS|GEOGCRS|GEODCRS)\s*\[/i.test(t)) return makeTransform({ wkt: t });
  const e = epsgOf(t);
  if (e) return makeTransform({ epsg: e });
  return { ok: false, name: t, error: 'Type an EPSG code (for example 3857 or EPSG:27700), a proj4 string (+proj=...) or a WKT.' };
}

/** GeoJSON "crs" member (2008 spec) to a transform input, or null. */
function geojsonCrs(obj) {
  const c = obj && obj.crs;
  if (!c || typeof c !== 'object') return null;
  const name = c.properties && (c.properties.name || c.properties.code);
  if (c.type === 'name' && name) { const e = epsgOf(name); return e ? { epsg: e } : null; }
  if (c.type === 'EPSG' && c.properties && c.properties.code) return { epsg: Number(c.properties.code) };
  return null;
}

module.exports = { makeTransform, transformFromUser, geojsonCrs, epsgOf, wktName, DEFS };
