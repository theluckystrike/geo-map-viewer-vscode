'use strict';
// Shared by the extension host, the webview bundle and the tests. No vscode import here.

const MB = 1024 * 1024;
const FORMATS = {
  geojson: 'geojson', json: 'json', topojson: 'topojson', kml: 'kml', kmz: 'kmz', gpx: 'gpx',
  shp: 'shp', zip: 'zip', wkt: 'wkt', csv: 'csv', tsv: 'csv',
};
const LABELS = {
  geojson: 'GeoJSON', json: 'JSON', topojson: 'TopoJSON', kml: 'KML', kmz: 'KMZ', gpx: 'GPX',
  shp: 'Shapefile', zip: 'Zipped shapefile', wkt: 'WKT', csv: 'CSV',
};

function formatOf(name) {
  const s = String(name || '').toLowerCase();
  if (s.endsWith('.geo.json')) return 'geojson';
  const m = /\.([a-z0-9]+)$/.exec(s);
  return m ? FORMATS[m[1]] || null : null;
}

function fmtSize(n) {
  if (!Number.isFinite(n) || n < 0) return '?';
  if (n < 1024) return `${n} B`;
  if (n < MB) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * MB) return `${(n / MB).toFixed(1)} MB`;
  return `${(n / (1024 * MB)).toFixed(1)} GB`;
}

/** Files over the limit get a clear message and are never read. */
function sizePlan(size, maxFileMB) {
  const limitMB = Number.isFinite(maxFileMB) && maxFileMB > 0 ? Math.min(maxFileMB, 2048) : 512;
  if (size > limitMB * MB) {
    return {
      load: false, limitMB,
      message: `This file is ${fmtSize(size)}. The map viewer opens files up to ${fmtSize(limitMB * MB)} so VS Code stays responsive (setting geoMapViewer.maxFileMB). The file was not read.`,
    };
  }
  return { load: true, limitMB, large: size > 25 * MB };
}

const isBytes = v => v instanceof Uint8Array;
const str = (v, max) => typeof v === 'string' && v.length <= max;
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Only known webview messages pass, with checked fields. Everything else is dropped. */
function validateWebviewMessage(m) {
  if (!m || typeof m !== 'object' || typeof m.type !== 'string') return { ok: false };
  switch (m.type) {
    case 'ready':
    case 'reload':
      return { ok: true, msg: { type: m.type } };
    case 'rendered':
      return { ok: true, msg: { type: 'rendered', ok: m.ok === true, features: Number.isFinite(m.features) ? m.features : 0 } };
    case 'png': {
      if (!isBytes(m.data) || m.data.length < 8 || m.data.length > 256 * MB) return { ok: false };
      if (!PNG_SIG.every((b, i) => m.data[i] === b)) return { ok: false };
      return { ok: true, msg: { type: 'png', data: m.data } };
    }
    case 'copy':
      if (!str(m.text, 1000000)) return { ok: false };
      return { ok: true, msg: { type: 'copy', text: m.text } };
    case 'saveGeojson':
      if (!str(m.text, 512 * MB)) return { ok: false };
      return { ok: true, msg: { type: 'saveGeojson', text: m.text } };
    default:
      return { ok: false };
  }
}

/** Side files of a shapefile: same base name, any case of the extension. */
function shapefileSidecars(name) {
  const base = String(name).replace(/\.shp$/i, '');
  return ['dbf', 'prj', 'cpg'].map(ext => ({ ext, names: [`${base}.${ext}`, `${base}.${ext.toUpperCase()}`] }));
}

module.exports = { MB, FORMATS, LABELS, formatOf, fmtSize, sizePlan, validateWebviewMessage, shapefileSidecars };
