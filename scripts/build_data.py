#!/usr/bin/env python3
"""Build compact GeoJSON, district overlays, summaries, and OG image
for the Nassau enrollment map site. Uses only files under
/workspace/nassau-enrollment and official Census 2024 cartographic
boundaries already on the box. Never invents enrollment figures.
"""
from __future__ import annotations

import csv
import json
import math
import re
import sys
from collections import defaultdict
from pathlib import Path

import shapefile
from shapely.geometry import mapping, shape, box
from shapely.ops import unary_union, transform
from shapely.validation import make_valid
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = Path("/workspace/nassau-enrollment-map")
OUT = ROOT / "public" / "data"
OG = ROOT / "public" / "og.png"
ENROLL = Path("/workspace/nassau-enrollment/clean")
GIS = Path("/tmp/nassau-ld/gis/nys_nassau_election_districts.geojson")
CD_SHP = Path("/tmp/tiger/tl_2025_36_cd119/tl_2025_36_cd119.shp")
SD_SHP = Path("/tmp/tiger/tl_2025_36_sldu/tl_2025_36_sldu.shp")
AD_SHP = Path("/workspace/geo/cb_sldl/cb_2024_36_sldl_500k.shp")

TOWN = {
    "Glen Cove": "GC",
    "Long Beach": "LB",
    "Hempstead": "HEM",
    "North Hempstead": "NH",
    "Oyster Bay": "OB",
}
TOWN_NAME = {
    "GC": "City of Glen Cove",
    "LB": "City of Long Beach",
    "HEM": "Town of Hempstead",
    "NH": "Town of North Hempstead",
    "OB": "Town of Oyster Bay",
}
GIS_NAME_RE = re.compile(
    r"^(Glen Cove|Long Beach|Hempstead|North Hempstead|Oyster Bay)\s+AD\s+(\d+)\s+ED\s+(\d+)$"
)
PARTIES = ("DEM", "REP", "CON", "WOR", "OTH", "BLANK", "TOTAL")
INT_KEYS = PARTIES + ("OTHER", "DEM_REP_MARGIN")

# Fluorescent palette (RGB)
DEM = (61, 126, 255)       # neon blue
REP = (255, 45, 106)       # hot pink
BLANK = (200, 255, 0)      # neon yellow-green
INK = (244, 244, 240)
MUTED = (140, 140, 148)


def i(v):
    return int(v) if v not in (None, "") else 0


