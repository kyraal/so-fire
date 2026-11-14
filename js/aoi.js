// Area-of-interest geometry: bounding box (may cross the antimeridian) or circle (point + radius).
// An AOI is either
//   { type: 'bbox',   south, north, west, east }      west > east means the box crosses 180 deg
//   { type: 'circle', lat, lng, radiusKm }

const R_EARTH_KM = 6371.0088;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

export const PRESETS = [
  { id: 'sea', name: 'Southeast Asia', aoi: { type: 'bbox', south: -11, north: 25, west: 92, east: 141 } },
  { id: 'global', name: 'Global', aoi: { type: 'bbox', south: -90, north: 90, west: -180, east: 180 } },
  { id: 'sam', name: 'South America', aoi: { type: 'bbox', south: -35, north: 12, west: -82, east: -34 } },
  { id: 'afr', name: 'Africa (Sahel to Cape)', aoi: { type: 'bbox', south: -35, north: 18, west: -18, east: 52 } },
  { id: 'wna', name: 'Western North America', aoi: { type: 'bbox', south: 32, north: 60, west: -125, east: -104 } },
  { id: 'med', name: 'Mediterranean & Southern Europe', aoi: { type: 'bbox', south: 30, north: 46, west: -10, east: 40 } },
  { id: 'sib', name: 'Siberia', aoi: { type: 'bbox', south: 50, north: 72, west: 60, east: 140 } },
  { id: 'aus', name: 'Australia', aoi: { type: 'bbox', south: -45, north: -10, west: 112, east: 154 } },
];

export function wrapLng(l) {
  let x = ((l + 180) % 360 + 360) % 360 - 180;
  if (x === -180 && l > 0) x = 180;
  return x;
}

export function validate(aoi) {
  if (!aoi) return 'No area selected.';
  if (aoi.type === 'bbox') {
    const v = [aoi.south, aoi.north, aoi.west, aoi.east];
    if (v.some((x) => typeof x !== 'number' || !Number.isFinite(x))) return 'Enter all four box coordinates as numbers.';
    if (aoi.south < -90 || aoi.north > 90) return 'Latitude must be between -90 and 90.';
    if (aoi.south >= aoi.north) return 'South must be smaller than north.';
    if (aoi.west < -180 || aoi.west > 180 || aoi.east < -180 || aoi.east > 180) return 'Longitude must be between -180 and 180.';
    if (aoi.west === aoi.east) return 'West and east must differ.';
    return null;
  }
  if (aoi.type === 'circle') {
    const v = [aoi.lat, aoi.lng, aoi.radiusKm];
    if (v.some((x) => typeof x !== 'number' || !Number.isFinite(x))) return 'Enter latitude, longitude and radius as numbers.';
    if (Math.abs(aoi.lat) > 90) return 'Latitude must be between -90 and 90.';
    if (Math.abs(aoi.lng) > 180) return 'Longitude must be between -180 and 180.';
    if (aoi.radiusKm <= 0 || aoi.radiusKm > 3000) return 'Radius must be between 1 and 3000 km.';
    return null;
  }
  return 'Unknown area type.';
}

/** One or two plain lat/lng boxes {s,n,w,e} (w <= e) that cover the AOI. */
export function aoiBoxes(aoi) {
  if (aoi.type === 'bbox') {
    if (aoi.west <= aoi.east) return [{ s: aoi.south, n: aoi.north, w: aoi.west, e: aoi.east }];
    return [
      { s: aoi.south, n: aoi.north, w: aoi.west, e: 180 },
      { s: aoi.south, n: aoi.north, w: -180, e: aoi.east },
    ];
  }
  const d = aoi.radiusKm / R_EARTH_KM;                 // angular radius
  const s = Math.max(-90, aoi.lat - deg(d)), n = Math.min(90, aoi.lat + deg(d));
  if (n >= 90 || s <= -90) return [{ s, n, w: -180, e: 180 }];
  const dLng = deg(Math.asin(Math.min(1, Math.sin(d) / Math.cos(rad(aoi.lat)))));
  const w = aoi.lng - dLng, e = aoi.lng + dLng;
  if (w < -180) return [{ s, n, w: w + 360, e: 180 }, { s, n, w: -180, e }];
  if (e > 180) return [{ s, n, w, e: 180 }, { s, n, w: -180, e: e - 360 }];
  return [{ s, n, w, e }];
}

