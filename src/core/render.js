'use strict';
// Draws the basemap and the data store on a 2D canvas context (an OffscreenCanvas in the worker).
// Level of detail: features smaller than about a pixel become one dot, and vertices closer than
// 0.6 px to the last drawn one are skipped, so the cost follows the screen, not the file.
const { unmercX, unmercY, mercY } = require('./store');

const PALETTES = {
  dark: {
    water: '#16202c', land: '#262b33', border: '#4b5260', lake: '#16202c', grid: 'rgba(255,255,255,0.07)', text: '#c8ccd2', halo: 'rgba(0,0,0,0.65)',
    stroke: '#4fc3f7', fill: 'rgba(79,195,247,0.22)', line: '#ffb74d', point: '#ff5c5c', pointStroke: '#ffffff', select: '#ffe14d', dot: '#4fc3f7',
  },
  light: {
    water: '#cfe2f1', land: '#f5f2ea', border: '#b3ada0', lake: '#cfe2f1', grid: 'rgba(0,0,0,0.07)', text: '#33383f', halo: 'rgba(255,255,255,0.8)',
    stroke: '#1565c0', fill: 'rgba(21,101,192,0.18)', line: '#d84315', point: '#d50000', pointStroke: '#ffffff', select: '#ff00c8', dot: '#1565c0',
  },
};

function niceStep(span) {
  const steps = [90, 45, 30, 20, 10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01, 0.005, 0.002, 0.001, 0.0005, 0.0002, 0.0001];
  for (const s of steps) if (span / s >= 3) return s;
  return 0.0001;
}

function niceDistance(m) {
  const p = Math.pow(10, Math.floor(Math.log10(m)));
  const f = m / p;
  return (f >= 5 ? 5 : f >= 2 ? 2 : 1) * p;
}

/**
 * Trace all parts of a shape into the current path. Returns the number of vertices emitted.
 */
function tracePart(ctx, coords, a, e, sx, sy, ox, oy, close) {
  let lx = (coords[a * 2] - ox) * sx, ly = (coords[a * 2 + 1] - oy) * sy;
  ctx.moveTo(lx, ly);
  let n = 1;
  for (let i = a + 1; i < e; i++) {
    const x = (coords[i * 2] - ox) * sx, y = (coords[i * 2 + 1] - oy) * sy;
    const dx = x - lx, dy = y - ly;
    if (dx < 0.6 && dx > -0.6 && dy < 0.6 && dy > -0.6 && i < e - 1) continue;
    ctx.lineTo(x, y); lx = x; ly = y; n++;
  }
  if (close) ctx.closePath();
  return n;
}

function drawBasemap(ctx, base, v, pal, x0, y0, x1, y1) {
  if (!base) return;
  const sx = v.scale, ox = v.cx - v.w / 2 / v.scale, oy = v.cy - v.h / 2 / v.scale;
  const { coords, partStart, shapePart0, featShape0, featBox, featLayer } = base;
  const pass = (layer, fill, stroke) => {
    ctx.beginPath();
    for (let f = 0; f < base.n; f++) {
      if (featLayer[f] !== layer) continue;
      const b = f * 4;
      if (featBox[b] > x1 || featBox[b + 2] < x0 || featBox[b + 1] > y1 || featBox[b + 3] < y0) continue;
      if ((featBox[b + 2] - featBox[b]) * sx < 0.8 && (featBox[b + 3] - featBox[b + 1]) * sx < 0.8) continue;
      for (let s = featShape0[f]; s < featShape0[f + 1]; s++) {
        for (let p = shapePart0[s]; p < shapePart0[s + 1]; p++) tracePart(ctx, coords, partStart[p], partStart[p + 1], sx, sx, ox, oy, true);
      }
    }
    if (fill) { ctx.fillStyle = fill; ctx.fill('evenodd'); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 0.7; ctx.stroke(); }
  };
  pass(0, pal.land, pal.border);
  if (base.layers.length > 1) pass(1, pal.lake, null);
}

