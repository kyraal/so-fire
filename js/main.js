import { PRESETS, validate, aoiLabel, aoiSlug, encodeState, decodeState } from './aoi.js';
import { loadMeta, Store, analyze, baseline, anomalies, pearson, rankOf, exportHotspotRows, countHotspotRows, dailySummaryCSV, SENSOR_NAMES } from './data.js';
import { renderCalendar, renderBars, renderLines, svgToPngBlob, svgToBlob, saveBlob, fmtInt, fmtCompact, fmtPct, prettyDate, longDate, heatColor, INK } from './charts.js';
import { createMap } from './map.js';

const $ = (id) => document.getElementById(id);
const state = { aoi: PRESETS[0].aoi, day: null, includeSmall: false, metric: 'count', view: 'abs', mapColor: 'density' };
let meta, store, mapApi, analysis = null, tiles = [], loadToken = 0, pendingFocus = null;

const el = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) (k in e && k !== 'style' ? (e[k] = v) : e.setAttribute(k, v));
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
};
const monthName = () => new Date(meta.dates[0] + 'T00:00:00Z').toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
const dayIndex = () => (state.day ? meta.dates.indexOf(state.day) : -1);
const periodLabel = () => `${monthName()} ${meta.dates[0].slice(0, 4)}`;

// ---------------------------------------------------------------------------------------------
// derived numbers for the current AOI + options
function derive() {
  const a = analysis, all = state.includeSmall;
  const cells = all ? a.allCells : a.eqCells, frp = all ? a.allFrp : a.eqFrp;
  const series = state.metric === 'count' ? cells : frp;
  const base = baseline(series, a.gaps), an = anomalies(series, base);
  return { cells, frp, series, base, an };
}
const unit = () => (state.metric === 'count' ? 'hotspots' : 'MW FRP');
const baselineLabel = () => `${monthName()} mean`;
const sum = (arr) => arr.reduce((s, v) => s + v, 0);
const fmtPower = (mw) => (mw >= 1e6 ? `${(mw / 1e6).toFixed(2)} TW` : mw >= 1e3 ? `${(mw / 1e3).toFixed(mw >= 1e5 ? 0 : 1)} GW` : `${fmtInt(mw)} MW`);