/** Fast membership test for a cell centroid. */
export function aoiTest(aoi) {
  if (aoi.type === 'bbox') {
    const { south, north, west, east } = aoi;
    const wraps = west > east;
    return (lat, lng) => lat >= south && lat <= north && (wraps ? lng >= west || lng <= east : lng >= west && lng <= east);
  }
  const lat0 = rad(aoi.lat), lng0 = rad(aoi.lng), cos0 = Math.cos(lat0), r = aoi.radiusKm;
  return (lat, lng) => {
    const dLat = rad(lat) - lat0, dLng = rad(lng) - lng0;
    const a = Math.sin(dLat / 2) ** 2 + cos0 * Math.cos(rad(lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R_EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a))) <= r;
  };
}

const fmtLat = (v) => `${Math.abs(v).toFixed(2).replace(/\.?0+$/, '')}°${v < 0 ? 'S' : 'N'}`;
const fmtLng = (v) => `${Math.abs(v).toFixed(2).replace(/\.?0+$/, '')}°${v < 0 ? 'W' : 'E'}`;

export function aoiLabel(aoi) {
  const preset = PRESETS.find((p) => JSON.stringify(p.aoi) === JSON.stringify(aoi));
  if (preset) return preset.name;
  if (aoi.type === 'bbox') return `Box ${fmtLat(aoi.south)} to ${fmtLat(aoi.north)}, ${fmtLng(aoi.west)} to ${fmtLng(aoi.east)}`;
  return `${Math.round(aoi.radiusKm)} km around ${fmtLat(aoi.lat)}, ${fmtLng(aoi.lng)}`;
}

export function aoiSlug(aoi) {
  const preset = PRESETS.find((p) => JSON.stringify(p.aoi) === JSON.stringify(aoi));
  if (preset) return preset.id;
  const f = (v) => String(Math.round(v * 100) / 100).replace('-', 'm').replace('.', 'p');
  return aoi.type === 'bbox' ? `box_${f(aoi.south)}_${f(aoi.north)}_${f(aoi.west)}_${f(aoi.east)}` : `circle_${f(aoi.lat)}_${f(aoi.lng)}_${f(aoi.radiusKm)}km`;
}

// ---- URL hash state (shareable links) --------------------------------------------------------
export function encodeState(st) {
  const q = new URLSearchParams();
  const a = st.aoi;
  q.set('aoi', a.type === 'bbox' ? `box:${a.south},${a.north},${a.west},${a.east}` : `circle:${a.lat},${a.lng},${a.radiusKm}`);
  if (st.day) q.set('day', st.day);
  if (st.includeSmall) q.set('small', '1');
  if (st.metric !== 'count') q.set('metric', st.metric);
  if (st.view !== 'abs') q.set('view', st.view);
  if (st.mapColor !== 'density') q.set('color', st.mapColor);
  return q.toString();
}

export function decodeState(hash) {
  const q = new URLSearchParams((hash || '').replace(/^#/, ''));
  const out = {};
  const a = q.get('aoi');
  if (a) {
    const [kind, vals] = a.split(':');
    const n = (vals || '').split(',').map(Number);
    if (kind === 'box' && n.length === 4) out.aoi = { type: 'bbox', south: n[0], north: n[1], west: n[2], east: n[3] };
    if (kind === 'circle' && n.length === 3) out.aoi = { type: 'circle', lat: n[0], lng: n[1], radiusKm: n[2] };
    if (out.aoi && validate(out.aoi)) delete out.aoi;
  }
  if (q.get('day')) out.day = q.get('day');
  if (q.get('small') === '1') out.includeSmall = true;
  if (['count', 'frp'].includes(q.get('metric'))) out.metric = q.get('metric');
  if (['abs', 'anom'].includes(q.get('view'))) out.view = q.get('view');
  if (['density', 'frp'].includes(q.get('color'))) out.mapColor = q.get('color');
  return out;
}
