#!/usr/bin/env python3
"""
SO FIRE - Phase 1: MODIS + VIIRS hotspot harmonization.

Reads daily files  YYYY-MM-DD.json.gz  (list of {lat, lng, frp, sensor}) and writes a
sensor-neutral, tiled dataset that the web app consumes.

Method
------
1. COMMON GRID.  Every detection is snapped to a ~1 km equal-area grid (0.01 deg of
   latitude per row; columns per row shrink with cos(lat) so cells keep ~constant area).
2. DEDUPLICATION.  All detections - any sensor, any overpass, any VIIRS satellite - that fall
   in the same cell on the same day collapse into ONE record: a "fire-active cell-day".
   This removes the ~5x over-count caused by VIIRS' 375 m pixels and by three VIIRS satellites
   seeing the same fire.
3. MODIS-EQUIVALENT SENSITIVITY.  MODIS cannot see small fires.  The floor is estimated from
   the data itself (1st percentile of MODIS cell FRP).  A VIIRS-only cell below the floor is
   flagged `small` so the series stays consistent with the MODIS record; the app can still
   show these cells on request (the extra detail VIIRS brings).
4. QC.  A VIIRS satellite-day whose global detection count is < 70 % of its peers' median
   (or MODIS < 50 % of its monthly median) is flagged as a sensor gap, so a satellite outage
   is not mistaken for a lull in burning.

Output (default ./data)
-----------------------
  meta.json                dates, grid definition, floor, QC flags, raw counts, tile index
  tiles/T_<ty>_<tx>.bin.gz 10x10 degree tiles, columnar binary (layout documented below)

Tile layout (little endian, gzip):  b'SFH1' | u32 n | u16 row[n] | u16 col[n] | u16 frp16[n]
                                    | u8 day[n] | u8 flags[n] | u8 nModis[n] | u8 nSnpp[n]
                                    | u8 nN20[n] | u8 nN21[n]
  flags bit0 = `small` (VIIRS-only cell below the MODIS floor)
  day = index into meta.dates;  n* = raw detections in the cell.
  frp16 = cell FRP in MW, two ranges so nothing clips:  v < 32768 -> v/10 MW (0..3276.7);
          v >= 32768 -> (v - 32768) MW (whole MW, up to 32767).

Usage:  python pipeline/harmonize.py [--raw DIR] [--out DIR] [--export-csv FILE.csv.gz]
Requires: numpy
"""
import argparse
import glob
import gzip
import json
import math
import os
import re
import struct
import sys

import numpy as np

STEP = 0.01          # degrees of latitude per grid row (~1.11 km)
NROWS = 18000
TILE_DEG = 10
SENSORS = ["MODIS", "VIIRS_SNPP", "VIIRS_NOAA20", "VIIRS_NOAA21"]
ALIASES = {
    "MODIS": 0, "MODIS_TERRA": 0, "MODIS_AQUA": 0, "TERRA": 0, "AQUA": 0,
    "VIIRS_SNPP": 1, "SNPP": 1, "VIIRS_SUOMINPP": 1, "SUOMI-NPP": 1, "VIIRS_SUOMI-NPP": 1, "VIIRS_SNPP_NRT": 1,
    "VIIRS_NOAA20": 2, "VIIRS_NOAA-20": 2, "NOAA20": 2, "NOAA-20": 2, "J1V": 2, "VIIRS_NOAA20_NRT": 2,
    "VIIRS_NOAA21": 3, "VIIRS_NOAA-21": 3, "NOAA21": 3, "NOAA-21": 3, "J2V": 3, "VIIRS_NOAA21_NRT": 3,
}
VIIRS_GAP_RATIO = 0.70
MODIS_GAP_RATIO = 0.50
COUNT_CAP = 255


