# SO FIRE — harmonized MODIS + VIIRS burning-activity calendar

Pick any area on Earth and see **August 2026** fire activity as a burning calendar, built from MODIS and VIIRS
active-fire hotspots that have been harmonized so the sensor of origin no longer matters.

**Run it:** `python3 -m http.server 8000` in this folder, then open http://localhost:8000
(or publish the folder with GitHub Pages — it is fully static; only the basemap needs internet).

## What you can do
- **Choose an area**: presets, **draw a box** on the map, **pick a centre + radius**, or **type coordinates** (boxes may cross the dateline).
- **Burning calendar**: one square per day, colour = hotspots (or fire radiative power). Switch to **“vs mean”** for anomalies.
  Sequential *Inferno* ramp and a blue↔orange diverging ramp (colour-blind safe); numbers are printed in every square.
- **Select a day** to focus the map, see its rank, % anomaly and z-score, and any satellite gap.
- **Daily bars** with baseline mean ±1 SD, and a **harmonization check** (raw vs harmonized vs MODIS-only vs VIIRS-only, with correlation).
- **Downloads**: hotspot **CSV** for the current search, daily-summary CSV, calendar/charts as **PNG or SVG**, and a **shareable link**.
- Keyboard accessible (arrow keys in the calendar), labelled controls, table alternative for all daily numbers.

## Phase 1 — harmonization (`pipeline/harmonize.py`)
Raw input: daily files `YYYY-MM-DD.json.gz` (`lat, lng, frp, sensor`). The script
1. snaps every detection to a **~1 km equal-area grid**;
2. **collapses duplicates**: all sensors/overpasses/VIIRS satellites in a cell on a day become one *fire-active cell-day*
   (9.13 M raw detections → 3.18 M cell-days; VIIRS supplied 94 % of raw detections);
3. applies a **MODIS-equivalent sensitivity floor** estimated from the data (1st percentile of MODIS cell FRP = 4.3 MW), flagging smaller VIIRS-only
   fires so the series stays consistent with the MODIS record (they can still be shown: *Include small VIIRS-only fires*);
4. **QC**: flags satellite outages (e.g. Suomi-NPP delivered 1,973 detections on 3 Aug vs ~73,000 expected) so they are not read as a lull in burning;
5. writes 10°×10° binary tiles (`data/tiles`, 12.5 MB total vs 95 MB raw) and `data/meta.json`.

```
pip install -r requirements.txt
python3 pipeline/harmonize.py            # raw files in data/raw/ or the repo root
python3 pipeline/verify.py               # independent check against the raw files
python3 pipeline/verify.py --bbox -11 25 92 141   # reference numbers for any box
```
`verify.py` confirms per-day, per-sensor detection counts and cell counts match the raw data exactly. The web app's figures were
cross-checked against it (e.g. Southeast Asia: 135,112 MODIS-equivalent hotspots, 6,706 on 22 Aug).

## Phase 2 — web app (`index.html`, `js/`, `css/`)
Static, no build step. Leaflet is vendored in `vendor/`. Only tiles overlapping the chosen area are downloaded and cached.

## Limits (please read)
- A hotspot is a **satellite heat detection**, not a count of separate fires and not burned area; volcanoes, gas flares and industry are included.
- Harmonization makes sensors **comparable, not identical**.
- The supplied data covers **August 2026 only**, so anomalies are against the August mean (satellite-gap days excluded), **not a multi-year climatology**.
  The pipeline and app accept more dated files and the calendar then shows every month present.
- 9 VIIRS detections had a negative FRP; they are kept as hotspots with FRP 0.

Credits: MODIS and VIIRS active-fire detections (NASA FIRMS products) · Leaflet (BSD-2) · basemap © OpenStreetMap contributors © CARTO · outlines from Natural Earth via world-atlas (ISC).
