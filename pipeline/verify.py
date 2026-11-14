#!/usr/bin/env python3
"""
Independent check of the harmonized tiles against the raw daily files.

  1. Per day and per sensor, the raw detection counts stored in the tiles must equal the raw files.
  2. Per day, the number of fire-active cells must equal the number of distinct grid cells found with
     a plain-Python set (a different code path from the numpy aggregation in harmonize.py).
  3. Every record must sit inside the tile it is stored in.
  4. Optional:  --bbox S N W E  prints the expected harmonized numbers for a box so the web app's
     figures can be compared against an independent calculation.

Usage: python pipeline/verify.py [--raw DIR] [--data DIR] [--bbox S N W E]
"""
import argparse
import glob
import gzip
import json
import math
import os
import struct
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harmonize as H  # noqa: E402


def decode_frp(v):
    v = v.astype(np.int64)
    return np.where(v < 32768, v / 10.0, (v - 32768).astype(float))


def read_tile(path):
    b = gzip.decompress(open(path, "rb").read())
    assert b[:4] == b"SFH1", path
    n = struct.unpack("<I", b[4:8])[0]
    o = 8
    def take(dt, size):
        nonlocal o
        a = np.frombuffer(b, dtype=dt, count=n, offset=o); o += n * size
        return a
    return {"row": take("<u2", 2).astype(np.int64), "col": take("<u2", 2).astype(np.int64), "frp": decode_frp(take("<u2", 2)),
            "day": take("u1", 1), "flags": take("u1", 1), "n": np.stack([take("u1", 1) for _ in range(4)], axis=1)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw"); ap.add_argument("--data", default=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data"))
    ap.add_argument("--bbox", nargs=4, type=float, metavar=("S", "N", "W", "E"))
    args = ap.parse_args()

    meta = json.load(open(os.path.join(args.data, "meta.json")))
    dates = meta["dates"]
    assert meta["grid"]["ncols"] == H.NCOLS.tolist(), "grid table in meta.json differs from harmonize.py"

    # decode every tile
    cols = {k: [] for k in ("row", "col", "frp", "day", "flags")}; ns = []
    for t in meta["tiles"]:
        d = read_tile(os.path.join(args.data, t["file"]))
        assert len(d["row"]) == t["n"], t["file"]
        ty, tx = H.tile_of(d["row"], d["col"])
        assert (ty == t["ty"]).all() and (tx == t["tx"]).all(), "record outside its tile: " + t["file"]
        for k in cols: cols[k].append(d[k])
        ns.append(d["n"])
    A = {k: np.concatenate(v) for k, v in cols.items()}; N = np.concatenate(ns)
    print("decoded %d records from %d tiles" % (len(A["row"]), len(meta["tiles"])))

    raw_dir = H.find_raw_dir(args.raw)
    ok = True
    box = args.bbox
    for di, d in enumerate(dates):
        rows = json.load(gzip.open(os.path.join(raw_dir, d + ".json.gz"), "rt"))
        counts = [0, 0, 0, 0]; cells = set()
        for p in rows:
            s = H.ALIASES[p["sensor"].upper()]
            counts[s] += 1
            r = min(max(int(math.floor((p["lat"] + 90) / H.STEP)), 0), H.NROWS - 1)
            nc = int(H.NCOLS[r])
            c = min(max(int(math.floor((p["lng"] + 180) / 360 * nc)), 0), nc - 1)
            cells.add((r, c))
        m = A["day"] == di
        got_counts = N[m].sum(axis=0).tolist()
        if got_counts != counts or int(m.sum()) != len(cells):
            ok = False
            print("MISMATCH", d, "raw", counts, len(cells), "tiles", got_counts, int(m.sum()))
    print("per-day raw counts and cell counts:", "ALL MATCH" if ok else "FAILED")

    if box:
        S, Nn, W, E = box
        lat, lng = H.cell_centroid(A["row"], A["col"])
        inside = (lat >= S) & (lat <= Nn) & ((lng >= W) & (lng <= E) if W <= E else ((lng >= W) | (lng <= E)))
        small = (A["flags"] & 1) == 1
        print("\nbbox S=%s N=%s W=%s E=%s  (cell centroid test)" % tuple(box))
        print("date        cells_eq  cells_all  frp_eq_MW  rawM  rawSNPP  rawN20  rawN21")
        for di, d in enumerate(dates):
            m = inside & (A["day"] == di)
            e = m & ~small
            print("%s  %8d  %9d  %9.1f  %5d  %7d  %6d  %6d" % (d, e.sum(), m.sum(), A["frp"][e].sum(), *N[m].sum(axis=0)))
        e = inside & ~small
        print("TOTAL cells_eq %d  cells_all %d" % (e.sum(), inside.sum()))
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