function drawGrid(ctx, v, pal, x0, y0, x1, y1) {
  const lon0 = Math.max(-180, unmercX(x0)), lon1 = Math.min(180, unmercX(x1));
  const lat1 = Math.min(85, unmercY(Math.max(0, y0))), lat0 = Math.max(-85, unmercY(Math.min(1, y1)));
  const step = niceStep(Math.max(lon1 - lon0, lat1 - lat0));
  const ox = v.cx - v.w / 2 / v.scale, oy = v.cy - v.h / 2 / v.scale;
  ctx.beginPath();
  for (let lon = Math.ceil(lon0 / step) * step; lon <= lon1 && lon <= 180; lon += step) {
    const x = ((lon + 180) / 360 - ox) * v.scale;
    ctx.moveTo(x, (mercY(85) - oy) * v.scale); ctx.lineTo(x, (mercY(-85) - oy) * v.scale);
  }
  for (let lat = Math.ceil(lat0 / step) * step; lat <= lat1; lat += step) {
    const y = (mercY(lat) - oy) * v.scale;
    ctx.moveTo((0 - ox) * v.scale, y); ctx.lineTo((1 - ox) * v.scale, y);
  }
  ctx.strokeStyle = pal.grid; ctx.lineWidth = 1; ctx.stroke();
}

/**
 * opts: { base, store, view {cx, cy, scale, w, h}, pal, hidden: Set, selected: number, basemap: bool, fast: bool }
 * Returns { drawn, dots, culled, vertices, ms }.
 */
function render(ctx, opts) {
  const t0 = Date.now();
  const v = opts.view, pal = opts.pal, st = opts.store;
  const x0 = v.cx - v.w / 2 / v.scale, x1 = v.cx + v.w / 2 / v.scale;
  const y0 = v.cy - v.h / 2 / v.scale, y1 = v.cy + v.h / 2 / v.scale;
  ctx.setTransform(v.dpr || 1, 0, 0, v.dpr || 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = pal.water;
  ctx.fillRect(0, 0, v.w, v.h);
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  if (opts.basemap !== false) drawBasemap(ctx, opts.base, v, pal, x0, y0, x1, y1);
  drawGrid(ctx, v, pal, x0, y0, x1, y1);
  const out = { drawn: 0, dots: 0, culled: 0, vertices: 0, ms: 0 };
  if (st && st.n) drawData(ctx, st, v, pal, opts, x0, y0, x1, y1, out);
  drawScale(ctx, v, pal);
  ctx.globalAlpha = 1;
  out.ms = Date.now() - t0;
  return out;
}

function drawData(ctx, st, v, pal, opts, x0, y0, x1, y1, out) {
  const { coords, partStart, shapeKind, shapePart0, featShape0, featBox, featLayer, featStyle, styles } = st;
  const sx = v.scale, ox = x0, oy = y0;
  const hidden = opts.hidden || new Set();
  const exact = st.n <= 3000;
  const manyPoints = st.counts.point > 20000;
  const dots = [];
  // Pass 1: polygons, pass 2: lines, pass 3: points, so points stay on top.
  for (let pass = 3; pass >= 1; pass--) {
    let cur = -2, pending = 0;
    const flush = () => {
      if (!pending) return;
      const s = cur >= 0 ? styles[cur] : null;
      if (pass === 3) {
        ctx.globalAlpha = s && s.fo != null ? s.fo : 1;
        ctx.fillStyle = (s && s.fill) || pal.fill;
        if (s && s.fill && s.fo == null) ctx.globalAlpha = 0.6;
        ctx.fill('evenodd');
        ctx.globalAlpha = s && s.so != null ? s.so : 1;
        ctx.strokeStyle = (s && s.stroke) || pal.stroke;
        ctx.lineWidth = s && s.sw != null ? s.sw : 1.3;
        if (ctx.lineWidth > 0) ctx.stroke();
      } else if (pass === 2) {
        ctx.globalAlpha = s && s.so != null ? s.so : 1;
        ctx.strokeStyle = (s && s.stroke) || pal.line;
        ctx.lineWidth = s && s.sw != null ? Math.max(s.sw, 0.5) : 2.2;
        ctx.stroke();
      } else {
        ctx.globalAlpha = 1;
        ctx.fillStyle = (s && s.mc) || pal.point;
        ctx.fill();
        if (!manyPoints) { ctx.strokeStyle = pal.pointStroke; ctx.lineWidth = 1.2; ctx.stroke(); }
      }
      ctx.beginPath();
      pending = 0;
    };
    ctx.beginPath();
    for (let f = 0; f < st.n; f++) {
      if (hidden.has(featLayer[f])) continue;
      const b = f * 4;
      const bx0 = featBox[b], by0 = featBox[b + 1], bx1 = featBox[b + 2], by1 = featBox[b + 3];
      if (!(bx0 <= x1 && bx1 >= x0 && by0 <= y1 && by1 >= y0)) { if (pass === 3) out.culled++; continue; }
      const style = featStyle[f];
      const tiny = (bx1 - bx0) * sx < 1 && (by1 - by0) * sx < 1;
      let has = false;
      for (let s = featShape0[f]; s < featShape0[f + 1]; s++) if (shapeKind[s] === pass) { has = true; break; }
      if (!has) continue;
      if (tiny && pass !== 1) { dots.push((bx0 - ox) * sx, (by0 - oy) * sx); out.dots++; continue; }
      if (style !== cur || (exact && pass === 3) || pending > 400) { flush(); cur = style; }
      for (let s = featShape0[f]; s < featShape0[f + 1]; s++) {
        if (shapeKind[s] !== pass) continue;
        for (let p = shapePart0[s]; p < shapePart0[s + 1]; p++) {
          const a = partStart[p], e = partStart[p + 1];
          if (pass === 1) {
            const x = (coords[a * 2] - ox) * sx, y = (coords[a * 2 + 1] - oy) * sx;
            const sty = style >= 0 ? styles[style] : null;
            const r = manyPoints ? 2 : (sty && sty.ms) || 5;
            if (manyPoints) ctx.rect(x - r, y - r, r * 2, r * 2); else { ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, Math.PI * 2); }
            out.vertices++;
          } else out.vertices += tracePart(ctx, coords, a, e, sx, sx, ox, oy, pass === 3);
        }
      }
      out.drawn++; pending++;
    }
    flush();
  }
  if (dots.length) {
    ctx.globalAlpha = 0.9; ctx.fillStyle = pal.dot;
    for (let i = 0; i < dots.length; i += 2) ctx.fillRect(dots[i] - 0.75, dots[i + 1] - 0.75, 1.5, 1.5);
  }
  ctx.globalAlpha = 1;
  const sel = opts.selected;
  if (sel != null && sel >= 0 && sel < st.n && !hidden.has(featLayer[sel])) {
    ctx.beginPath();
    for (let s = featShape0[sel]; s < featShape0[sel + 1]; s++) {
      for (let p = shapePart0[s]; p < shapePart0[s + 1]; p++) {
        const a = partStart[p], e = partStart[p + 1];
        if (shapeKind[s] === 1) { const x = (coords[a * 2] - ox) * sx, y = (coords[a * 2 + 1] - oy) * sx; ctx.moveTo(x + 8, y); ctx.arc(x, y, 8, 0, Math.PI * 2); }
        else tracePart(ctx, coords, a, e, sx, sx, ox, oy, shapeKind[s] === 3);
      }
    }
    ctx.strokeStyle = pal.halo; ctx.lineWidth = 6; ctx.stroke();
    ctx.strokeStyle = pal.select; ctx.lineWidth = 3; ctx.stroke();
  }
}

