#!/usr/bin/env python3
"""Download Austin's food inspection scores and build compact JSON for the site.

Usage:
    python3 pipeline/build.py            # use data/raw.csv if present, else download
    python3 pipeline/build.py --download # always download a fresh copy

Output:
    site/data/restaurants.json  one row per facility, inspections newest first
    site/data/meta.json         source info and data dates
"""
import csv
import json
import sys
import urllib.request
from datetime import date, datetime, timezone
from pathlib import Path

SOURCE_CSV = "https://data.austintexas.gov/api/views/ecmv-9xxi/rows.csv?accessType=DOWNLOAD"
SOURCE_PAGE = "https://data.austintexas.gov/d/ecmv-9xxi"

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw.csv"
OUT = ROOT / "site" / "data"


def download():
    RAW.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(SOURCE_CSV, headers={"User-Agent": "austin-scores-builder"})
    with urllib.request.urlopen(req, timeout=180) as resp:
        RAW.write_bytes(resp.read())


def parse_date(s):
    return datetime.strptime(s.strip(), "%m/%d/%Y").date()


def parse_score(s):
    s = s.strip()
    return int(s) if s.isdigit() else None


def parse_coord(s):
    try:
        return round(float(s), 5)
    except ValueError:
        return None


def build():
    with RAW.open(newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))

    facilities = {}
    seen_inspections = set()
    skipped = 0
    for r in rows:
        fid = r["Facility ID"].strip()
        insp_id = r["InspectionID"].strip()
        if not fid or insp_id in seen_inspections:
            skipped += 1
            continue
        try:
            when = parse_date(r["Inspection Date"])
        except ValueError:
            skipped += 1
            continue
        seen_inspections.add(insp_id)

        fac = facilities.setdefault(fid, {
            "id": fid,
            "name": r["Restaurant Name"].strip(),
            "address": " ".join(r["Address"].split()),
            "zip": r["Zip Code"].strip()[:5],
            "lat": None,
            "lng": None,
            "inspections": [],
        })
        lat, lng = parse_coord(r["lat"]), parse_coord(r["lng"])
        if lat is not None and lng is not None:
            fac["lat"], fac["lng"] = lat, lng
        fac["inspections"].append((
            when.isoformat(),
            parse_score(r["Score"]),
            1 if "follow" in r["Process Description"].lower() else 0,
        ))

    out = []
    for fac in facilities.values():
        fac["inspections"].sort(key=lambda i: i[0], reverse=True)
        # Compact row: [id, name, address, zip, lat, lng, [[date, score, followUp], ...]]
        out.append([fac["id"], fac["name"], fac["address"], fac["zip"],
                    fac["lat"], fac["lng"], [list(i) for i in fac["inspections"]]])
    out.sort(key=lambda f: f[1].lower())

    all_dates = [i[0] for f in out for i in f[6]]
    meta = {
        "source": SOURCE_PAGE,
        "built": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "oldestInspection": min(all_dates),
        "newestInspection": max(all_dates),
        "facilities": len(out),
        "inspections": len(all_dates),
        "skippedRows": skipped,
    }

    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "restaurants.json").write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    (OUT / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    print(json.dumps(meta, indent=2))


if __name__ == "__main__":
    if "--download" in sys.argv or not RAW.exists():
        download()
    build()
