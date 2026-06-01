#!/usr/bin/env python3
"""Deterministic generator for data/prices.json.

Produces ~30 days of representative Québec gas-price history across multiple
brands, regions and fuel grades. Output is stable for a fixed seed so the
committed dataset is reproducible (re-run and diff to verify nothing drifted).

Run:  python3 scripts/gen-prices.py
"""
import json
import math
import os
import random
from datetime import date, timedelta

SEED = 20260601
END_DATE = date(2026, 6, 1)   # inclusive last day (matches project "today")
DAYS = 30

REGIONS = ["Québec City", "Montréal", "Gatineau"]
BRANDS = ["Costco", "Petro-Canada", "Esso", "Shell", "Ultramar", "Couche-Tard"]
FUELS = ["regular", "super", "diesel"]

# Regional base price for REGULAR (cents/L) on the first day.
REGION_BASE = {"Québec City": 161.0, "Montréal": 165.0, "Gatineau": 159.5}
# Per-brand offset vs the regional base (cents/L). Costco cheapest, Ultramar dearest.
BRAND_OFFSET = {
    "Costco": -5.0, "Petro-Canada": -1.0, "Esso": 0.0,
    "Shell": 2.0, "Ultramar": 3.0, "Couche-Tard": 1.0,
}
# Grade premium over regular (cents/L).
FUEL_PREMIUM = {"regular": 0.0, "super": 18.0, "diesel": 9.0}


def round1(x):
    # Round to one decimal; gas prices in QC end in .9 conventionally, but we
    # keep true 1-decimal values so charts/averages are clean.
    return round(x + 1e-9, 1)


def main():
    rng = random.Random(SEED)
    days = [(END_DATE - timedelta(days=DAYS - 1 - i)).isoformat() for i in range(DAYS)]

    series = []
    for region in REGIONS:
        base = REGION_BASE[region]
        for brand in BRANDS:
            for fuel in FUELS:
                offset = BRAND_OFFSET[brand] + FUEL_PREMIUM[fuel]
                # Stable per-series phase so weekly waves don't all align.
                phase = rng.uniform(0, math.pi * 2)
                prices = []
                for i in range(DAYS):
                    # Gentle upward drift over the month (+0..~3.5 c/L).
                    drift = (i / (DAYS - 1)) * 3.5
                    # Weekly cycle: cheaper midweek, dearer on weekends.
                    weekly = 1.6 * math.sin((i / 7.0) * 2 * math.pi + phase)
                    # Small day-to-day noise.
                    noise = rng.uniform(-0.6, 0.6)
                    prices.append(round1(base + offset + drift + weekly + noise))
                series.append({
                    "region": region,
                    "brand": brand,
                    "fuel": fuel,
                    "prices": prices,
                })

    doc = {
        "meta": {
            "currency": "CAD",
            "unit": "cents_per_litre",
            "fuel_default": "regular",
            "range": {"start": days[0], "end": days[-1], "days": DAYS},
            "regions": REGIONS,
            "brands": BRANDS,
            "fuels": FUELS,
            "generator": "scripts/gen-prices.py",
            "seed": SEED,
        },
        "days": days,
        "series": series,
    }

    out_path = os.path.join(os.path.dirname(__file__), "..", "data", "prices.json")
    out_path = os.path.abspath(out_path)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print("wrote %s (%d series × %d days)" % (out_path, len(series), DAYS))


if __name__ == "__main__":
    main()