function drawScale(ctx, v, pal) {
  // metres per pixel at the view centre
  const lat = unmercY(v.cy) * Math.PI / 180;
  const mpp = (40075016.686 * Math.cos(lat)) / v.scale;
  if (!Number.isFinite(mpp) || mpp <= 0) return;
  const m = niceDistance(mpp * 110);
  const px = m / mpp;
  const x = 12, y = v.h - 14;
  ctx.globalAlpha = 1;
  ctx.lineWidth = 4; ctx.strokeStyle = pal.halo;
  ctx.beginPath(); ctx.moveTo(x, y - 6); ctx.lineTo(x, y); ctx.lineTo(x + px, y); ctx.lineTo(x + px, y - 6); ctx.stroke();
  ctx.lineWidth = 1.5; ctx.strokeStyle = pal.text; ctx.stroke();
  ctx.font = '11px sans-serif';
  const label = m >= 1000 ? `${m / 1000} km` : `${m} m`;
  ctx.lineWidth = 3; ctx.strokeStyle = pal.halo; ctx.strokeText(label, x + px + 6, y);
  ctx.fillStyle = pal.text; ctx.fillText(label, x + px + 6, y);
  const attr = 'Basemap: Natural Earth';
  const w = ctx.measureText(attr).width;
  ctx.strokeText(attr, v.w - w - 8, v.h - 8);
  ctx.fillText(attr, v.w - w - 8, v.h - 8);
}

module.exports = { render, PALETTES, niceStep, niceDistance };