// ---------------------------------------------------------------------------------------------
// rendering
function renderAll() {
  if (!analysis) return;
  const a = analysis, d = derive(), D = meta.dates, sel = dayIndex();
  const selected = sel >= 0 ? sel : null;

  $('aoiTitle').textContent = aoiLabel(state.aoi);
  $('aoiSub').textContent = `${fmtInt(sum(d.cells))} harmonized hotspots (fire-active 1 km cells) in ${periodLabel()} · ${state.includeSmall ? 'full VIIRS sensitivity' : `MODIS-equivalent sensitivity (≥ ${meta.modis_floor_mw} MW or seen by MODIS)`}`;

  // KPIs
  const peak = d.series.indexOf(Math.max(...d.series));
  const gapDays = a.gaps.map((g, i) => (g.length ? i : -1)).filter((i) => i >= 0);
  const rawSum = sum(a.rawTotal), cellSum = sum(a.allCells);
  const k = [];
  k.push(el('div', { className: 'kpi accent' }, el('div', { className: 'k' }, 'Hotspots'), el('div', { className: 'v' }, fmtCompact(sum(d.cells))), el('div', { className: 's' }, `${fmtInt(sum(d.cells) / D.length)} per day on average`)));
  k.push(el('div', { className: 'kpi' }, el('div', { className: 'k' }, `Peak day (${state.metric === 'count' ? 'hotspots' : 'FRP'})`), el('div', { className: 'v' }, prettyDate(D[peak])), el('div', { className: 's' }, `${state.metric === 'count' ? fmtInt(d.series[peak]) + ' hotspots' : fmtPower(d.series[peak])} · ${fmtPct(d.an.pct[peak])} vs mean`)));
  k.push(el('div', { className: 'kpi' }, el('div', { className: 'k' }, 'Mean daily FRP'), el('div', { className: 'v' }, fmtPower(sum(d.frp) / D.length)), el('div', { className: 's' }, `strongest cell ${fmtInt(a.maxFrp)} MW`)));
  k.push(el('div', { className: 'kpi' }, el('div', { className: 'k' }, 'Raw → harmonized'), el('div', { className: 'v' }, `${fmtCompact(rawSum)} → ${fmtCompact(cellSum)}`), el('div', { className: 's' }, cellSum ? `${(rawSum / cellSum).toFixed(1)}× fewer records, one per 1 km cell-day` : 'no detections')));
  k.push(el('div', { className: 'kpi' }, el('div', { className: 'k' }, 'Satellite-gap days'), el('div', { className: 'v' }, gapDays.length ? String(gapDays.length) : 'None'), el('div', { className: 's' }, gapDays.length ? gapDays.slice(0, 6).map((i) => +D[i].slice(8)).join(', ') + (gapDays.length > 6 ? '…' : '') + ` ${monthName().slice(0, 3)}` : 'all satellites reporting')));
  $('kpis').replaceChildren(...k);

  // calendar
  const common = { dates: D, values: d.series, anomPct: d.an.pct, gaps: a.gaps, unit: unit(), baselineLabel: baselineLabel(), selected, onSelect: setDay };
  renderCalendar($('calendar'), { ...common, view: state.view, restoreFocus: pendingFocus });
  pendingFocus = null;
  $('calHint').textContent = `Each square is one day (${state.view === 'abs' ? 'brighter = more' : `blue = below, orange = above the ${baselineLabel()}`}; satellite-gap days are left out of the mean). Select a day to focus the map on it. Arrow keys move between days.`;

  // day detail
  const info = $('dayInfo');
  if (selected === null) info.replaceChildren(el('span', { className: 'muted' }, 'No day selected: the map shows all of ' + monthName() + '.'));
  else {
    const i = selected;
    const lines = [el('span', {}, el('b', {}, longDate(D[i])), ` · ${state.metric === 'count' ? fmtInt(d.series[i]) + ' hotspots' : fmtPower(d.series[i])} · ${fmtPct(d.an.pct[i], 0)} vs ${baselineLabel()}${Number.isFinite(d.an.z[i]) ? ` (z ${d.an.z[i] >= 0 ? '+' : '−'}${Math.abs(d.an.z[i]).toFixed(1)})` : ''} · rank ${rankOf(d.series, i)} of ${D.length}`)];
    lines.push(el('div', { className: 'muted' }, `Seen by MODIS in ${fmtInt(a.modisCells[i])} cells and by VIIRS in ${fmtInt(a.viirsCells[i])} cells; ${fmtInt(a.rawTotal[i])} raw detections.`));
    if (a.gaps[i].length) lines.push(el('div', { style: 'color:#facc15' }, '⚠ ' + a.gaps[i].map((g) => `${g.sensor} delivered ${fmtInt(g.n)} detections here (about ${fmtInt(g.expected)} expected)`).join('; ') + '. This day is probably undercounted.'));
    info.replaceChildren(...lines);
  }

  renderBars($('bars'), { ...common, mean: d.base.mean, sd: d.base.sd });

  // harmonization
  const modisRaw = sum(a.raw[0]), viirsRaw = sum(a.raw[1]) + sum(a.raw[2]) + sum(a.raw[3]);
  const r = pearson(a.modisCells, a.viirsCells, a.gaps);
  const eqSum = sum(a.eqCells);
  $('harmText').textContent = rawSum
    ? `VIIRS supplies ${Math.round((viirsRaw / rawSum) * 100)}% of the raw detections here, so raw totals mostly follow how many VIIRS satellites were reporting. After harmonization each 1 km cell counts once per day whichever sensor saw it.`
    : 'No detections in this area.';
  const series = [
    { name: 'Raw detections (all sensors)', color: '#cbd5e1', dash: '6 4', width: 2, values: Array.from(a.rawTotal) },
    { name: 'Harmonized hotspots', color: '#fb923c', width: 3.2, values: Array.from(d.cells) },
    { name: 'Cells seen by MODIS', color: '#38bdf8', width: 2, values: Array.from(a.modisCells) },
    { name: 'Cells seen by VIIRS', color: '#c4b5fd', dash: '2 3', width: 2.4, values: Array.from(a.viirsCells) },
  ];
  renderLines($('lines'), { dates: D, series, gaps: a.gaps });
  const head = el('thead', {}, el('tr', {}, el('th', {}, ''), el('th', {}, 'MODIS'), el('th', {}, 'VIIRS (3 sat.)'), el('th', {}, 'Harmonized')));
  const row = (label, m, v, hz) => el('tr', {}, el('td', {}, label), el('td', {}, m), el('td', {}, v), el('td', {}, hz));
  $('harmTable').replaceChildren(head, el('tbody', {},
    row('Raw detections', fmtInt(modisRaw), fmtInt(viirsRaw), '–'),
    row('Cells with a detection', fmtInt(sum(a.modisCells)), fmtInt(sum(a.viirsCells)), `${fmtInt(eqSum)} (MODIS-equiv.)`),
    row('…incl. small VIIRS-only fires', '', '', fmtInt(sum(a.allCells))),
    row('Daily pattern agreement (r)', { toString: () => '' }, Number.isFinite(r.r) ? r.r.toFixed(2) : 'n/a', Number.isFinite(r.r) ? `${r.n} days without a gap` : 'too few detections')));

  // downloads text
  updateDownloadText();

  // data table
  const t = el('table', { className: 'mini', id: 'dailyTable' });
  t.append(el('thead', {}, el('tr', {}, ['Date', 'Hotspots', 'FRP (MW)', 'vs mean', 'Raw detections'].map((h) => el('th', {}, h)))));
  const tb = el('tbody');
  D.forEach((day, i) => tb.append(el('tr', { className: a.gaps[i].length ? 'gap' : '' }, el('td', {}, prettyDate(day)), el('td', {}, fmtInt(d.cells[i])), el('td', {}, fmtInt(d.frp[i])), el('td', {}, fmtPct(d.an.pct[i], 0)), el('td', {}, fmtInt(a.rawTotal[i])))));
  t.append(tb);
  $('dailyTable').replaceWith(t);

  // map
  syncMap();
  $('sr').textContent = `${aoiLabel(state.aoi)}: ${fmtInt(sum(d.cells))} harmonized hotspots in ${periodLabel()}. Busiest day ${longDate(D[peak])}.`;
}

