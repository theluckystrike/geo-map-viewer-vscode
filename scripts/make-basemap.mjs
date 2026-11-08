// Builds media/basemap.json from Natural Earth 1:50m data (public domain): countries from the world-atlas
// package (ISC, a TopoJSON copy of Natural Earth) and lakes from ne_50m_lakes.geojson.
// usage: node scripts/make-basemap.mjs <ne_50m_lakes.geojson>
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const topo = require('topojson-client');
const world = JSON.parse(fs.readFileSync(new URL('../node_modules/world-atlas/countries-50m.json', import.meta.url)));
const lakes = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const r = v => Math.round(v * 1000) / 1000;
const flat = ring => { const o = []; let px, py; for (const [x, y] of ring) { const a = r(x), b = r(y); if (a === px && b === py) continue; o.push(a, b); px = a; py = b; } return o; };
const polys = g => (g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []);
const countries = topo.feature(world, world.objects.countries).features.map(f => ({ n: f.properties.name || '', p: polys(f.geometry).map(p => p.map(flat)) }));
const lk = lakes.features.map(f => ({ n: f.properties.name || '', p: polys(f.geometry).map(p => p.map(flat)) }));
const out = { source: 'Natural Earth 1:50m (public domain) via world-atlas 2.0.2 (ISC)', countries, lakes: lk };
fs.writeFileSync(new URL('../media/basemap.json', import.meta.url), JSON.stringify(out));
console.log('countries', countries.length, 'lakes', lk.length, fs.statSync(new URL('../media/basemap.json', import.meta.url)).size);