def encode_frp(f):
    """MW -> u16. Fine 0.1 MW steps below 3276.8 MW, whole MW above (volcanoes / extreme fires)."""
    f = np.asarray(f, dtype=float)
    fine = np.minimum(np.round(f * 10), 32767)
    coarse = 32768 + np.minimum(np.round(f), 32767)
    return np.where(f < 3276.7, fine, coarse).astype(np.uint16)

# --- grid ---------------------------------------------------------------------------------
_latc = -90 + (np.arange(NROWS) + 0.5) * STEP
# floor(x + 0.5) rather than round(): identical result in every language (no banker's rounding)
NCOLS = np.maximum(1, np.floor(360 * np.cos(np.radians(_latc)) / STEP + 0.5)).astype(np.int64)


def cell_index(lat, lng):
    row = np.clip(np.floor((lat + 90) / STEP).astype(np.int64), 0, NROWS - 1)
    nc = NCOLS[row]
    col = np.clip(np.floor((lng + 180) / 360 * nc).astype(np.int64), 0, nc - 1)
    return row, col


def cell_centroid(row, col):
    lat = -90 + (row + 0.5) * STEP
    lng = -180 + (col + 0.5) * 360.0 / NCOLS[row]
    return lat, lng


def tile_of(row, col):
    lat, lng = cell_centroid(row, col)
    ty = np.clip(np.floor((lat + 90) / TILE_DEG).astype(np.int64), 0, 180 // TILE_DEG - 1)
    tx = np.clip(np.floor((lng + 180) / TILE_DEG).astype(np.int64), 0, 360 // TILE_DEG - 1)
    return ty, tx


# --- input --------------------------------------------------------------------------------
def find_raw_dir(arg):
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.dirname(here)
    candidates = [arg] if arg else [os.path.join(root, "data", "raw"), root]
    for c in candidates:
        if c and glob.glob(os.path.join(c, "????-??-??.json.gz")):
            return c
    sys.exit("No YYYY-MM-DD.json.gz files found (looked in: %s). Use --raw DIR." % ", ".join(map(str, candidates)))


def read_day(path):
    with gzip.open(path, "rt") as fh:
        rows = json.load(fh)
    lat = np.empty(len(rows)); lng = np.empty(len(rows)); frp = np.empty(len(rows))
    sens = np.empty(len(rows), dtype=np.int8)
    for i, p in enumerate(rows):
        lat[i] = p["lat"]; lng[i] = p["lng"]
        v = p.get("frp")
        frp[i] = 0.0 if v is None else v
        name = str(p["sensor"]).upper()
        if name not in ALIASES:
            raise ValueError("%s: unknown sensor name %r - add it to ALIASES" % (path, p["sensor"]))
        sens[i] = ALIASES[name]
    ok = np.isfinite(lat) & np.isfinite(lng) & (np.abs(lat) <= 90) & (np.abs(lng) <= 180)
    dropped = int((~ok).sum())                      # unusable position -> cannot be placed on the grid
    bad_frp = int(((frp < 0) | ~np.isfinite(frp))[ok].sum())
    frp = np.where(np.isfinite(frp) & (frp > 0), frp, 0.0)   # a negative FRP is a failed retrieval, not "no fire":
    return lat[ok], lng[ok], frp[ok], sens[ok], dropped, bad_frp   # keep the hotspot, count its FRP as 0


def aggregate_day(lat, lng, frp, sens):
    """One record per grid cell: raw counts per sensor, MODIS FRP sum, VIIRS FRP (max over satellites)."""
    row, col = cell_index(lat, lng)
    key = (row << 16) | col
    uk, inv = np.unique(key, return_inverse=True)
    idx = inv * 4 + sens
    n = np.bincount(idx, minlength=len(uk) * 4).reshape(-1, 4)
    fs = np.bincount(idx, weights=frp, minlength=len(uk) * 4).reshape(-1, 4)
    fm = fs[:, 0]
    fv = fs[:, 1:].max(axis=1)   # different VIIRS satellites = different overpass times: take max, never add
    return {
        "row": (uk >> 16).astype(np.int64), "col": (uk & 0xFFFF).astype(np.int64),
        "n": n, "fm": fm, "fv": fv, "frp": np.maximum(fm, fv),
    }


# --- main ---------------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--raw", help="folder with YYYY-MM-DD.json.gz (default: data/raw, else repo root)")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data"))
    ap.add_argument("--export-csv", help="also write the full harmonized dataset as CSV (.gz if the name ends in .gz)")
    args = ap.parse_args()

    raw_dir = find_raw_dir(args.raw)
    files = sorted(glob.glob(os.path.join(raw_dir, "????-??-??.json.gz")))
    dates = [re.search(r"(\d{4}-\d{2}-\d{2})\.json\.gz$", f).group(1) for f in files]
    if len(dates) > 255:
        sys.exit("Day index is stored in a u8: at most 255 days per dataset.")
    print("raw: %s  (%d days, %s .. %s)" % (raw_dir, len(dates), dates[0], dates[-1]))

    days, raw_counts, dropped_total, bad_frp_total = [], [], 0, 0
    for f, d in zip(files, dates):
        lat, lng, frp, sens, dropped, bad_frp = read_day(f)
        dropped_total += dropped
        bad_frp_total += bad_frp
        raw_counts.append(np.bincount(sens, minlength=4).tolist())
        days.append(aggregate_day(lat, lng, frp, sens))
        print("  %s  detections %7d -> fire-active cells %7d" % (d, len(lat), len(days[-1]["row"])))
    if dropped_total:
        print("  dropped %d rows without a valid position" % dropped_total)
    if bad_frp_total:
        print("  %d detections had a negative/invalid FRP: kept as hotspots with FRP = 0" % bad_frp_total)

    # MODIS-equivalent floor = 1st percentile of MODIS cell FRP over the whole dataset
    modis_frp = np.concatenate([d["fm"][d["n"][:, 0] > 0] for d in days])
    floor = round(float(np.percentile(modis_frp, 1)), 1) if len(modis_frp) else 0.0
    print("MODIS detection floor (p1 of MODIS cell FRP): %.1f MW" % floor)

    # QC: satellite gaps
    raw = np.array(raw_counts)                       # days x 4
    qc = []
    modis_med = float(np.median(raw[:, 0])) if len(raw) else 0
    for i, d in enumerate(dates):
        flagged = []
        if modis_med and raw[i, 0] < MODIS_GAP_RATIO * modis_med:
            flagged.append({"sensor": SENSORS[0], "detections": int(raw[i, 0]), "expected": int(modis_med)})
        for s in (1, 2, 3):
            peers = [raw[i, p] for p in (1, 2, 3) if p != s]
            ref = float(np.median(peers))
            if ref > 1000 and raw[i, s] < VIIRS_GAP_RATIO * ref:
                flagged.append({"sensor": SENSORS[s], "detections": int(raw[i, s]), "expected": int(ref)})
        qc.append(flagged)
        if flagged:
            print("  QC gap %s: %s" % (d, "; ".join("%s %d (expected ~%d)" % (g["sensor"], g["detections"], g["expected"]) for g in flagged)))

    # Build tiles
    clipped_n = 0
    parts = {}
    for di, d in enumerate(days):
        n = d["n"]
        small = ((n[:, 0] == 0) & (d["fv"] < floor)).astype(np.uint8)
        clipped_n += int((n > COUNT_CAP).sum())
        ty, tx = tile_of(d["row"], d["col"])
        tkey = ty * 100 + tx
        for tk in np.unique(tkey):
            m = tkey == tk
            parts.setdefault(int(tk), []).append((
                d["row"][m].astype(np.uint16), d["col"][m].astype(np.uint16),
                encode_frp(d["frp"][m]),
                np.full(int(m.sum()), di, np.uint8), small[m],
                np.minimum(n[m], COUNT_CAP).astype(np.uint8),
            ))
    if clipped_n:
        print("WARNING clipped %d per-cell detection counts at %d" % (clipped_n, COUNT_CAP))

    os.makedirs(os.path.join(args.out, "tiles"), exist_ok=True)
    for old in glob.glob(os.path.join(args.out, "tiles", "T_*.bin.gz")):
        os.remove(old)
    tiles, total_records, total_bytes, total_eq = [], 0, 0, 0
    for tk in sorted(parts):
        ty, tx = divmod(tk, 100)
        row = np.concatenate([p[0] for p in parts[tk]]); col = np.concatenate([p[1] for p in parts[tk]])
        frp = np.concatenate([p[2] for p in parts[tk]]); day = np.concatenate([p[3] for p in parts[tk]])
        flg = np.concatenate([p[4] for p in parts[tk]]); cnt = np.concatenate([p[5] for p in parts[tk]])
        order = np.lexsort((day, col, row))          # cell-major: neighbouring values compress well
        row, col, frp, day, flg, cnt = row[order], col[order], frp[order], day[order], flg[order], cnt[order]
        n = len(row)
        blob = (b"SFH1" + struct.pack("<I", n) + row.astype("<u2").tobytes() + col.astype("<u2").tobytes()
                + frp.astype("<u2").tobytes() + day.tobytes() + flg.tobytes()
                + b"".join(np.ascontiguousarray(cnt[:, k]).tobytes() for k in range(4)))
        name = "T_%d_%d.bin.gz" % (ty, tx)
        with open(os.path.join(args.out, "tiles", name), "wb") as fh:
            fh.write(gzip.compress(blob, 9, mtime=0))
        size = os.path.getsize(os.path.join(args.out, "tiles", name))
        tiles.append({"ty": ty, "tx": tx, "file": "tiles/" + name, "n": n, "bytes": size})
        total_records += n; total_bytes += size; total_eq += int((flg == 0).sum())

    meta = {
        "version": 1,
        "dates": dates,
        "grid": {"step_deg": STEP, "rows": NROWS, "ncols": NCOLS.tolist(), "tile_deg": TILE_DEG},
        "invalid_frp_detections": bad_frp_total,
        "sensors": SENSORS,
        "modis_floor_mw": floor,
        "qc": {"viirs_gap_ratio": VIIRS_GAP_RATIO, "modis_gap_ratio": MODIS_GAP_RATIO,
               "days": [{"date": d, "gaps": g} for d, g in zip(dates, qc)]},
        "raw_detections": {"per_day": [dict(zip(SENSORS, r)) for r in raw_counts],
                           "total": dict(zip(SENSORS, raw.sum(axis=0).astype(int).tolist()))},
        "cell_days": {"total": total_records, "modis_equivalent": total_eq},
        "tiles": tiles,
    }
    with open(os.path.join(args.out, "meta.json"), "w") as fh:
        json.dump(meta, fh, separators=(",", ":"))
    print("wrote %d tiles, %d fire-active cell-days, %.1f MB (raw detections: %d)" %
          (len(tiles), total_records, total_bytes / 1e6, int(raw.sum())))

    if args.export_csv:
        opener = gzip.open if args.export_csv.endswith(".gz") else open
        with opener(args.export_csv, "wt") as fh:
            fh.write("date,latitude,longitude,frp_mw,n_modis,n_viirs_snpp,n_viirs_noaa20,n_viirs_noaa21,modis_equivalent\n")
            for di, d in enumerate(days):
                lat, lng = cell_centroid(d["row"], d["col"])
                small = (d["n"][:, 0] == 0) & (d["fv"] < floor)
                for i in range(len(lat)):
                    n = d["n"][i]
                    fh.write("%s,%.4f,%.4f,%.1f,%d,%d,%d,%d,%d\n" % (dates[di], lat[i], lng[i], d["frp"][i], n[0], n[1], n[2], n[3], 0 if small[i] else 1))
        print("wrote", args.export_csv)


if __name__ == "__main__":
    main()
