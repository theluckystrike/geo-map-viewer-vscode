'use strict';
// KML and GPX to GeoJSON with @tmcw/togeojson on @xmldom/xmldom (works inside a web worker, no DOM needed).
// Safety: the DOCTYPE (and with it every entity declaration) is removed before parsing, so an entity bomb has
// nothing to expand. Nothing in a KML is ever fetched: NetworkLinks and remote icons are only counted.
const { DOMParser } = require('@xmldom/xmldom');
const tj = require('@tmcw/togeojson');

const DOCTYPE = /<!DOCTYPE(?:[^[>]|\[[\s\S]*?\])*>/gi;

function sanitizeXml(text) {
  const src = String(text).replace(/^﻿/, '');
  const head = src.slice(0, 1 << 20);
  const entities = (head.match(/<!ENTITY/gi) || []).length;
  const hadDoctype = /<!DOCTYPE/i.test(head);
  const clean = hadDoctype ? src.replace(DOCTYPE, '') : src;
  return { clean, entities, hadDoctype };
}

function parseXml(text) {
  const errors = [];
  const doc = new DOMParser({
    onError: (level, msg) => { if (level !== 'warning' && errors.length < 5) errors.push(String(msg).split('\n')[0]); },
  }).parseFromString(text, 'text/xml');
  return { doc, errors };
}

function flattenFolders(node, path, out, layers) {
  for (const c of node.children || []) {
    if (c.type === 'folder') {
      const name = (c.meta && c.meta.name) || 'Folder';
      const p = path ? `${path} / ${name}` : name;
      flattenFolders(c, p, out, layers);
    } else if (c.type === 'Feature') {
      out.push({ feature: c, layer: path || '' });
    } else if (c.type === 'networklink') {
      layers.networkLinks++;
    }
  }
}

/** Returns { fc, layerOf: string[] (one per feature), networkLinks, remoteRefs, entities, errors } */
function kmlToGeojson(text) {
  const s = sanitizeXml(text);
  const remoteRefs = (s.clean.match(/<href>\s*https?:/gi) || []).length;
  const networkLinkTags = (s.clean.match(/<NetworkLink[\s>]/g) || []).length;
  const { doc, errors } = parseXml(s.clean);
  if (!doc || !doc.documentElement) return { error: 'The KML is not valid XML.' + (errors[0] ? ` ${errors[0]}` : ''), entities: s.entities };
  const tree = tj.kmlWithFolders(doc, { skipNullGeometry: false });
  const flat = [];
  const meta = { networkLinks: 0 };
  flattenFolders(tree, '', flat, meta);
  return {
    fc: { type: 'FeatureCollection', features: flat.map(f => f.feature) },
    layerOf: flat.map(f => f.layer),
    networkLinks: Math.max(meta.networkLinks, networkLinkTags), remoteRefs, entities: s.entities, hadDoctype: s.hadDoctype, errors,
  };
}

function gpxToGeojson(text) {
  const s = sanitizeXml(text);
  const { doc, errors } = parseXml(s.clean);
  if (!doc || !doc.documentElement) return { error: 'The GPX is not valid XML.' + (errors[0] ? ` ${errors[0]}` : ''), entities: s.entities };
  const fc = tj.gpx(doc);
  const layerOf = fc.features.map(f => {
    const t = f.properties && f.properties._gpxType;
    return t === 'trk' ? 'Tracks' : t === 'rte' ? 'Routes' : 'Waypoints';
  });
  return { fc, layerOf, entities: s.entities, hadDoctype: s.hadDoctype, errors, networkLinks: 0, remoteRefs: 0 };
}

module.exports = { kmlToGeojson, gpxToGeojson, sanitizeXml };
