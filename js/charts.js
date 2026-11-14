// SVG charts (calendar heat-map, daily bars, harmonization lines) + colour ramps + PNG/SVG export.
// Everything is drawn as SVG with explicit attributes (no CSS classes) so the very same markup can be
// shown on screen and downloaded as a stand-alone SVG / PNG.

const NS = 'http://www.w3.org/2000/svg';
export const INK = { bg: '#0b1020', panel: '#111827', grid: '#1f2937', text: '#e5e7eb', muted: '#9ca3af', accent: '#fb923c' };
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

function h(tag, attrs = {}, ...kids) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) e.setAttribute(k, v);
  for (const k of kids.flat()) if (k !== null && k !== undefined) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
}
const text = (x, y, s, o = {}) => h('text', { x, y, fill: INK.text, 'font-family': FONT, 'font-size': 12, ...o }, s);

// ---- number / date formatting ----------------------------------------------------------------
const nfInt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
export const fmtInt = (v) => (Number.isFinite(v) ? nfInt.format(Math.round(v)) : '–');
export function fmtCompact(v) {
  if (!Number.isFinite(v)) return '–';
  const a = Math.abs(v);
  if (a < 10000) return nfInt.format(Math.round(v));
  if (a < 1e6) return (v / 1e3).toFixed(a < 1e5 ? 1 : 0).replace(/\.0$/, '') + 'k';
  return (v / 1e6).toFixed(a < 1e7 ? 2 : 1).replace(/\.?0+$/, '') + 'M';
}
export const fmtPct = (v, d = 0) => (Number.isFinite(v) ? `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(d)}%` : '–');
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const parseDate = (s) => new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)));
export const dowOf = (s) => (parseDate(s).getUTCDay() + 6) % 7;               // Monday = 0
export const prettyDate = (s) => `${DOW[dowOf(s)]} ${+s.slice(8)} ${MONTHS[+s.slice(5, 7) - 1].slice(0, 3)}`;
export const longDate = (s) => `${DOW[dowOf(s)]} ${+s.slice(8)} ${MONTHS[+s.slice(5, 7) - 1]} ${s.slice(0, 4)}`;

// ---- colour ramps (perceptually uniform / colour-blind safe) ---------------------------------
const hex2rgb = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const rgb2hex = (a) => '#' + a.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
function lerpStops(stops, t) {                       // stops: array of colours, evenly spaced
  const x = Math.min(1, Math.max(0, t)) * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x)), f = x - i;
  const a = hex2rgb(stops[i]), b = hex2rgb(stops[i + 1]);
  return rgb2hex(a.map((v, k) => v + (b[k] - v) * f));
}
// Sequential: Inferno (dark = few, bright = many). Monotonic lightness, safe for all common colour-vision deficiencies.
const INFERNO = ['#000004', '#160b39', '#420a68', '#6a176e', '#932667', '#bc3754', '#dd513a', '#f37819', '#fca50a', '#f6d746', '#fcffa4'];
// Diverging: blue (below baseline) <-> dark neutral <-> orange (above). Blue/orange stays distinguishable for red-green colour blindness
// and lightness grows away from the centre in both directions.
const DIVERGING = ['#7dd3fc', '#3b8fd6', '#25588f', '#1c2a44', '#2a2230', '#7a3a12', '#d4620f', '#fb923c', '#fed7aa'];
export const seqColor = (t) => lerpStops(INFERNO, 0.07 + 0.93 * Math.min(1, Math.max(0, t)));
export const divColor = (t) => lerpStops(DIVERGING, (Math.min(1, Math.max(-1, t)) + 1) / 2);
// Map variant: starts at a visible purple so a single faint cell is not lost against the dark basemap.
export const heatColor = (t) => lerpStops(INFERNO, 0.2 + 0.8 * Math.min(1, Math.max(0, t)));
export const SEQ_STOPS = INFERNO, DIV_STOPS = DIVERGING;

