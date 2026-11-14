// Loading, decoding and analysing the harmonized tiles produced by pipeline/harmonize.py.
import { aoiBoxes, aoiTest } from './aoi.js';

export const SENSOR_NAMES = ['MODIS', 'VIIRS Suomi-NPP', 'VIIRS NOAA-20', 'VIIRS NOAA-21'];
export const SENSOR_CODES = ['MODIS', 'VIIRS_SNPP', 'VIIRS_NOAA20', 'VIIRS_NOAA21'];
const GAP_RATIO = 0.7;        // same rule as the pipeline: satellite < 70 % of its peers' mean ...
const GAP_MIN_PEER = 100;     // ... but only judged when its peers saw at least this many detections in the area

export const DATA_BASE = 'data/';

export async function loadMeta(url = DATA_BASE + 'meta.json') {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url} (HTTP ${res.status}). Run: python pipeline/harmonize.py`);
  return res.json();
}

// ---- grid ------------------------------------------------------------------------------------
export function createGrid(meta) {
  const { rows, step_deg: step } = meta.grid;
  const ncols = Int32Array.from(meta.grid.ncols);
  const latOfRow = new Float64Array(rows);
  const yFrac = new Float64Array(rows);       // Web-Mercator y in [0,1] (0 = north edge)
  for (let r = 0; r < rows; r++) {
    const lat = -90 + (r + 0.5) * step;
    latOfRow[r] = lat;
    const phi = (lat * Math.PI) / 180;
    yFrac[r] = (1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2;
  }
  return { rows, step, ncols, latOfRow, yFrac, tileDeg: meta.grid.tile_deg, lngOf: (r, c) => -180 + ((c + 0.5) * 360) / ncols[r] };
}

// ---- tile decoding ---------------------------------------------------------------------------
async function gunzip(buf) {
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

export async function decodeTile(buf) {
  const head = new Uint8Array(buf, 0, 2);
  // Some hosts send .gz files with "Content-Encoding: gzip", so the browser may already have inflated them.
  if (head[0] === 0x1f && head[1] === 0x8b) buf = await gunzip(buf);
  const dv = new DataView(buf);
  if (dv.getUint32(0, false) !== 0x53464831) throw new Error('Not a SO FIRE tile (bad magic bytes)');
  const n = dv.getUint32(4, true);
  let o = 8;
  const u16 = () => { const a = new Uint16Array(buf, o, n); o += 2 * n; return a; };
  const u8 = () => { const a = new Uint8Array(buf, o, n); o += n; return a; };
  const row = u16(), col = u16(), f16 = u16();
  const day = u8(), flags = u8(), nm = u8(), ns = u8(), n20 = u8(), n21 = u8();
  const frp = new Float32Array(n);
  for (let i = 0; i < n; i++) { const v = f16[i]; frp[i] = v < 32768 ? v / 10 : v - 32768; }
  return { n, row, col, frp, day, flags, nm, ns, n20, n21, mask: null, maskKey: null, inside: 0 };
}

export class Store {
  constructor(meta) {
    this.meta = meta;
    this.grid = createGrid(meta);
    this.tiles = new Map();              // file -> decoded tile
    this.index = meta.tiles;
    this.nDays = meta.dates.length;
  }

  /** Tile index entries that overlap the AOI. */
  entriesFor(aoi) {
    const T = this.grid.tileDeg, boxes = aoiBoxes(aoi), out = new Map();
    for (const b of boxes) {
      const ty0 = Math.max(0, Math.floor((b.s + 90) / T)), ty1 = Math.min(180 / T - 1, Math.floor((b.n + 90) / T));
      const tx0 = Math.max(0, Math.floor((b.w + 180) / T)), tx1 = Math.min(360 / T - 1, Math.floor((b.e + 180) / T));
      for (const t of this.index) if (t.ty >= ty0 && t.ty <= ty1 && t.tx >= tx0 && t.tx <= tx1) out.set(t.file, t);
    }
    return [...out.values()];
  }

  /** Download + decode whatever is not cached yet (6 requests in flight). */
  async load(entries, onProgress) {
    const todo = entries.filter((e) => !this.tiles.has(e.file));
    const bytesTotal = todo.reduce((a, e) => a + e.bytes, 0);
    let done = 0, bytes = 0, next = 0;
    onProgress?.(0, todo.length, 0, bytesTotal);
    const worker = async () => {
      while (next < todo.length) {
        const e = todo[next++];
        let lastErr;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const res = await fetch(DATA_BASE + e.file);
            if (!res.ok) throw new Error(`HTTP ${res.status} for ${e.file}`);
            this.tiles.set(e.file, await decodeTile(await res.arrayBuffer()));
            lastErr = null;
            break;
          } catch (err) { lastErr = err; await new Promise((r) => setTimeout(r, 300 * (attempt + 1))); }
        }
        if (lastErr) throw lastErr;
        done++; bytes += e.bytes;
        onProgress?.(done, todo.length, bytes, bytesTotal);
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, todo.length) }, worker));
  }

  /** Mark which records of the AOI's tiles fall inside it. Returns the tile list. */
  prepare(aoi, entries) {
    const test = aoiTest(aoi), g = this.grid;
    const key = JSON.stringify(aoi);
    const tiles = [];
    for (const e of entries) {
      const t = this.tiles.get(e.file);
      if (!t) continue;
      if (t.maskKey !== key) {
        const mask = new Uint8Array(t.n);
        let inside = 0;
        for (let i = 0; i < t.n; i++) {
          const r = t.row[i];
          if (test(g.latOfRow[r], g.lngOf(r, t.col[i]))) { mask[i] = 1; inside++; }
        }
        t.mask = mask; t.maskKey = key; t.inside = inside;
      }
      if (t.inside) tiles.push(t);
    }
    return tiles;
  }
}

// ---- analysis --------------------------------------------------------------------------------
const zeros = (n) => new Float64Array(n);

/** Per-day series for the tiles returned by Store.prepare(). */
export function analyze(store, tiles) {
  const D = store.nDays;
  const r = {
    D,
    eqCells: zeros(D), allCells: zeros(D),            // harmonized hotspots: MODIS-equivalent / incl. small VIIRS-only fires
    eqFrp: zeros(D), allFrp: zeros(D),                // summed cell FRP (MW)
    raw: [zeros(D), zeros(D), zeros(D), zeros(D)],    // raw detections per sensor (before harmonization)
    modisCells: zeros(D), viirsCells: zeros(D),       // cells in which that sensor family detected fire
    maxFrp: 0, cellDays: 0,
  };
  for (const t of tiles) {
    const { mask, day, flags, frp, nm, ns, n20, n21 } = t;
    for (let i = 0; i < t.n; i++) {
      if (!mask[i]) continue;
      const d = day[i], f = frp[i];
      r.allCells[d]++; r.allFrp[d] += f;
      if ((flags[i] & 1) === 0) { r.eqCells[d]++; r.eqFrp[d] += f; }
      r.raw[0][d] += nm[i]; r.raw[1][d] += ns[i]; r.raw[2][d] += n20[i]; r.raw[3][d] += n21[i];
      if (nm[i]) r.modisCells[d]++;
      if (ns[i] + n20[i] + n21[i]) r.viirsCells[d]++;
      if (f > r.maxFrp) r.maxFrp = f;
      r.cellDays++;
    }
  }
  r.rawTotal = zeros(D);
  for (let d = 0; d < D; d++) r.rawTotal[d] = r.raw[0][d] + r.raw[1][d] + r.raw[2][d] + r.raw[3][d];
  r.gaps = detectGaps(r.raw, store.meta);
  return r;
}

/** Sensor-gap days for the AOI: a VIIRS satellite far below its two peers (a satellite outage, not fewer fires). */
export function detectGaps(raw, meta) {
  const D = raw[0].length, out = [];
  for (let d = 0; d < D; d++) {
    const g = [];
    for (let s = 1; s <= 3; s++) {
      const peers = [1, 2, 3].filter((p) => p !== s).map((p) => raw[p][d]);
      const ref = (peers[0] + peers[1]) / 2;
      if (ref >= GAP_MIN_PEER && raw[s][d] < GAP_RATIO * ref) g.push({ sensor: SENSOR_NAMES[s], n: raw[s][d], expected: Math.round(ref) });
    }
    for (const q of meta.qc?.days?.[d]?.gaps || []) if (q.sensor === 'MODIS') g.push({ sensor: 'MODIS', n: q.detections, expected: q.expected });
    out.push(g);
  }
  return out;
}

/** Mean and standard deviation over days without a sensor gap (falls back to all days). */
export function baseline(series, gaps) {
  let idx = [];
  for (let i = 0; i < series.length; i++) if (!gaps[i].length) idx.push(i);
  if (idx.length < 3) idx = Array.from(series, (_, i) => i);
  const mean = idx.reduce((a, i) => a + series[i], 0) / idx.length;
  const sd = Math.sqrt(idx.reduce((a, i) => a + (series[i] - mean) ** 2, 0) / idx.length);
  return { mean, sd, n: idx.length };
}

export function anomalies(series, { mean, sd }) {
  return {
    pct: Array.from(series, (v) => (mean > 0 ? ((v - mean) / mean) * 100 : NaN)),
    z: Array.from(series, (v) => (sd > 0 ? (v - mean) / sd : NaN)),
  };
}

export function pearson(a, b, skip) {
  const xs = [], ys = [];
  for (let i = 0; i < a.length; i++) if (!skip?.[i]?.length) { xs.push(a[i]); ys.push(b[i]); }
  const n = xs.length;
  if (n < 5) return { r: NaN, n };
  const mx = xs.reduce((s, v) => s + v, 0) / n, my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  return { r: sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN, n };
}

export function rankOf(series, i) {           // 1 = busiest
  let rank = 1;
  for (let k = 0; k < series.length; k++) if (series[k] > series[i]) rank++;
  return rank;
}

// ---- CSV export ------------------------------------------------------------------------------
const csvCell = (v) => (/[",\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : v);

/** Hotspot rows for the AOI. Calls onChunk(string) repeatedly; returns the number of rows written. */
export function exportHotspotRows(store, tiles, { dayIndex = null, includeSmall = false }, onChunk) {
  const g = store.grid, dates = store.meta.dates;
  let buf = [], rows = 0;
  onChunk('date,latitude,longitude,frp_mw,detected_by,n_modis,n_viirs_snpp,n_viirs_noaa20,n_viirs_noaa21,modis_equivalent\n');
  for (const t of tiles) {
    for (let i = 0; i < t.n; i++) {
      if (!t.mask[i]) continue;
      if (dayIndex !== null && t.day[i] !== dayIndex) continue;
      const small = (t.flags[i] & 1) === 1;
      if (small && !includeSmall) continue;
      const r = t.row[i];
      const by = [];
      if (t.nm[i]) by.push('MODIS');
      if (t.ns[i]) by.push('VIIRS_SNPP');
      if (t.n20[i]) by.push('VIIRS_NOAA20');
      if (t.n21[i]) by.push('VIIRS_NOAA21');
      buf.push(`${dates[t.day[i]]},${g.latOfRow[r].toFixed(4)},${g.lngOf(r, t.col[i]).toFixed(4)},${t.frp[i].toFixed(1)},${by.join('|')},${t.nm[i]},${t.ns[i]},${t.n20[i]},${t.n21[i]},${small ? 0 : 1}`);
      rows++;
      if (buf.length >= 20000) { onChunk(buf.join('\n') + '\n'); buf = []; }
    }
  }
  if (buf.length) onChunk(buf.join('\n') + '\n');
  return rows;
}

export function countHotspotRows(tiles, { dayIndex = null, includeSmall = false }) {
  let n = 0;
  for (const t of tiles) for (let i = 0; i < t.n; i++) {
    if (!t.mask[i]) continue;
    if (dayIndex !== null && t.day[i] !== dayIndex) continue;
    if (!includeSmall && (t.flags[i] & 1)) continue;
    n++;
  }
  return n;
}

export function dailySummaryCSV(meta, a, extra) {
  const head = ['date', 'hotspots_modis_equivalent', 'hotspots_all_incl_small_viirs', 'frp_total_mw_modis_equivalent', 'frp_total_mw_all',
    'raw_detections_modis', 'raw_detections_viirs_snpp', 'raw_detections_viirs_noaa20', 'raw_detections_viirs_noaa21',
    'cells_with_modis', 'cells_with_viirs', 'anomaly_pct_vs_baseline', 'anomaly_zscore', 'sensor_gap'];
  const lines = [head.join(',')];
  meta.dates.forEach((d, i) => {
    lines.push([d, a.eqCells[i], a.allCells[i], a.eqFrp[i].toFixed(1), a.allFrp[i].toFixed(1), a.raw[0][i], a.raw[1][i], a.raw[2][i], a.raw[3][i],
      a.modisCells[i], a.viirsCells[i], Number.isFinite(extra.pct[i]) ? extra.pct[i].toFixed(1) : '', Number.isFinite(extra.z[i]) ? extra.z[i].toFixed(2) : '',
      csvCell(a.gaps[i].map((g) => `${g.sensor} ${g.n} of ~${g.expected}`).join('; '))].join(','));
  });
  return lines.join('\n') + '\n';
}