function syncMap() {
  if (!mapApi) return;
  const sel = dayIndex();
  mapApi.setScene({ tiles, grid: store.grid, dayIndex: sel >= 0 ? sel : null, includeSmall: state.includeSmall, colorMode: state.mapColor });
  const chip = $('dayChip');
  chip.hidden = sel < 0;
  if (sel >= 0) $('dayChipText').textContent = `Map: ${longDate(state.day)}`;
}

function updateDownloadText() {
  const sel = dayIndex();
  const n = countHotspotRows(tiles, { dayIndex: sel >= 0 ? sel : null, includeSmall: state.includeSmall });
  $('dlText').textContent = `Hotspots CSV: ${fmtInt(n)} rows (${sel >= 0 ? longDate(state.day) : 'all of ' + periodLabel()}, ${state.includeSmall ? 'including small VIIRS-only fires' : 'MODIS-equivalent sensitivity'}). One row per fire-active 1 km cell and day, with the sensors that saw it. Pick a day on the calendar to export just that day.`;
}

// ---------------------------------------------------------------------------------------------
// state changes
function setDay(i) {
  state.day = i === null ? null : meta.dates[i];
  pendingFocus = i;
  pushHash();
  renderAll();
}

function pushHash() { history.replaceState(null, '', '#' + encodeState(state)); }