function luminance(c) {
  const [r, g, b] = hex2rgb(c).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
export const textOn = (bg) => (contrast(bg, '#ffffff') >= contrast(bg, '#0b1020') ? '#ffffff' : '#0b1020');

function niceTicks(max, want = 4) {
  if (!(max > 0)) return [0, 1];
  const raw = max / want, mag = 10 ** Math.floor(Math.log10(raw)), f = raw / mag;
  const step = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag;
  const out = [];
  for (let v = 0; v <= max + step * 0.999; v += step) out.push(+v.toFixed(10));
  return out;
}

function frame(W, H, header, label) {
  const topPad = header ? 58 : 0, extra = header ? 26 : 0;
  const svg = h('svg', {
    xmlns: NS, viewBox: `0 0 ${W} ${H + topPad + extra}`, width: W, height: H + topPad + extra, role: 'img', 'aria-label': label,
    style: 'display:block;width:100%;height:auto',
  });
  if (header) {
    svg.append(h('rect', { width: W, height: H + topPad + extra, fill: INK.bg }));
    svg.append(text(16, 26, header.title, { 'font-size': 17, 'font-weight': 700, fill: INK.accent }));
    svg.append(text(16, 46, header.subtitle, { 'font-size': 12, fill: INK.muted }));
    svg.append(text(16, H + topPad + 16, header.footer || '', { 'font-size': 11, fill: INK.muted }));
  }
  const body = h('g', { transform: `translate(0 ${topPad})` });
  svg.append(body);
  return { svg, body };
}

const GAP_PATTERN = () => h('pattern', { id: 'sfGap', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' },
  h('rect', { width: 6, height: 6, fill: 'none' }), h('line', { x1: 0, y1: 0, x2: 0, y2: 6, stroke: '#0b1020', 'stroke-width': 2.4 }));

function gapNote(g) { return g.map((x) => `${x.sensor} delivered ${fmtInt(x.n)} detections (about ${fmtInt(x.expected)} expected)`).join('; '); }

// ---- calendar --------------------------------------------------------------------------------
/**
 * opts: dates, values, anomPct, gaps, view ('abs'|'anom'), unit, baselineLabel, selected, onSelect, header
 */
export function renderCalendar(host, o) {
  const { dates, values, anomPct, gaps, view, unit, baselineLabel, selected, onSelect, header } = o;
  const CW = 78, CH = 62, X0 = 14, W = X0 * 2 + CW * 7;
  const months = [];
  dates.forEach((d, i) => {
    const k = d.slice(0, 7);
    let m = months[months.length - 1];
    if (!m || m.key !== k) { m = { key: k, idx: [] }; months.push(m); }
    m.idx.push(i);
  });
  const maxVal = Math.max(...values, 1);
  const maxAbs = Math.max(0, ...anomPct.filter(Number.isFinite).map(Math.abs));
  const cap = Math.max(30, Math.ceil(maxAbs / 10) * 10);

  let y = 6;
  const parts = [];
  const cells = [];
  for (const m of months) {
    const y0 = new Date(Date.UTC(+m.key.slice(0, 4), +m.key.slice(5) - 1, 1));
    parts.push(text(X0, y + 16, `${MONTHS[y0.getUTCMonth()]} ${y0.getUTCFullYear()}`, { 'font-size': 15, 'font-weight': 700 }));
    y += 28;
    DOW.forEach((d, c) => parts.push(text(X0 + c * CW + (CW - 4) / 2, y + 12, d, { 'text-anchor': 'middle', fill: INK.muted })));
    y += 18;
    const offset = dowOf(dates[m.idx[0]]);
    let rows = 0;
    for (const i of m.idx) {
      const dnum = +dates[i].slice(8), pos = offset + dnum - 1, col = pos % 7, row = Math.floor(pos / 7);
      rows = Math.max(rows, row + 1);
      const x = X0 + col * CW, cy = y + row * CH, w = CW - 4, hh = CH - 4;
      const v = values[i], a = anomPct[i];
      let fill, label;
      if (view === 'anom') {
        fill = Number.isFinite(a) ? divColor(a / cap) : '#1c2a44';
        label = fmtPct(a);
      } else {
        fill = v > 0 ? seqColor(v / maxVal) : INK.panel;
        label = fmtCompact(v);
      }
      const fg = textOn(fill), gap = gaps[i].length > 0, sel = selected === i;
      const aria = `${longDate(dates[i])}: ${fmtInt(v)} ${unit}${Number.isFinite(a) ? `, ${fmtPct(a)} versus ${baselineLabel}` : ''}${gap ? `. Sensor gap: ${gapNote(gaps[i])}` : ''}`;
      const tip = `${longDate(dates[i])}\n${fmtInt(v)} ${unit}${Number.isFinite(a) ? `\n${fmtPct(a, 1)} vs ${baselineLabel}` : ''}${gap ? `\n⚠ ${gapNote(gaps[i])}` : ''}`;
      const g = h('g', { role: 'button', tabindex: -1, 'aria-label': aria, 'aria-pressed': sel ? 'true' : 'false', 'data-i': i, 'data-tip': tip, style: 'cursor:pointer;outline:none' },
        h('rect', { x, y: cy, width: w, height: hh, rx: 7, fill, stroke: sel ? '#ffffff' : gap ? '#e5e7eb' : INK.grid, 'stroke-width': sel ? 3 : gap ? 1.5 : 1, 'stroke-dasharray': gap && !sel ? '4 3' : null }),
        text(x + 7, cy + 16, dnum, { 'font-size': 11, 'font-weight': 600, fill: fg, opacity: 0.85 }),
        text(x + w / 2, cy + hh / 2 + 9, label, { 'font-size': 15, 'font-weight': 700, fill: fg, 'text-anchor': 'middle' }),
        gap ? h('path', { d: `M${x + w - 19} ${cy + 15} L${x + w - 12} ${cy + 3} L${x + w - 5} ${cy + 15} Z`, fill: '#facc15', stroke: '#0b1020', 'stroke-width': 1 }) : null,
        gap ? text(x + w - 12, cy + 13.5, '!', { 'font-size': 9, 'font-weight': 800, fill: '#0b1020', 'text-anchor': 'middle' }) : null);
      cells.push({ g, i });
      parts.push(g);
    }
    y += rows * CH + 8;
  }

  // legend
  y += 4;
  const gradId = 'sfGrad' + (view === 'anom' ? 'D' : 'S');
  const stops = (view === 'anom' ? DIV_STOPS : SEQ_STOPS.map((_, k) => seqColor(k / (SEQ_STOPS.length - 1))));
  const lg = h('linearGradient', { id: gradId, x1: 0, x2: 1, y1: 0, y2: 0 },
    stops.map((c, k) => h('stop', { offset: `${(k / (stops.length - 1)) * 100}%`, 'stop-color': c })));
  const LX = X0, LW = 210;
  parts.push(h('defs', {}, lg));
  parts.push(h('rect', { x: LX, y, width: LW, height: 12, rx: 3, fill: `url(#${gradId})`, stroke: INK.grid }));
  if (view === 'anom') {
    parts.push(text(LX, y + 28, `−${cap}%`, { fill: INK.muted }), text(LX + LW / 2, y + 28, '0', { 'text-anchor': 'middle', fill: INK.muted }), text(LX + LW, y + 28, `+${cap}%`, { 'text-anchor': 'end', fill: INK.muted }));
    parts.push(text(LX, y + 46, `Change vs ${baselineLabel} (blue = below, orange = above)`, { fill: INK.muted }));
  } else {
    parts.push(text(LX, y + 28, '0', { fill: INK.muted }), text(LX + LW, y + 28, `${fmtCompact(maxVal)}`, { 'text-anchor': 'end', fill: INK.muted }));
    parts.push(text(LX, y + 46, `Daily ${unit} (brighter = more)`, { fill: INK.muted }));
  }
  // gap key
  const KX = LX + LW + 34;
  parts.push(h('rect', { x: KX, y: y - 2, width: 26, height: 18, rx: 4, fill: INK.panel, stroke: '#e5e7eb', 'stroke-width': 1.5, 'stroke-dasharray': '4 3' }));
  parts.push(h('path', { d: `M${KX + 20} ${y + 8} L${KX + 24} ${y} L${KX + 28} ${y + 8} Z`, fill: '#facc15', stroke: '#0b1020' }));
  parts.push(text(KX + 36, y + 11, 'Dashed + ! = a satellite', { fill: INK.muted }), text(KX + 36, y + 27, 'was missing that day', { fill: INK.muted }));
  y += 58;

  const { svg, body } = frame(W, y, header, `Burning activity calendar, ${unit} per day`);
  body.append(...parts);

  svg.addEventListener('click', (e) => {
    const g = e.target.closest('[data-i]');
    if (g) onSelect?.(+g.dataset.i === selected ? null : +g.dataset.i);
  });
  // roving tabindex + arrow keys
  const order = cells.map((c) => c.i);
  const focusIdx = selected !== null && order.includes(selected) ? selected : order[0];
  cells.forEach(({ g, i }) => g.setAttribute('tabindex', i === focusIdx ? '0' : '-1'));
  svg.addEventListener('keydown', (e) => {
    const g = e.target.closest?.('[data-i]');
    if (!g) return;
    const i = +g.dataset.i;
    const move = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, Home: -999, End: 999 }[e.key];
    if (move !== undefined) {
      e.preventDefault();
      const ni = Math.min(order.length - 1, Math.max(0, i + (Math.abs(move) === 999 ? Math.sign(move) * order.length : move)));
      const target = cells.find((c) => c.i === ni);
      if (target) { cells.forEach((c) => c.g.setAttribute('tabindex', '-1')); target.g.setAttribute('tabindex', '0'); target.g.focus(); }
    } else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect?.(i === selected ? null : i); }
    else if (e.key === 'Escape') onSelect?.(null);
  });
  host.replaceChildren(svg);
  if (o.restoreFocus) { const t = cells.find((c) => c.i === o.restoreFocus); t?.g.focus(); }
  return svg;
}

