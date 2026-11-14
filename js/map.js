// Leaflet map: dark basemap + offline country outlines + canvas density layer + AOI drawing tools.
import { aoiBoxes } from './aoi.js';
import { heatColor } from './charts.js';

const L = window.L;
const LUT = Array.from({ length: 64 }, (_, i) => heatColor(i / 63));

export function createMap(el, hooks) {
  const map = L.map(el, {
    zoomSnap: 0.5, minZoom: 2, maxZoom: 12, worldCopyJump: false,
    maxBounds: [[-85, -180], [85, 180]], maxBoundsViscosity: 1,
    zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false, zoomControl: false, keyboard: true,
  });
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  map.createPane('heat').style.zIndex = 350;
  map.createPane('outline').style.zIndex = 380;
  map.createPane('aoi').style.zIndex = 420;
  map.createPane('labels').style.zIndex = 450;
  map.getPane('labels').style.pointerEvents = 'none';
  map.setView([8, 110], 4);

  // Basemap (needs internet with CARTO API key). Outlines below are bundled so the map is never blank.
  let tileErrors = 0;
  const apiKey = 'cb1_590t_1_c65c74a343405e818cd55dc7';
  const attribution = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a> · outlines: Natural Earth';
  
  const base = L.tileLayer(`https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png?key=${apiKey}`, { subdomains: 'abcd', maxZoom: 12, noWrap: true, attribution });
  base.on('tileerror', () => { if (++tileErrors === 3) hooks.onBasemapError?.(); });
  base.addTo(map);
  
  L.tileLayer(`https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png?key=${apiKey}`, { subdomains: 'abcd', maxZoom: 12, noWrap: true, pane: 'labels' }).addTo(map);
  
  fetch('data/world.geojson').then((r) => r.json()).then((g) => {
    L.geoJSON(g, { pane: 'outline', interactive: false, style: { color: '#64748b', weight: 0.8, opacity: 0.85, fill: false } }).addTo(map);
  }).catch(() => {});

  // ---- density layer -------------------------------------------------------------------------
  const canvas = document.createElement('canvas');
  canvas.className = 'sf-heat';
  canvas.setAttribute('aria-hidden', 'true');
  map.getPane('heat').append(canvas);
  let scene = null;

  function draw() {
    const size = map.getSize(), dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(size.x * dpr); canvas.height = Math.round(size.y * dpr);
    canvas.style.width = size.x + 'px'; canvas.style.height = size.y + 'px';
    L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0]));
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.x, size.y);
    if (!scene || !scene.tiles.length) { hooks.onLegend?.(null); return; }

    const { tiles, grid, dayIndex, includeSmall, colorMode } = scene;
    const z = map.getZoom(), world = 256 * 2 ** z, min = map.getPixelBounds().min;
    const mpp = (156543.03392 * Math.cos((map.getCenter().lat * Math.PI) / 180)) / 2 ** z;
    const bin = Math.max(3, Math.min(10, Math.round(1110 / mpp)));
    const W = size.x, H = size.y, bw = Math.ceil(W / bin), bh = Math.ceil(H / bin);
    const cnt = new Uint32Array(bw * bh), mx = new Float32Array(bw * bh);
    const { yFrac, ncols } = grid;
    for (const t of tiles) {
      const { mask, day, flags, row, col, frp } = t;
      for (let i = 0; i < t.n; i++) {
        if (!mask[i]) continue;
        if (dayIndex !== null && day[i] !== dayIndex) continue;
        if (!includeSmall && (flags[i] & 1)) continue;
        const r = row[i];
        const py = yFrac[r] * world - min.y;
        if (py < 0 || py >= H) continue;
        const px = ((col[i] + 0.5) / ncols[r]) * world - min.x;
        if (px < 0 || px >= W) continue;
        const k = ((py / bin) | 0) * bw + ((px / bin) | 0);
        cnt[k]++;
        if (frp[i] > mx[k]) mx[k] = frp[i];
      }
    }
    const src = colorMode === 'frp' ? mx : cnt;
    const vals = [];
    for (let k = 0; k < src.length; k++) if (src[k] > 0) vals.push(src[k]);
    if (!vals.length) { hooks.onLegend?.({ empty: true, colorMode }); return; }
    let vmax;
    if (colorMode === 'frp') { vals.sort((a, b) => a - b); vmax = Math.max(vals[Math.floor(vals.length * 0.995)] || 1, 5); }
    else vmax = Math.max(...vals);
    const lmax = Math.log1p(vmax), lmin = colorMode === 'frp' ? Math.log1p(Math.min(...vals)) : 0;
    let last = -1;
    for (let k = 0; k < src.length; k++) {
      const v = src[k];
      if (v <= 0) continue;
      const tt = lmax > lmin ? (Math.log1p(Math.min(v, vmax)) - lmin) / (lmax - lmin) : 1;
      const ci = Math.max(0, Math.min(63, Math.floor(tt * 63)));
      if (ci !== last) { ctx.fillStyle = LUT[ci]; last = ci; }
      ctx.fillRect((k % bw) * bin, Math.floor(k / bw) * bin, bin, bin);
    }
    hooks.onLegend?.({ colorMode, vmax, vmin: colorMode === 'frp' ? Math.min(...vals) : 1, binKm: (bin * mpp) / 1000, bin });
  }
  map.on('moveend resize', draw);

  // ---- AOI outline ---------------------------------------------------------------------------
  let aoiLayer = null;
  const style = { pane: 'aoi', color: '#ffffff', weight: 2, dashArray: '6 5', fill: false, interactive: false };
  function setAOI(aoi, fit) {
    if (aoiLayer) aoiLayer.remove();
    const g = L.layerGroup();
    let bounds = null;
    for (const b of aoiBoxes(aoi)) {            // plain geometry: no dependence on the layer being on the map yet
      const bb = L.latLngBounds([[b.s, b.w], [b.n, b.e]]);
      bounds = bounds ? bounds.extend(bb) : bb;
    }
    if (aoi.type === 'circle') L.circle([aoi.lat, aoi.lng], { ...style, radius: aoi.radiusKm * 1000 }).addTo(g);
    else for (const b of aoiBoxes(aoi)) L.rectangle([[b.s, b.w], [b.n, b.e]], style).addTo(g);
    aoiLayer = g.addTo(map);
    if (fit) {
      const full = bounds.getSouth() <= -85 && bounds.getNorth() >= 85;
      if (full) map.setView([15, 10], 2);
      else map.fitBounds(bounds, { padding: [24, 24], maxZoom: 9, animate: false });
    }
    draw();
  }

  // ---- drawing tools -------------------------------------------------------------------------
  const container = map.getContainer();
  let mode = null, dragging = false, startLL = null, tmp = null;
  const clampLL = (ll) => ({ lat: Math.max(-90, Math.min(90, ll.lat)), lng: Math.max(-180, Math.min(180, ll.lng)) });
  function setMode(m) {
    mode = m;
    container.classList.toggle('drawing', m !== null);
    if (m === 'box') map.dragging.disable(); else map.dragging.enable();
    container.style.touchAction = m === 'box' ? 'none' : '';
    hooks.onMode?.(m);
  }
  const llAt = (e) => map.containerPointToLatLng(map.mouseEventToContainerPoint(e));
  container.addEventListener('pointerdown', (e) => {
    if (mode !== 'box' || e.target.closest('.leaflet-control') || e.button > 0) return;
    e.preventDefault();
    dragging = true; startLL = clampLL(llAt(e));
    container.setPointerCapture?.(e.pointerId);
  });
  container.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const b = L.latLngBounds(startLL, clampLL(llAt(e)));
    if (!tmp) tmp = L.rectangle(b, { ...style, color: '#fb923c', weight: 2.5 }).addTo(map); else tmp.setBounds(b);
  });
  container.addEventListener('pointerup', (e) => {
    if (!dragging) return;
    dragging = false;
    const end = clampLL(llAt(e));
    if (tmp) { tmp.remove(); tmp = null; }
    const p0 = map.latLngToContainerPoint(startLL), p1 = map.latLngToContainerPoint(end);
    setMode(null);
    if (Math.abs(p0.x - p1.x) < 6 || Math.abs(p0.y - p1.y) < 6) { hooks.onDrawTooSmall?.(); return; }
    const r2 = (v) => Math.round(v * 100) / 100;
    hooks.onBox?.({ type: 'bbox', south: r2(Math.min(startLL.lat, end.lat)), north: r2(Math.max(startLL.lat, end.lat)), west: r2(Math.min(startLL.lng, end.lng)), east: r2(Math.max(startLL.lng, end.lng)) });
  });
  map.on('click', (e) => {
    if (mode !== 'center') return;
    setMode(null);
    const ll = e.latlng.wrap();
    hooks.onCenter?.(Math.round(ll.lat * 1000) / 1000, Math.round(ll.lng * 1000) / 1000);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && mode) { if (tmp) { tmp.remove(); tmp = null; } dragging = false; setMode(null); } });

  return {
    map, setAOI, setMode, getMode: () => mode,
    setScene(s) { scene = s; draw(); },
    redraw: draw,
    invalidate() { map.invalidateSize(); draw(); },
  };
}