function syncForms() {
  const a = state.aoi;
  const preset = PRESETS.find((p) => JSON.stringify(p.aoi) === JSON.stringify(a));
  $('preset').value = preset ? preset.id : 'custom';
  if (a.type === 'bbox') { $('bS').value = a.south; $('bN').value = a.north; $('bW').value = a.west; $('bE').value = a.east; }
  else { $('cLat').value = a.lat; $('cLng').value = a.lng; $('cR').value = a.radiusKm; }
}

function setProgress(text, frac, error) {
  const p = $('progress');
  p.hidden = text === null;
  if (text === null) return;
  $('progressText').textContent = text;
  $('progressBar').style.width = `${Math.round((frac || 0) * 100)}%`;
  $('retryBtn').hidden = !error;
  $('progressBar').parentElement.hidden = !!error;
}

async function setAOI(aoi, { fit = true } = {}) {
  const err = validate(aoi);
  if (err) { $('aoiMsg').textContent = err; $('aoiMsg').className = 'msg'; return false; }
  $('aoiMsg').textContent = '';
  state.aoi = aoi;
  syncForms();
  mapApi.setAOI(aoi, fit);
  pushHash();
  const token = ++loadToken;
  const entries = store.entriesFor(aoi);
  try {
    const missing = entries.filter((e) => !store.tiles.has(e.file));
    if (missing.length) setProgress('Loading map data…', 0);
    await store.load(entries, (done, total, bytes, bytesTotal) => {
      if (token === loadToken) setProgress(`Loading map data… ${done} of ${total} tiles (${(bytes / 1e6).toFixed(1)} of ${(bytesTotal / 1e6).toFixed(1)} MB)`, bytesTotal ? bytes / bytesTotal : 1);
    });
    if (token !== loadToken) return false;       // a newer selection took over
    setProgress(null);
    tiles = store.prepare(aoi, entries);
    analysis = analyze(store, tiles);
    renderAll();
    return true;
  } catch (e) {
    console.error(e);
    if (token === loadToken) setProgress(`Could not load map data: ${e.message}`, 0, true);
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// downloads
const exportHeader = (what) => ({
  title: `SO FIRE · ${what}`,
  subtitle: `${aoiLabel(state.aoi)} · ${periodLabel()} · ${state.metric === 'count' ? 'harmonized hotspots' : 'fire radiative power (MW)'} · MODIS + VIIRS`,
  footer: `Hotspot = fire-active 1 km cell (${state.includeSmall ? 'full VIIRS sensitivity' : 'MODIS-equivalent'}). Satellite detections, not separate fires or burned area.`,
});
function buildSvg(kind) {
  const a = analysis, d = derive(), D = meta.dates, host = document.createElement('div'), sel = dayIndex();
  const common = { dates: D, values: d.series, anomPct: d.an.pct, gaps: a.gaps, unit: unit(), baselineLabel: baselineLabel(), selected: sel >= 0 ? sel : null };
  if (kind === 'cal') return renderCalendar(host, { ...common, view: state.view, header: exportHeader('Burning calendar') });
  if (kind === 'bars') return renderBars(host, { ...common, mean: d.base.mean, sd: d.base.sd, header: exportHeader('Daily activity vs baseline') });
  const series = [
    { name: 'Raw detections (all sensors)', color: '#cbd5e1', dash: '6 4', width: 2, values: Array.from(a.rawTotal) },
    { name: 'Harmonized hotspots', color: '#fb923c', width: 3.2, values: Array.from(d.cells) },
    { name: 'Cells seen by MODIS', color: '#38bdf8', width: 2, values: Array.from(a.modisCells) },
    { name: 'Cells seen by VIIRS', color: '#c4b5fd', dash: '2 3', width: 2.4, values: Array.from(a.viirsCells) },
  ];
  return renderLines(host, { dates: D, series, gaps: a.gaps, header: exportHeader('Harmonization check') });
}
async function downloadChart(kind, fmt) {
  if (!analysis) return;
  const svg = buildSvg(kind);
  const name = `so-fire_${{ cal: 'calendar', bars: 'daily', lines: 'harmonization' }[kind]}_${aoiSlug(state.aoi)}_${meta.dates[0].slice(0, 7)}.${fmt}`;
  try { saveBlob(fmt === 'png' ? await svgToPngBlob(svg, 2) : svgToBlob(svg), name); }
  catch (e) { $('dlMsg').textContent = e.message; }
}
function say(msg, ok) { const m = $('dlMsg'); m.textContent = msg; m.className = 'msg' + (ok ? ' ok' : ''); }

function downloadHotspots() {
  if (!analysis) return;
  const sel = dayIndex(), opts = { dayIndex: sel >= 0 ? sel : null, includeSmall: state.includeSmall };
  const n = countHotspotRows(tiles, opts);
  if (!n) { say('No hotspots to export for this selection.'); return; }
  if (n > 1500000 && !confirm(`This export has ${fmtInt(n)} rows (roughly ${Math.round(n * 62 / 1e6)} MB). Continue? A smaller area or a single day is much faster.`)) return;
  const parts = [];
  const rows = exportHotspotRows(store, tiles, opts, (s) => parts.push(s));
  saveBlob(new Blob(parts, { type: 'text/csv;charset=utf-8' }), `so-fire_hotspots_${aoiSlug(state.aoi)}_${state.day || meta.dates[0].slice(0, 7)}.csv`);
  say(`Saved ${fmtInt(rows)} hotspot rows.`, true);
}
function downloadDaily() {
  if (!analysis) return;
  const d = derive();
  saveBlob(new Blob([dailySummaryCSV(meta, analysis, d.an)], { type: 'text/csv;charset=utf-8' }), `so-fire_daily_${aoiSlug(state.aoi)}_${meta.dates[0].slice(0, 7)}.csv`);
  say('Saved the daily summary.', true);
}

// ---------------------------------------------------------------------------------------------
function methodsHTML() {
  const raw = meta.raw_detections.total, rawN = Object.values(raw).reduce((s, v) => s + v, 0);
  const cd = meta.cell_days;
  const gapList = meta.qc.days.filter((q) => q.gaps.length).map((q) => `${+q.date.slice(8)} ${monthName().slice(0, 3)}: ${q.gaps.map((g) => g.sensor.replace('VIIRS_', 'VIIRS ')).join(', ')}`).join('; ') || 'none';
  return `
    <h4>What the numbers mean</h4>
    <p>A <b>hotspot</b> here is a <i>fire-active cell</i>: a ~1 km grid cell in which at least one satellite saw a thermal anomaly on that day. It is a satellite detection, not a count of separate fires, and not burned area. Heat from volcanoes, gas flares and industry is included.</p>
    <h4>Harmonization (MODIS + VIIRS → one series)</h4>
    <ul>
      <li><b>One grid.</b> Every detection is snapped to a ~1 km equal-area grid (cells keep a similar area at all latitudes).</li>
      <li><b>No double counting.</b> All detections in a cell on a day (any sensor, any overpass, any of the three VIIRS satellites) become one record. The ${fmtInt(rawN)} raw detections in this dataset collapse to ${fmtInt(cd.total)} cell-days.</li>
      <li><b>Comparable sensitivity.</b> MODIS (1 km pixels) cannot see small fires that VIIRS (375 m) can. A VIIRS-only cell is counted as "MODIS-equivalent" only if its fire radiative power is at least <b>${meta.modis_floor_mw} MW</b>, the 1st percentile of MODIS cell FRP in this data. That leaves ${fmtInt(cd.modis_equivalent)} of ${fmtInt(cd.total)} cell-days. Tick “Include small VIIRS-only fires” to see the rest.</li>
      <li><b>Cell FRP</b> is the largest single-sensor total in the cell (satellites pass at different times, so they are never added together).</li>
      <li><b>Satellite gaps.</b> For the selected area, a VIIRS satellite delivering less than ${Math.round(meta.qc.viirs_gap_ratio * 100)}% of what the other two see (when they see at least 100 detections) marks the day with a ⚠. Gap days are excluded from the baseline mean. In this dataset: ${gapList} (dataset-wide check).</li>
    </ul>
    <h4>Reading the anomaly view</h4>
    <p>“vs mean” compares each day with the mean of the other days of ${periodLabel()} in the selected area. The data holds a single month, so this is <i>not</i> a multi-year climatology; the pipeline and app are built so that adding more months or years simply extends the calendar.</p>
    <h4>Known limits</h4>
    <ul>
      <li>Harmonization makes sensors comparable; it does not make them identical. Overpass times and detection probability still differ.</li>
      <li>Area figures use the cell centre, so cells on the border can fall either side by up to ~0.5 km.</li>
      <li>Large fires produce many cells; counts show spread and persistence as much as the number of ignitions.</li>
    </ul>`;
}

// ---------------------------------------------------------------------------------------------
function bind() {
  const preset = $('preset');
  preset.append(...PRESETS.map((p) => el('option', { value: p.id }, p.name)), el('option', { value: 'custom' }, 'Custom area'));
  preset.addEventListener('change', () => { const p = PRESETS.find((x) => x.id === preset.value); if (p) setAOI(p.aoi); });

  $('drawBtn').addEventListener('click', () => mapApi.setMode(mapApi.getMode() === 'box' ? null : 'box'));
  $('pickBtn').addEventListener('click', () => mapApi.setMode(mapApi.getMode() === 'center' ? null : 'center'));

  const num = (id) => { const v = $(id).value.trim(); return v === '' ? NaN : Number(v); };
  $('boxForm').addEventListener('submit', (e) => { e.preventDefault(); setAOI({ type: 'bbox', south: num('bS'), north: num('bN'), west: num('bW'), east: num('bE') }); });
  $('circleForm').addEventListener('submit', (e) => { e.preventDefault(); setAOI({ type: 'circle', lat: num('cLat'), lng: num('cLng'), radiusKm: num('cR') }); });

  document.querySelectorAll('[data-metric]').forEach((b) => b.addEventListener('click', () => { state.metric = b.dataset.metric; segSync('metric'); pushHash(); renderAll(); }));
  document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => { state.view = b.dataset.view; segSync('view'); pushHash(); renderAll(); }));
  document.querySelectorAll('[data-color]').forEach((b) => b.addEventListener('click', () => { state.mapColor = b.dataset.color; segSync('color'); pushHash(); syncMap(); }));
  $('small').addEventListener('change', () => { state.includeSmall = $('small').checked; pushHash(); renderAll(); });
  $('dayClear').addEventListener('click', () => setDay(null));
  $('retryBtn').addEventListener('click', () => setAOI(state.aoi, { fit: false }));

  document.querySelectorAll('[data-dl]').forEach((b) => b.addEventListener('click', () => { const [kind, fmt] = b.dataset.dl.split('-'); downloadChart(kind, fmt); }));
  $('csvHot').addEventListener('click', downloadHotspots);
  $('csvDaily').addEventListener('click', downloadDaily);
  $('copyLink').addEventListener('click', async () => {
    pushHash();
    try { await navigator.clipboard.writeText(location.href); say('Link copied. It reopens this area, day and settings.', true); }
    catch { window.prompt('Copy this link:', location.href); }
  });
  $('methodsBtn').addEventListener('click', () => { const d = $('methods'); d.open = true; $('analytics').scrollTo({ top: d.offsetTop - 8 }); d.scrollIntoView({ block: 'start' }); d.querySelector('summary').focus(); });

  // tooltips for chart elements
  const tip = $('tip');
  document.addEventListener('mousemove', (e) => {
    const t = e.target.closest?.('[data-tip]');
    if (!t) { tip.hidden = true; return; }
    tip.textContent = t.getAttribute('data-tip');
    tip.hidden = false;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = Math.min(window.innerWidth - w - 8, e.clientX + 14) + 'px';
    tip.style.top = Math.min(window.innerHeight - h - 8, e.clientY + 14) + 'px';
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') tip.hidden = true; });
}

function segSync(which) {
  const map = { metric: ['data-metric', state.metric], view: ['data-view', state.view], color: ['data-color', state.mapColor] }[which];
  document.querySelectorAll(`[${map[0]}]`).forEach((b) => b.setAttribute('aria-pressed', String(b.getAttribute(map[0]) === map[1])));
}

function legendHTML(info) {
  const lg = $('mapLegend');
  if (!info) { lg.replaceChildren(); return; }
  if (info.empty) { lg.replaceChildren(el('div', {}, 'No hotspots in view for this selection.')); return; }
  const stops = Array.from({ length: 8 }, (_, i) => heatColor(i / 7)).join(',');
  const km = info.binKm < 1.6 ? 'a 1 km cell' : `a ~${Math.round(info.binKm)} km square`;
  const title = info.colorMode === 'frp' ? `Strongest fire (MW) in ${km}` : `Fire-active 1 km cells in ${km}`;
  const g = el('div', { className: 'grad' });
  g.style.background = `linear-gradient(90deg, ${stops})`;
  lg.replaceChildren(el('div', {}, title), g, el('div', { className: 'lab' }, el('span', {}, fmtCompact(info.vmin)), el('span', {}, `${fmtCompact(info.vmax)}${info.colorMode === 'frp' ? '+' : ''}`)), el('div', { className: 'muted' }, 'log scale'));
}

async function init() {
  try { meta = await loadMeta(); }
  catch (e) { $('datasetBadge').textContent = 'data missing'; $('aoiMsg').textContent = e.message; console.error(e); return; }
  store = new Store(meta);
  const cd = meta.cell_days.total;
  $('datasetBadge').textContent = `${meta.dates.length} days · ${fmtCompact(Object.values(meta.raw_detections.total).reduce((s, v) => s + v, 0))} detections → ${fmtCompact(cd)} cell-days`;
  $('methodsBody').innerHTML = methodsHTML();

  const fromHash = decodeState(location.hash);
  if (fromHash.aoi) state.aoi = fromHash.aoi;
  if (fromHash.day && meta.dates.includes(fromHash.day)) state.day = fromHash.day;
  Object.assign(state, { includeSmall: !!fromHash.includeSmall, metric: fromHash.metric || 'count', view: fromHash.view || 'abs', mapColor: fromHash.mapColor || 'density' });
  $('small').checked = state.includeSmall;
  ['metric', 'view', 'color'].forEach(segSync);

  bind();
  mapApi = createMap($('map'), {
    onLegend: legendHTML,
    onBox: (a) => setAOI(a, { fit: false }),
    onCenter: (lat, lng) => { const r = Number($('cR').value) || 50; setAOI({ type: 'circle', lat, lng, radiusKm: r }); },
    onDrawTooSmall: () => { $('aoiMsg').textContent = 'That box was too small. Click “Draw box” and drag a larger rectangle.'; $('aoiMsg').className = 'msg'; },
    onBasemapError: () => { $('aoiMsg').textContent = 'Basemap tiles are unavailable (offline?). The map still shows country outlines and fire data.'; $('aoiMsg').className = 'msg'; },
    onMode: (m) => {
      $('drawBtn').setAttribute('aria-pressed', String(m === 'box'));
      $('pickBtn').setAttribute('aria-pressed', String(m === 'center'));
      if (m) { $('aoiMsg').textContent = m === 'box' ? 'Click and drag on the map to draw a box. Esc cancels.' : 'Click the map to set the centre. The radius box next to the button sets its size. Esc cancels.'; $('aoiMsg').className = 'msg ok'; }
      else if ($('aoiMsg').className.includes('ok')) $('aoiMsg').textContent = '';
    },
  });
  new ResizeObserver(() => mapApi.invalidate()).observe($('map'));
  await setAOI(state.aoi, { fit: true });
}

window.__sofire = { get state() { return state; }, get analysis() { return analysis; }, get store() { return store; }, setAOI, setDay };   // handy for debugging / tests
init();