// ---- daily bars ------------------------------------------------------------------------------
export function renderBars(host, o) {
  const { dates, values, gaps, mean, sd, selected, unit, baselineLabel, onSelect, header } = o;
  const W = 560, H = 250, ML = 58, MR = 14, MT = 40, MB = 36, PW = W - ML - MR, PH = H - MT - MB;
  const N = dates.length, band = PW / N, bw = band * 0.72;
  const yMax = Math.max(...values, mean + sd, 1) * 1.08, ticks = niceTicks(yMax, 4), top = ticks[ticks.length - 1];
  const Y = (v) => MT + PH - (v / top) * PH;
  const { svg, body } = frame(W, H, header, `Daily ${unit}`);
  body.append(h('defs', {}, GAP_PATTERN()));
  // legend
  body.append(h('rect', { x: ML, y: 8, width: 12, height: 12, rx: 2, fill: INK.accent }), text(ML + 18, 18.5, `Daily ${unit}`, { fill: INK.muted }));
  body.append(h('line', { x1: ML + 150, x2: ML + 170, y1: 14, y2: 14, stroke: INK.text, 'stroke-width': 1.5, 'stroke-dasharray': '5 3' }), text(ML + 176, 18.5, baselineLabel, { fill: INK.muted }));
  body.append(h('rect', { x: ML + 290, y: 8, width: 14, height: 12, fill: 'rgba(148,163,184,0.28)' }), text(ML + 310, 18.5, '±1 SD', { fill: INK.muted }));
  body.append(h('rect', { x: ML + 365, y: 8, width: 12, height: 12, fill: INK.accent }), h('rect', { x: ML + 365, y: 8, width: 12, height: 12, fill: 'url(#sfGap)' }), text(ML + 383, 18.5, 'Satellite gap', { fill: INK.muted }));
  // grid + axes
  for (const t of ticks) {
    body.append(h('line', { x1: ML, x2: W - MR, y1: Y(t), y2: Y(t), stroke: INK.grid }), text(ML - 8, Y(t) + 4, fmtCompact(t), { 'text-anchor': 'end', fill: INK.muted }));
  }
  if (sd > 0) body.append(h('rect', { x: ML, y: Y(Math.min(top, mean + sd)), width: PW, height: Math.max(0, Y(Math.max(0, mean - sd)) - Y(Math.min(top, mean + sd))), fill: 'rgba(148,163,184,0.2)' }));
  dates.forEach((d, i) => {
    const x = ML + i * band + (band - bw) / 2, y = Y(values[i]), gap = gaps[i].length > 0, sel = selected === i;
    const tip = `${longDate(d)}\n${fmtInt(values[i])} ${unit}${gap ? `\n⚠ ${gapNote(gaps[i])}` : ''}`;
    const g = h('g', { role: 'button', tabindex: -1, 'aria-label': `${longDate(d)}: ${fmtInt(values[i])} ${unit}`, 'aria-pressed': sel ? 'true' : 'false', 'data-i': i, 'data-tip': tip, style: 'cursor:pointer;outline:none' },
      h('rect', { x: ML + i * band, y: MT, width: band, height: PH, fill: 'transparent' }),
      h('rect', { x, y, width: bw, height: Math.max(0, MT + PH - y), fill: INK.accent, stroke: sel ? '#ffffff' : 'none', 'stroke-width': 2 }),
      gap ? h('rect', { x, y, width: bw, height: Math.max(0, MT + PH - y), fill: 'url(#sfGap)' }) : null);
    body.append(g);
    const dn = +d.slice(8);
    if (dn === 1 || dn % 5 === 0) body.append(text(ML + i * band + band / 2, MT + PH + 16, dn, { 'text-anchor': 'middle', fill: INK.muted }));
  });
  body.append(h('line', { x1: ML, x2: W - MR, y1: Y(mean), y2: Y(mean), stroke: INK.text, 'stroke-width': 1.5, 'stroke-dasharray': '5 3', 'pointer-events': 'none' }));
  body.append(text(ML, MT + PH + 32, `Day of ${MONTHS[+dates[0].slice(5, 7) - 1]} ${dates[0].slice(0, 4)}`, { fill: INK.muted }));
  svg.addEventListener('click', (e) => { const g = e.target.closest('[data-i]'); if (g) onSelect?.(+g.dataset.i === selected ? null : +g.dataset.i); });
  host.replaceChildren(svg);
  return svg;
}

