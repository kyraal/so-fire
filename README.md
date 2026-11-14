# SO FIRE — GitHub Pages starter

## Files
- `index.html` — the SO FIRE web app
- `data/hotspots.json` — your supplied hotspot dataset

## Run locally
From this folder, run:

```bash
python -m http.server 8000
```

Then open http://localhost:8000

Do not open `index.html` directly as a `file://` URL; browsers block local `fetch()` requests.

## Publish using GitHub Pages
1. Create a public GitHub repository, e.g. `so-fire`.
2. Upload `index.html` and the `data` folder (including `hotspots.json`) to the repository root.
3. Open **Settings → Pages**.
4. Under **Build and deployment**, choose **Deploy from a branch**.
5. Select branch `main` and folder `/ (root)`, then Save.
6. Wait for GitHub Pages to publish the site.

The app uses relative path `./data/hotspots.json`, so it works from a GitHub Pages project URL.

## Important dataset note
The supplied JSON currently contains **one acquisition date (2026-08-15)** and **50,667 hotspot detections**. The globe and CSV export work with this snapshot, but date playback needs at least two dates. Add data from multiple acquisition dates to enable the time slider and animation.

## Data interpretation
These are satellite hotspot detections, not a count of unique fires or burned area. MODIS and VIIRS have different spatial resolutions and detection characteristics. Keep the sensor field when combining them, and describe the output as a combined/harmonized view rather than claiming the sensors are perfectly interchangeable.