def f(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def load_rows(path):
    with open(path, newline="", encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def load_enrollment():
    """Return {ed_id: {active, inactive, total}} with int fields."""
    out = {}
    for row in load_rows(ENROLL / "nassau_enrollment_by_election_district.csv"):
        ed = row["ELECTION_DIST"]
        rec = out.setdefault(
            ed,
            {
                "town": row["TOWN_ABBR"],
                "town_name": row["TOWN"],
                "ad": i(row["ASSEMBLY_DISTRICT"]),
                "edn": i(row["ELECTION_DISTRICT"]),
                "imputed": False,
            },
        )
        status = row["STATUS"].lower()
        rec[status] = {k.lower(): i(row[k]) for k in PARTIES}
        rec[status]["other"] = i(row["OTHER"])
        rec[status]["margin"] = i(row["DEM_REP_MARGIN"])
        if row.get("INACTIVE_ROW_IMPUTED", "") in ("True", "true", "1"):
            rec["imputed"] = True
    assert len(out) == 1085, len(out)
    return out


def load_ld():
    out = {}
    for row in load_rows(ENROLL / "nassau_ed_to_legislative_district.csv"):
        ld = row["LEGISLATIVE_DISTRICT"]
        out[row["ELECTION_DIST"]] = {
            "ld": None if ld in ("", "UNASSIGNED", "0") else i(ld),
            "method": row["ASSIGN_METHOD"],
            "split": row["SPLIT_ED"] in ("True", "true", "1"),
            "note": row.get("ASSIGN_NOTE") or "",
            "area_frac": f(row.get("PRIMARY_AREA_FRACTION")),
        }
    return out


def official_tables():
    def subset(path, extra_ok=None):
        rows = []
        for row in load_rows(path):
            if row["STATUS"] != "Total":
                continue
            if "COUNTY" in row and row["COUNTY"] not in ("Nassau",):
                continue
            if "SCOPE" in row and row["SCOPE"] not in ("County portion", "County", ""):
                # town/county files have no SCOPE; legislative has no SCOPE
                if path.name.endswith("town.csv") or "legislative" in path.name:
                    pass
                else:
                    continue
            rec = {
                "id": row.get("DISTRICT") or row.get("TOWN_ABBR"),
                "name": row.get("TOWN") or None,
                "legislator": row.get("LEGISLATOR") or None,
                "nassau_only": (row.get("NASSAU_ONLY") in ("True", "true", "1"))
                if "NASSAU_ONLY" in row
                else True,
                "counties": row.get("DISTRICT_COUNTIES") or "Nassau",
                "dem": i(row["DEM"]),
                "rep": i(row["REP"]),
                "con": i(row["CON"]),
                "wor": i(row["WOR"]),
                "oth": i(row["OTH"]),
                "blank": i(row["BLANK"]),
                "other": i(row["OTHER"]),
                "total": i(row["TOTAL"]),
                "margin": i(row["DEM_REP_MARGIN"]),
                "dem_share": f(row["DEM_SHARE"]),
                "rep_share": f(row["REP_SHARE"]),
                "blank_share": f(row["BLANK_SHARE"]),
            }
            if "ED_COUNT" in row:
                rec["eds"] = i(row["ED_COUNT"])
                rec["split_eds"] = i(row.get("SPLIT_ED_COUNT") or 0)
            rows.append(rec)
        return rows

    county = {}
    for row in load_rows(ENROLL / "nassau_enrollment_by_county.csv"):
        county[row["STATUS"].lower()] = {k.lower(): i(row[k]) for k in PARTIES}
        county[row["STATUS"].lower()]["other"] = i(row["OTHER"])
        county[row["STATUS"].lower()]["margin"] = i(row["DEM_REP_MARGIN"])
        county[row["STATUS"].lower()]["dem_share"] = f(row["DEM_SHARE"])
        county[row["STATUS"].lower()]["rep_share"] = f(row["REP_SHARE"])
        county[row["STATUS"].lower()]["blank_share"] = f(row["BLANK_SHARE"])
    return {
        "as_of": "2026-11-01",
        "county": county,
        "cd": subset(ENROLL / "nassau_enrollment_by_congressional_district.csv"),
        "sd": subset(ENROLL / "nassau_enrollment_by_senate_district.csv"),
        "ad": subset(ENROLL / "nassau_enrollment_by_assembly_district.csv"),
        "ld": subset(ENROLL / "nassau_enrollment_by_legislative_district.csv"),
        "town": subset(ENROLL / "nassau_enrollment_by_town.csv"),
    }


def shp_features(path, keep):
    """Load shapefile features as (id:int, shapely geom) for records passing keep(dict)."""
    r = shapefile.Reader(path)
    keys = [f[0] for f in r.fields[1:]]
    out = []
    for rec, shp in zip(r.iterRecords(), r.iterShapes()):
        d = dict(zip(keys, rec))
        if not keep(d):
            continue
        geom = shape(shp.__geo_interface__)
        if not geom.is_valid:
            geom = make_valid(geom)
        out.append((d, geom))
    return out


def assign_district(geom, districts):
    """Largest-area overlap. Returns (id, share, second_share) or (None,0,0)."""
    if geom.is_empty:
        return None, 0.0, 0.0
    area = geom.area
    if area <= 0:
        return None, 0.0, 0.0
    scores = []
    gbox = geom.bounds
    for did, dg in districts:
        db = dg.bounds
        if gbox[2] < db[0] or gbox[0] > db[2] or gbox[3] < db[1] or gbox[1] > db[3]:
            continue
        try:
            inter = geom.intersection(dg)
        except Exception:
            try:
                inter = geom.buffer(0).intersection(dg.buffer(0))
            except Exception:
                continue
        a = inter.area if not inter.is_empty else 0.0
        if a > 0:
            scores.append((a / area, did))
    scores.sort(reverse=True)
    if not scores:
        return None, 0.0, 0.0
    best, did = scores[0][0], scores[0][1]
    second = scores[1][0] if len(scores) > 1 else 0.0
    return did, best, second


def parse_gis_name(name):
    m = GIS_NAME_RE.match(name)
    if not m:
        raise ValueError(name)
    return f"{TOWN[m.group(1)]} {int(m.group(2)):02d}{int(m.group(3)):03d}"


def quantize(geom, ndigits=6):
    def q(x, y, z=None):
        return (round(x, ndigits), round(y, ndigits))
    return transform(q, geom)


def simplify_geom(geom, tol=0.00012):
    if geom.is_empty:
        return geom
    g = geom
    if not g.is_valid:
        g = make_valid(g)
    try:
        s = g.simplify(tol, preserve_topology=True)
    except Exception:
        s = g
    if s.is_empty or (s.area == 0 and g.area > 0):
        s = g
    return quantize(s)


def feature(geom, props):
    return {"type": "Feature", "properties": props, "geometry": mapping(geom)}


def fc(features):
    return {"type": "FeatureCollection", "features": features}


def write_json(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, separators=(",", ":"), ensure_ascii=False)
    print(f"  wrote {path} {path.stat().st_size:,} bytes")


def pack_ed(ed, rec, ld, cd, sd, has_geom):
    tot = rec["total"]
    act = rec["active"]
    ina = rec.get("inactive") or {k.lower(): 0 for k in PARTIES}
    return {
        "id": ed,
        "t": rec["town"],
        "tn": rec["town_name"],
        "ad": rec["ad"],
        "edn": rec["edn"],
        "cd": cd,
        "sd": sd,
        "ld": ld["ld"] if ld else None,
        "split": bool(ld and ld["split"]),
        "method": (ld or {}).get("method") or "",
        "imputed": rec.get("imputed", False),
        "geom": has_geom,
        "d": tot["dem"],
        "r": tot["rep"],
        "c": tot["con"],
        "w": tot["wor"],
        "o": tot["oth"],
        "b": tot["blank"],
        "tot": tot["total"],
        "othx": tot["other"],
        "m": tot["margin"],
        "da": act["dem"],
        "ra": act["rep"],
        "ca": act["con"],
        "wa": act["wor"],
        "oa": act["oth"],
        "ba": act["blank"],
        "ta": act["total"],
        "di": ina["dem"],
        "ri": ina["rep"],
        "ci": ina["con"],
        "wi": ina["wor"],
        "oi": ina["oth"],
        "bi": ina["blank"],
        "ti": ina["total"],
    }


def choropleth_props(p):
    """Compact properties stored on the map feature."""
    tot = p["tot"] or 0
    ta = p["ta"] or 0
    return {
        "id": p["id"],
        "t": p["t"],
        "ad": p["ad"],
        "edn": p["edn"],
        "cd": p["cd"],
        "sd": p["sd"],
        "ld": p["ld"],
        "split": p["split"],
        "enr": p["geom"] and tot > 0 or (p["tot"] > 0),
        "d": p["d"],
        "r": p["r"],
        "c": p["c"],
        "w": p["w"],
        "o": p["o"],
        "b": p["b"],
        "tot": p["tot"],
        "m": p["m"],
        "ta": p["ta"],
        "ti": p["ti"],
        # precomputed shares for MapLibre expressions
        "ms": (p["m"] / tot) if tot else 0,          # D-R / total
        "ds": (p["d"] / tot) if tot else 0,
        "rs": (p["r"] / tot) if tot else 0,
        "bs": (p["b"] / tot) if tot else 0,
        "is": (p["ti"] / tot) if tot else 0,         # inactive share
    }


def render_og(ed_features, county, path):
    """1200x630 neon-on-black share image from simplified ED polygons."""
    W, H = 1200, 630
    # layout: map on the right ~700px, copy on the left
    mx0, my0, mx1, my1 = 430, 40, 1160, 590
    geoms = []
    values = []
    for ft in ed_features:
        g = shape(ft["geometry"])
        if g.is_empty:
            continue
        geoms.append(g)
        values.append(ft["properties"].get("ms") or 0)
    if not geoms:
        raise SystemExit("no geoms for OG")
    union = unary_union(geoms)
    minx, miny, maxx, maxy = union.bounds
    # pad
    pad = 0.02
    minx -= pad
    maxx += pad
    miny -= pad
    maxy += pad
    # fit preserving aspect, y north-up
    gw, gh = maxx - minx, maxy - miny
    boxw, boxh = mx1 - mx0, my1 - my0
    scale = min(boxw / gw, boxh / gh)
    # center
    ox = mx0 + (boxw - gw * scale) / 2
    oy = my0 + (boxh - gh * scale) / 2

    def xy(x, y):
        return (ox + (x - minx) * scale, oy + (maxy - y) * scale)

    def ring(coords):
        return [xy(x, y) for x, y in coords]

    img = Image.new("RGB", (W, H), (0, 0, 0))
    # glow pass
    glow = Image.new("RGB", (W, H), (0, 0, 0))
    gd = ImageDraw.Draw(glow)
    draw = ImageDraw.Draw(img)

    def fill_for(ms):
        # diverging neon: pink (R) <- 0 -> blue (D)
        t = max(-0.45, min(0.45, ms)) / 0.45  # -1..1
        if t >= 0:
            # toward DEM blue
            return tuple(int(255 + (c - 255) * t) for c in DEM) if False else (
                int(255 * (1 - t) + DEM[0] * t),
                int(40 * (1 - t) + DEM[1] * t),
                int(80 * (1 - t) + DEM[2] * t),
            )
        t = -t
        return (
            int(255 * (1 - t) + REP[0] * t),
            int(40 * (1 - t) + REP[1] * t),
            int(80 * (1 - t) + REP[2] * t),
        )

    def draw_poly(d, geom, fill, outline=None, width=1):
        if geom.geom_type == "Polygon":
            polys = [geom]
        elif geom.geom_type == "MultiPolygon":
            polys = list(geom.geoms)
        else:
            return
        for poly in polys:
            ext = ring(list(poly.exterior.coords))
            holes = [ring(list(h.coords)) for h in poly.interiors]
            if len(ext) >= 3:
                try:
                    d.polygon(ext, fill=fill, outline=outline)
                    for h in holes:
                        if len(h) >= 3:
                            d.polygon(h, fill=(0, 0, 0), outline=outline)
                except Exception:
                    pass

    for g, ms in zip(geoms, values):
        col = fill_for(ms)
        draw_poly(gd, g, col)
        draw_poly(draw, g, col)

    glow = glow.filter(ImageFilter.GaussianBlur(radius=3.5))
    img = Image.blend(glow, img, 0.72)
    draw = ImageDraw.Draw(img)

    def font(name_keys, size):
        # Prefer IBM Plex / Source Serif already on the box
        cands = [
            "/usr/share/fonts/truetype/ibm-plex/IBMPlexSerif-Light.ttf",
            "/usr/share/fonts/truetype/ibm-plex/IBMPlexSerif-Regular.ttf",
            "/usr/share/fonts/truetype/source-serif-pro/SourceSerifPro-Regular.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
            "/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf",
        ]
        if "bold" in name_keys:
            cands = [
                "/usr/share/fonts/truetype/ibm-plex/IBMPlexSerif-Bold.ttf",
                "/usr/share/fonts/truetype/source-serif-pro/SourceSerifPro-Bold.ttf",
                "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf",
            ] + cands
        if "sans" in name_keys:
            cands = [
                "/usr/share/fonts/truetype/ibm-plex/IBMPlexSans-Regular.ttf",
                "/usr/share/fonts/truetype/ibm-plex/IBMPlexSans-Light.ttf",
                "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            ] + cands
        if "sansbold" in name_keys:
            cands = [
                "/usr/share/fonts/truetype/ibm-plex/IBMPlexSans-Bold.ttf",
                "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
            ] + cands
        if "mono" in name_keys:
            cands = [
                "/usr/share/fonts/truetype/ibm-plex/IBMPlexMono-Regular.ttf",
                "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
            ] + cands
        for c in cands:
            if Path(c).exists():
                return ImageFont.truetype(c, size)
        return ImageFont.load_default()

    display = font(("serif",), 64)
    display_sm = font(("serif",), 36)
    sans = font(("sans",), 20)
    sans_sm = font(("sans",), 16)
    sans_b = font(("sansbold",), 28)
    mono = font(("mono",), 14)

    # left copy
    x = 48
    draw.text((x, 48), "WHO RUNS NY", font=mono, fill=BLANK)
    draw.text((x, 88), "Nassau County", font=display, fill=INK)
    draw.text((x, 158), "party enrollment", font=display_sm, fill=INK)

    tot = county["total"]
    stats = [
        (f"{tot['total']:,}", "registered voters", INK),
        (f"{tot['dem']:,}", "Democratic", DEM),
        (f"{tot['blank']:,}", "blank / unaffiliated", BLANK),
        (f"{tot['rep']:,}", "Republican", REP),
    ]
    y = 230
    for num, label, col in stats:
        draw.text((x, y), num, font=sans_b, fill=col)
        draw.text((x, y + 32), label, font=sans_sm, fill=MUTED)
        y += 70

    draw.text((x, 540), "As of November 1, 2026  ·  NYS Board of Elections", font=sans_sm, fill=MUTED)
    draw.text((x, 568), "whorunsny.org", font=sans_sm, fill=(180, 180, 188))

    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, "PNG", optimize=True)
    print(f"  wrote {path} {path.stat().st_size:,} bytes")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    print("Loading enrollment…")
    enroll = load_enrollment()
    ldmap = load_ld()
    official = official_tables()

    print("Loading GIS EDs…")
    with open(GIS, encoding="utf-8") as fh:
        raw = json.load(fh)
    gis = {}
    for ft in raw["features"]:
        ed = parse_gis_name(ft["properties"]["Election_District"])
        geom = shape(ft["geometry"])
        if not geom.is_valid:
            geom = make_valid(geom)
        gis[ed] = geom

    print("Loading official CD / SD / AD cartographic boundaries (Census 2024)…")
    nassau_union = unary_union(list(gis.values()))
    nbox = nassau_union.bounds
    pad = 0.15
    clip = box(nbox[0] - pad, nbox[1] - pad, nbox[2] + pad, nbox[3] + pad)

    def ny_cd(d):
        return d.get("STATEFP") == "36" and d.get("CD119FP") not in ("ZZ", "98")

    def intersects_nassau(geom):
        return geom.bounds[2] >= nbox[0] - 0.05 and geom.bounds[0] <= nbox[2] + 0.05 and geom.bounds[3] >= nbox[1] - 0.05 and geom.bounds[1] <= nbox[3] + 0.05

    cds, sds, ads = [], [], []
    for d, g in shp_features(CD_SHP, ny_cd):
        if intersects_nassau(g):
            did = int(d["CD119FP"])
            cds.append((did, g))
    for d, g in shp_features(SD_SHP, lambda d: True):
        if intersects_nassau(g):
            sds.append((int(d["SLDUST"]), g))
    for d, g in shp_features(AD_SHP, lambda d: True):
        if intersects_nassau(g):
            ads.append((int(d["SLDLST"]), g))
    print(f"  candidate districts CD={ [i for i,_ in cds] } SD={[i for i,_ in sds]} AD={[i for i,_ in ads]}")

    print("Assigning CD / SD by largest-area overlap; AD from official ED code…")
    assignments = {}
    ad_mismatch = []
    for ed, geom in gis.items():
        cd, cd_s, cd_2 = assign_district(geom, cds)
        sd, sd_s, sd_2 = assign_district(geom, sds)
        ad_gis, ad_s, ad_2 = assign_district(geom, ads)
        rec = enroll.get(ed)
        ad_official = rec["ad"] if rec else None
        if rec and ad_gis is not None and ad_gis != ad_official:
            ad_mismatch.append((ed, ad_official, ad_gis, ad_s))
        assignments[ed] = {
            "cd": cd,
            "cd_share": cd_s,
            "cd_second": cd_2,
            "sd": sd,
            "sd_share": sd_s,
            "sd_second": sd_2,
            "ad_gis": ad_gis,
        }

    # Pack all enrollment EDs (with and without geometry)
    packed = []
    no_geom = []
    for ed, rec in sorted(enroll.items()):
        a = assignments.get(ed, {})
        packed.append(
            pack_ed(
                ed,
                rec,
                ldmap.get(ed),
                a.get("cd"),
                a.get("sd"),
                has_geom=ed in gis,
            )
        )
        if ed not in gis:
            no_geom.append(ed)

    gis_only = sorted(set(gis) - set(enroll))

    # Validate CD / SD sums vs official (geometry EDs only)
    def rollup(key):
        sums = defaultdict(lambda: {"dem": 0, "rep": 0, "blank": 0, "total": 0, "n": 0, "missing": 0})
        for p in packed:
            k = p[key]
            bucket = "none" if k is None else k
            if not p["geom"]:
                sums[bucket]["missing"] += p["tot"]
                continue
            sums[bucket]["dem"] += p["d"]
            sums[bucket]["rep"] += p["r"]
            sums[bucket]["blank"] += p["b"]
            sums[bucket]["total"] += p["tot"]
            sums[bucket]["n"] += 1
        return {str(k): v for k, v in sums.items()}

    cd_sum, sd_sum, ad_sum = rollup("cd"), rollup("sd"), rollup("ad")

    def compare(official_rows, derived, label):
        report = []
        for row in official_rows:
            oid = str(row["id"])
            d = derived.get(oid, {"total": 0, "dem": 0, "rep": 0, "n": 0, "missing": 0})
            report.append(
                {
                    "district": oid,
                    "official": row["total"],
                    "mapped": d["total"],
                    "diff": d["total"] - row["total"],
                    "mapped_eds": d["n"],
                    "unmapped_voters_assigned_here": d.get("missing", 0),
                }
            )
        print(f"  {label} official vs mapped (EDs with geometry):")
        for r in report:
            print(
                f"    {label} {r['district']}: official {r['official']:,}  mapped {r['mapped']:,}  diff {r['diff']:+,}"
            )
        return report

    cd_cmp = compare(official["cd"], cd_sum, "CD")
    sd_cmp = compare(official["sd"], sd_sum, "SD")
    ad_cmp = compare(official["ad"], ad_sum, "AD")

    # Build map features: enrollment EDs with geometry + GIS-only as no-data
    map_features = []
    town_geoms = defaultdict(list)
    ld_geoms = defaultdict(list)
    cd_ed_geoms = defaultdict(list)
    sd_ed_geoms = defaultdict(list)
    ad_ed_geoms = defaultdict(list)

    for p in packed:
        if not p["geom"]:
            continue
        geom = simplify_geom(gis[p["id"]])
        props = choropleth_props(p)
        map_features.append(feature(geom, props))
        town_geoms[p["t"]].append(gis[p["id"]])
        if p["ld"]:
            ld_geoms[p["ld"]].append(gis[p["id"]])
        if p["cd"]:
            cd_ed_geoms[p["cd"]].append(gis[p["id"]])
        if p["sd"]:
            sd_ed_geoms[p["sd"]].append(gis[p["id"]])
        ad_ed_geoms[p["ad"]].append(gis[p["id"]])

    for ed in gis_only:
        geom = simplify_geom(gis[ed])
        a = assignments[ed]
        # parse town/ad/edn
        m = GIS_NAME_RE.match  # already parsed key
        town = ed.split()[0]
        code = ed.split()[1]
        ad, edn = int(code[:2]), int(code[2:])
        props = {
            "id": ed,
            "t": town,
            "ad": ad,
            "edn": edn,
            "cd": a.get("cd"),
            "sd": a.get("sd"),
            "ld": None,
            "split": False,
            "enr": False,
            "d": 0, "r": 0, "c": 0, "w": 0, "o": 0, "b": 0,
            "tot": 0, "m": 0, "ta": 0, "ti": 0,
            "ms": 0, "ds": 0, "rs": 0, "bs": 0, "is": 0,
        }
        map_features.append(feature(geom, props))

    print(f"  map features: {len(map_features)} (enrolled+geom {sum(1 for p in packed if p['geom'])}, GIS-only {len(gis_only)}, no-geom {len(no_geom)})")
    print(f"  AD code vs Census overlap mismatches: {len(ad_mismatch)}")
    if ad_mismatch[:8]:
        for row in ad_mismatch[:8]:
            print("   ", row)

    # Overlays: official CD/SD/AD clipped to a buffered Nassau envelope,
    # plus dissolved LD and town from assigned/enrollment EDs.
    nassau_clip = nassau_union.buffer(0.004)  # ~400m, covers water gaps

    def clip_official(districts, kind):
        feats = []
        for did, g in districts:
            try:
                c = g.intersection(nassau_clip)
            except Exception:
                c = g.buffer(0).intersection(nassau_clip.buffer(0))
            if c.is_empty:
                continue
            c = simplify_geom(c, tol=0.0002)
            feats.append(feature(c, {"id": did, "kind": kind, "name": f"{kind.upper()} {did}"}))
        return feats

    def dissolve(groups, kind, name_fn):
        feats = []
        for did, geoms in sorted(groups.items(), key=lambda kv: str(kv[0])):
            try:
                u = unary_union(geoms)
            except Exception:
                u = unary_union([make_valid(g) for g in geoms])
            u = simplify_geom(u, tol=0.0002)
            if u.is_empty:
                continue
            feats.append(feature(u, {"id": did, "kind": kind, "name": name_fn(did)}))
        return feats

    overlays = {
        "cd": fc(clip_official(cds, "cd")),
        "sd": fc(clip_official(sds, "sd")),
        "ad": fc(clip_official(ads, "ad")),
        "ld": fc(dissolve(ld_geoms, "ld", lambda i: f"LD {i}")),
        "town": fc(dissolve(town_geoms, "town", lambda t: TOWN_NAME.get(t, t))),
    }

    # Keep only CD 2/3/4, SD 5-9, AD 9-22 in overlays (drop other NY districts
    # that barely kiss the clip buffer).
    def filter_ids(gj, allowed):
        gj["features"] = [ft for ft in gj["features"] if ft["properties"]["id"] in allowed]
        return gj

    overlays["cd"] = filter_ids(overlays["cd"], {2, 3, 4})
    overlays["sd"] = filter_ids(overlays["sd"], {5, 6, 7, 8, 9})
    overlays["ad"] = filter_ids(overlays["ad"], set(range(9, 23)))

    # Bounds from enrolled geometry
    enrolled_union = unary_union([gis[p["id"]] for p in packed if p["geom"]])
    bounds = list(enrolled_union.bounds)  # [w,s,e,n]

    missing_details = []
    for ed in no_geom:
        p = next(x for x in packed if x["id"] == ed)
        missing_details.append(
            {
                "id": ed,
                "town": p["tn"],
                "ad": p["ad"],
                "ld": p["ld"],
                "total": p["tot"],
                "dem": p["d"],
                "rep": p["r"],
                "blank": p["b"],
                "reason": "No polygon in the June 12, 2025 NYS ITS / NYSBOE election-district GIS layer.",
            }
        )

    summaries = {
        "as_of": "2026-11-01",
        "as_of_label": "November 1, 2026",
        "source": "New York State Board of Elections NYSVoter enrollment snapshot",
        "source_urls": {
            "county": "https://elections.ny.gov/enrollment-county",
            "congress": "https://elections.ny.gov/enrollment-congressional-district",
            "senate": "https://elections.ny.gov/enrollment-senate-district",
            "assembly": "https://elections.ny.gov/enrollment-assembly-district",
            "ed": "https://elections.ny.gov/enrollment-election-district",
            "workbooks": "https://elections.ny.gov/system/files/documents/2026/11/",
            "ld_maps": "https://www.nassaucountyny.gov/5764/Current-Legislative-Maps",
            "gis": "https://services6.arcgis.com/EbVsqZ18sv1kVJ3k/arcgis/rest/services/NYS_Elections_Districts_and_Polling_Locations/FeatureServer/4",
        },
        "county": official["county"],
        "cd": official["cd"],
        "sd": official["sd"],
        "ad": official["ad"],
        "ld": official["ld"],
        "town": official["town"],
        "counts": {
            "enrollment_eds": len(enroll),
            "gis_eds": len(gis),
            "mapped_enrolled_eds": sum(1 for p in packed if p["geom"]),
            "eds_without_geometry": len(no_geom),
            "gis_only_eds": len(gis_only),
            "unassigned_ld_eds": sum(1 for p in packed if not p["ld"]),
            "split_eds": sum(1 for p in packed if p["split"]),
            "imputed_inactive_eds": sum(1 for p in packed if p["imputed"]),
        },
        "eds_without_geometry": missing_details,
        "gis_only_eds": gis_only,
        "unassigned_ld_eds": [p["id"] for p in packed if not p["ld"]],
        "split_eds": [
            {"id": p["id"], "ld": p["ld"], "total": p["tot"], "note": (ldmap.get(p["id"]) or {}).get("note")}
            for p in packed
            if p["split"]
        ],
        "imputed_inactive_eds": [p["id"] for p in packed if p["imputed"]],
        "assignment_audit": {
            "cd": cd_cmp,
            "sd": sd_cmp,
            "ad": ad_cmp,
            "ad_code_vs_census_mismatches": [
                {"id": e, "official_ad": a, "census_overlap_ad": g, "overlap": s}
                for e, a, g, s in ad_mismatch
            ],
            "geometry": "June 12, 2025 NYS ITS / NYSBOE election districts (FeatureServer layer 4), WGS84.",
            "cd_sd_ad_boundaries": "U.S. Census Bureau TIGER/Line 2025 (boundaries as of January 1, 2025): 119th Congress (tl_2025_36_cd119) and NY State Senate (tl_2025_36_sldu). CD and SD on each ED are assigned by largest-area overlap with those files. Assembly district on each ED comes from the official NYSVoter ED code, not a spatial join. Overlay lines for CD/SD are those TIGER geometries clipped to Nassau; AD overlay uses Census 2024 cartographic assembly boundaries (1:500,000) clipped to Nassau; LD overlay is dissolved from the Local Law 1 of 2025 ED assignment.",
            "ld_boundaries": "Dissolved from EDs assigned to the Local Law 1 of 2025 county legislative map (official March 13, 2025 PDFs). Not the pre-decree My_Nassau GIS layer.",
        },
        "bounds": bounds,
        "center": [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2],
    }

    write_json(OUT / "eds.geojson", fc(map_features))
    for kind, gj in overlays.items():
        write_json(OUT / f"overlay-{kind}.geojson", gj)
    write_json(OUT / "eds.json", packed)
    write_json(OUT / "summaries.json", summaries)

    print("Rendering Open Graph image…")
    render_og(map_features, official["county"], OG)

    # checksums
    tot = sum(p["tot"] for p in packed)
    dem = sum(p["d"] for p in packed)
    rep = sum(p["r"] for p in packed)
    blank = sum(p["b"] for p in packed)
    official_tot = official["county"]["total"]["total"]
    print(f"Checksum packed vs official: tot {tot} vs {official_tot}, DEM {dem}, REP {rep}, BLANK {blank}")
    if tot != official_tot:
        print("ERROR: packed totals do not match official county file", file=sys.stderr)
        sys.exit(1)
    print("OK")


if __name__ == "__main__":
    main()