// ---- harmonization lines ---------------------------------------------------------------------
/** series: [{name, color, dash, width, values}] ; each is shown as an index (100 = its own mean). */
export function renderLines(host, o) {
  const { dates, series, gaps, header } = o;
  const W = 560, H = 290, ML = 50, MR = 14, MT = 62, MB = 36, PW = W - ML - MR, PH = H - MT - MB, N = dates.length;
  const idx = series.map((s) => {
    const m = s.values.reduce((a, v) => a + v, 0) / s.values.length;
    return s.values.map((v) => (m > 0 ? (v / m) * 100 : 100));
  });
  const all = idx.flat();
  const lo = Math.max(0, Math.floor((Math.min(...all) - 5) / 10) * 10), hi = Math.ceil((Math.max(...all) + 5) / 10) * 10;
  const X = (i) => ML + (N === 1 ? PW / 2 : (i / (N - 1)) * PW), Y = (v) => MT + PH - ((v - lo) / (hi - lo)) * PH;
  const { svg, body } = frame(W, H, header, 'Raw detections versus harmonized fire-active cells, indexed to their own monthly mean');
  body.append(h('defs', {}, GAP_PATTERN()));
  // legend (2 columns x 2 rows)
  series.forEach((s, k) => {
    const lx = ML + (k % 2) * 250, ly = 10 + Math.floor(k / 2) * 20;
    body.append(h('line', { x1: lx, x2: lx + 26, y1: ly + 6, y2: ly + 6, stroke: s.color, 'stroke-width': s.width, 'stroke-dasharray': s.dash || null }), text(lx + 32, ly + 10, s.name, { fill: INK.muted }));
  });
  const step = hi - lo > 100 ? 50 : hi - lo > 50 ? 20 : 10;
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
    body.append(h('line', { x1: ML, x2: W - MR, y1: Y(v), y2: Y(v), stroke: v === 100 ? '#475569' : INK.grid, 'stroke-dasharray': v === 100 ? '4 3' : null }), text(ML - 8, Y(v) + 4, v, { 'text-anchor': 'end', fill: INK.muted }));
  }
  const bw = PW / Math.max(1, N - 1);
  gaps.forEach((g, i) => { if (g.length) body.append(h('rect', { x: X(i) - bw / 2, y: MT, width: bw, height: PH, fill: 'url(#sfGap)', opacity: 0.55 })); });
  series.forEach((s, k) => {
    body.append(h('path', { d: idx[k].map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`).join(' '), fill: 'none', stroke: s.color, 'stroke-width': s.width, 'stroke-dasharray': s.dash || null, 'stroke-linejoin': 'round', 'pointer-events': 'none' }));
  });
  dates.forEach((d, i) => {
    const tip = `${longDate(d)}${gaps[i].length ? `\n⚠ ${gapNote(gaps[i])}` : ''}\n` + series.map((s, k) => `${s.name}: ${fmtInt(s.values[i])} (index ${idx[k][i].toFixed(0)})`).join('\n');
    body.append(h('rect', { x: X(i) - bw / 2, y: MT, width: bw, height: PH, fill: 'transparent', 'data-tip': tip }));
    const dn = +d.slice(8);
    if (dn === 1 || dn % 5 === 0) body.append(text(X(i), MT + PH + 16, dn, { 'text-anchor': 'middle', fill: INK.muted }));
  });
  body.append(text(ML, MT + PH + 32, 'Index: 100 = each series’ own monthly mean (hatched = satellite gap)', { fill: INK.muted }));
  host.replaceChildren(svg);
  return svg;
}

// ---- export ----------------------------------------------------------------------------------
export function svgToBlob(svg) {
  return new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml;charset=utf-8' });
}

export async function svgToPngBlob(svg, scale = 2) {
  const url = URL.createObjectURL(svgToBlob(svg));
  try {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('Could not rasterise the chart')); img.src = url; });
    const W = +svg.getAttribute('width'), H = +svg.getAttribute('height');
    const canvas = document.createElement('canvas');
    canvas.width = W * scale; canvas.height = H * scale;
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('PNG encoding failed'))), 'image/png'));
  } finally { URL.revokeObjectURL(url); }
}

export function saveBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
