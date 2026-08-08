#!/usr/bin/env python3
"""
Geocode condo projects into the condo-research SQLite DB.

Strategy:
1. Reuse trusted coordinates from the EdgeProp condo-value-finder dataset when
   names match.
2. For remaining projects, query OneMap with conservative exact/fuzzy matching.
3. Store match status/confidence so reruns are resumable and low-confidence
   projects can be reviewed instead of silently guessed.

Usage:
  python3 scripts/geocode-condos.py --limit 50 --dry-run
  python3 scripts/geocode-condos.py
  python3 scripts/geocode-condos.py --retry-unmatched --sleep 0.25
"""

import argparse
import difflib
import json
import math
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DB = ROOT / "condo.db"
DEFAULT_VALUE_DATA = ROOT.parent / "condo-value-finder" / "condo-data.json"
DEFAULT_EXPORT = ROOT / "public" / "condo-geocodes.json"
ONEMAP_URL = "https://www.onemap.gov.sg/api/common/elastic/search"

# Known source-data aliases/typos that OneMap indexes under a different name.
GEOCODE_ALIASES = {
    "RIVERSALLS": ["RIVERSAILS"],
    "TREASURES AT TAMPINES": ["TREASURE AT TAMPINES"],
    "PULLMAN RESIDENCES NEWTON": ["PULLMAN RESIDENCES"],
    "NINETEEN SHELFORD ROAD": ["19 SHELFORD ROAD"],
    "SKYLINE 360 @ SAINT THOMAS WALK": ["SKYLINE 360"],
    "WATTEN ESTATE CONDOMINIUM": ["WATTEN ESTATE"],
    "THE RISE @ OXLEY - RESIDENCES": ["THE RISE @ OXLEY"],
}

NUMBER_WORDS = {
    "ONE": "1", "TWO": "2", "THREE": "3", "FOUR": "4", "FIVE": "5",
    "SIX": "6", "SEVEN": "7", "EIGHT": "8", "NINE": "9", "TEN": "10",
    "ELEVEN": "11", "TWELVE": "12", "THIRTEEN": "13", "FOURTEEN": "14",
    "FIFTEEN": "15", "SIXTEEN": "16", "SEVENTEEN": "17", "EIGHTEEN": "18",
    "NINETEEN": "19", "TWENTY": "20",
}

SCHEMA_COLUMNS = {
    "address": "TEXT",
    "postal": "TEXT",
    "lat": "REAL",
    "lng": "REAL",
    "geocode_status": "TEXT",
    "geocode_source": "TEXT",
    "geocode_confidence": "INTEGER",
    "geocode_query": "TEXT",
    "geocoded_at": "TEXT",
}


def now_utc():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def ensure_schema(con):
    existing = {row[1] for row in con.execute("PRAGMA table_info(condos)")}
    for name, col_type in SCHEMA_COLUMNS.items():
        if name not in existing:
            con.execute(f"ALTER TABLE condos ADD COLUMN {name} {col_type}")
    con.execute("CREATE INDEX IF NOT EXISTS idx_condos_coords ON condos(lat, lng)")
    con.commit()


def norm_text(value):
    value = (value or "").lower().replace("&", " and ").replace("@", " at ")
    value = re.sub(r"[^a-z0-9]+", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def compact(value):
    return norm_text(value).replace(" ", "")


def without_leading_the(value):
    value = norm_text(value)
    return value[4:] if value.startswith("the ") else value


def token_set(value):
    stop = {"the", "at", "sg", "singapore", "condo", "condominium", "residence", "residences"}
    return {t for t in norm_text(value).split() if t not in stop}


def display_value_name(raw):
    name = raw.get("name")
    if isinstance(name, dict):
        return (name.get("display") or name.get("name") or "").strip()
    return str(name or "").strip()


def value_district(raw):
    m = re.search(r"D\d{1,2}", raw.get("district") or "")
    if not m:
        return None
    return "D" + m.group(0)[1:].zfill(2)


def load_value_geocodes(path):
    if not path.exists():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    condos = data.get("condos", data if isinstance(data, list) else [])
    out = {}
    for raw in condos:
        name = display_value_name(raw)
        lat, lng = raw.get("lat"), raw.get("lon", raw.get("lng"))
        if not name or lat is None or lng is None:
            continue
        key = norm_text(name)
        item = {
            "name": name,
            "lat": float(lat),
            "lng": float(lng),
            "district": value_district(raw),
            "source": "edgeprop",
        }
        current = out.get(key)
        # Prefer a same-district match later; otherwise keep the first.
        if current is None:
            out[key] = item
    return out


def import_edgeprop_matches(con, value_by_name, dry_run=False):
    rows = con.execute(
        "SELECT id, name, district, lat, lng FROM condos WHERE lat IS NULL OR lng IS NULL"
    ).fetchall()
    matched = 0

    for row in rows:
        item = value_by_name.get(norm_text(row["name"]))
        if not item:
            continue
        # If EdgeProp has district info and it disagrees, leave for OneMap.
        if item.get("district") and row["district"] and item["district"] != row["district"]:
            continue
        matched += 1
        if not dry_run:
            con.execute(
                """
                UPDATE condos
                SET lat = ?, lng = ?, geocode_status = 'matched',
                    geocode_source = 'edgeprop', geocode_confidence = 100,
                    geocode_query = NULL, geocoded_at = ?
                WHERE id = ?
                """,
                (item["lat"], item["lng"], now_utc(), row["id"]),
            )
    if not dry_run:
        con.commit()
    return matched


def onemap_search(query, retries=3):
    params = {
        "searchVal": query,
        "returnGeom": "Y",
        "getAddrDetails": "Y",
        "pageNum": "1",
    }
    url = ONEMAP_URL + "?" + urllib.parse.urlencode(params)
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "sgcondo-geocoder/1.0"})
            with urllib.request.urlopen(req, timeout=8) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            results = []
            for r in data.get("results", []) or []:
                try:
                    r["_lat"] = float(r.get("LATITUDE"))
                    r["_lng"] = float(r.get("LONGITUDE"))
                except (TypeError, ValueError):
                    continue
                results.append(r)
            return results
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and attempt < retries - 1:
                retry_after = e.headers.get("Retry-After") if e.headers else None
                delay = float(retry_after) if retry_after else 1.5 * (attempt + 1)
                time.sleep(delay)
                continue
            raise
        except Exception:
            if attempt < retries - 1:
                time.sleep(0.8 * (attempt + 1))
                continue
            raise
    return []


def result_names(result):
    return [
        result.get("SEARCHVAL") or "",
        result.get("BUILDING") or "",
    ]


def match_score(name, result):
    target = compact(name)
    target_no_the = compact(without_leading_the(name))
    best = 0
    for raw in result_names(result):
        candidate = compact(raw)
        if not candidate:
            continue
        candidate_no_the = compact(without_leading_the(raw))
        if candidate == target or candidate_no_the == target_no_the:
            best = max(best, 100)
            continue
        if len(target) >= 5 and (target in candidate or candidate in target):
            best = max(best, 88)
            continue
        ratio = difflib.SequenceMatcher(None, target_no_the, candidate_no_the).ratio()
        if ratio >= 0.90:
            best = max(best, 84)
        elif ratio >= 0.84:
            best = max(best, 74)
        else:
            want = token_set(name)
            have = token_set(raw)
            if want and have:
                overlap = len(want & have) / len(want)
                if overlap >= 0.90:
                    best = max(best, 72)
    return best


def haversine_km(lat1, lng1, lat2, lng2):
    r = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = math.sin(dlat / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlng / 2) ** 2
    return 2 * r * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def build_clusters(results, threshold_km=0.9):
    clusters = []
    for result in sorted(results, key=lambda r: r["_score"], reverse=True):
        placed = False
        for cluster in clusters:
            if any(haversine_km(result["_lat"], result["_lng"], r["_lat"], r["_lng"]) <= threshold_km for r in cluster):
                cluster.append(result)
                placed = True
                break
        if not placed:
            clusters.append([result])
    return clusters


def area_bonus(area, cluster):
    area_tokens = token_set(area)
    if not area_tokens:
        return 0
    haystack = " ".join(
        " ".join([r.get("ROAD_NAME") or "", r.get("BUILDING") or "", r.get("SEARCHVAL") or ""])
        for r in cluster
    ).lower()
    return min(6, sum(2 for t in area_tokens if t in haystack))


def choose_result_cluster(name, area, results):
    scored = []
    for result in results:
        score = match_score(name, result)
        if score >= 72:
            result = dict(result)
            result["_score"] = score
            scored.append(result)
    if not scored:
        return None, "unmatched", 0

    clusters = build_clusters(scored)
    ranked = sorted(
        clusters,
        key=lambda c: (max(r["_score"] for r in c), min(len(c), 8), area_bonus(area, c)),
        reverse=True,
    )
    best = ranked[0]
    best_score = max(r["_score"] for r in best) + area_bonus(area, best)
    if len(ranked) > 1:
        second = ranked[1]
        second_score = max(r["_score"] for r in second) + area_bonus(area, second)
        b = best[0]
        s = second[0]
        far_apart = haversine_km(b["_lat"], b["_lng"], s["_lat"], s["_lng"]) > 1.5
        if far_apart and best_score - second_score < 5:
            return None, "ambiguous", int(best_score)

    confidence = min(99, max(r["_score"] for r in best) - (1 if len(best) > 1 else 0) + area_bonus(area, best))
    status = "matched" if confidence >= 82 else "review"
    return best, status, int(confidence)


def query_variants(condo):
    name = condo["name"].strip()
    variants = [f"{alias} Singapore" for alias in GEOCODE_ALIASES.get(name.upper(), [])]
    variants.append(f"{name} Singapore")
    punctuationless = re.sub(r"[^A-Za-z0-9 ]+", "", name)
    if punctuationless != name:
        variants.append(f"{punctuationless} Singapore")
    number_variant = " ".join(NUMBER_WORDS.get(part.upper(), part) for part in punctuationless.split())
    if number_variant != punctuationless:
        variants.append(f"{number_variant} Singapore")
    if " - " in name:
        variants.append(f"{name.split(' - ', 1)[0]} Singapore")
    if name.upper().endswith(" CONDOMINIUM"):
        variants.append(f"{name[:-12]} Singapore")
    if "@" in name:
        variants.append(f"{name.replace('@', '')} Singapore")
    if name.upper().startswith("THE "):
        variants.append(f"{name[4:]} Singapore")
    first_area = (condo["area"] or "").split("/")[0].strip()
    if first_area:
        variants.append(f"{name} {first_area} Singapore")
    variants.append(f"{name} condominium Singapore")

    seen = set()
    out = []
    for q in variants:
        q = re.sub(r"\s+", " ", q).strip()
        if q.lower() not in seen:
            seen.add(q.lower())
            out.append(q)
    return out


def summarize_cluster(cluster):
    first = cluster[0]
    lat = sum(r["_lat"] for r in cluster) / len(cluster)
    lng = sum(r["_lng"] for r in cluster) / len(cluster)
    blk = (first.get("BLK_NO") or "").strip()
    road = (first.get("ROAD_NAME") or "").strip()
    postal = (first.get("POSTAL") or "").strip() or None
    address_parts = [blk, road]
    address = " ".join(p for p in address_parts if p)
    if postal:
        address = f"{address} Singapore {postal}" if address else f"Singapore {postal}"
    return {
        "address": address or None,
        "postal": postal,
        "lat": round(lat, 7),
        "lng": round(lng, 7),
        "result_count": len(cluster),
        "searchval": first.get("SEARCHVAL"),
        "building": first.get("BUILDING"),
    }


def geocode_condo_remote(condo, sleep):
    """Network-only geocode work; safe to run in worker threads."""
    final = None
    final_query = None
    final_status = "unmatched"
    final_confidence = 0
    error = None

    for query in query_variants(condo):
        try:
            results = onemap_search(query)
        except Exception as e:
            error = str(e)
            break
        cluster, status, confidence = choose_result_cluster(condo["name"], condo["area"], results)
        final_query = query
        if cluster:
            final = summarize_cluster(cluster)
            final_status = status
            final_confidence = confidence
            if status == "matched":
                break
        else:
            time.sleep(min(sleep, 0.05))

    time.sleep(sleep)
    return {
        "status": final_status,
        "confidence": final_confidence,
        "query": final_query,
        "geo": final,
        "error": error,
    }


def update_geocode(con, condo_id, status, confidence, query, geo=None, source="onemap"):
    con.execute(
        """
        UPDATE condos
        SET address = ?, postal = ?, lat = ?, lng = ?,
            geocode_status = ?, geocode_source = ?, geocode_confidence = ?,
            geocode_query = ?, geocoded_at = ?
        WHERE id = ?
        """,
        (
            (geo or {}).get("address"),
            (geo or {}).get("postal"),
            (geo or {}).get("lat"),
            (geo or {}).get("lng"),
            status,
            source if status == "matched" else source,
            confidence,
            query,
            now_utc(),
            condo_id,
        ),
    )


def export_geocodes(con, output):
    rows = con.execute(
        """
        SELECT id, name, district, address, postal, lat, lng,
               geocode_status, geocode_source, geocode_confidence, geocode_query, geocoded_at
        FROM condos
        WHERE lat IS NOT NULL AND lng IS NOT NULL
        ORDER BY id
        """
    ).fetchall()
    output.parent.mkdir(parents=True, exist_ok=True)
    payload = [dict(row) for row in rows]
    output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return len(payload)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--value-data", type=Path, default=DEFAULT_VALUE_DATA)
    parser.add_argument("--export-json", type=Path, default=DEFAULT_EXPORT)
    parser.add_argument("--limit", type=int, default=0, help="Max OneMap records to process (0 = all)")
    parser.add_argument("--sleep", type=float, default=0.22)
    parser.add_argument("--workers", type=int, default=1)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--retry-unmatched", action="store_true")
    args = parser.parse_args()

    con = sqlite3.connect(str(args.db), timeout=30)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA busy_timeout = 30000")
    ensure_schema(con)

    value_by_name = load_value_geocodes(args.value_data)
    edgeprop_matched = import_edgeprop_matches(con, value_by_name, dry_run=args.dry_run)
    print(f"EdgeProp coordinate matches: {edgeprop_matched}")

    where = "1=1" if args.force else "(lat IS NULL OR lng IS NULL)"
    if not args.retry_unmatched and not args.force:
        where += " AND COALESCE(geocode_status, '') NOT IN ('unmatched', 'ambiguous', 'review')"
    rows = con.execute(
        f"SELECT id, name, district, area FROM condos WHERE {where} ORDER BY id"
    ).fetchall()
    if args.limit:
        rows = rows[: args.limit]

    print(f"OneMap records to process: {len(rows)} (workers={max(1, args.workers)})")
    stats = {"matched": 0, "review": 0, "ambiguous": 0, "unmatched": 0, "errors": 0}

    def record_result(idx, condo, result):
        status = result["status"]
        if result.get("error"):
            status = "error"
        stats[status] = stats.get(status, 0) + 1
        if result.get("error"):
            stats["errors"] += 1
            print(f"[{idx}/{len(rows)}] ERROR {condo['name']}: {result['error']}", flush=True)

        if args.dry_run:
            geo = result.get("geo")
            detail = f" -> {geo['searchval']} / {geo['address']}" if geo else ""
            print(f"[{idx}/{len(rows)}] {status.upper():9} {result['confidence']:3} {condo['name']}{detail}", flush=True)
        else:
            update_geocode(con, condo["id"], status, result["confidence"], result.get("query"), result.get("geo"))
            if idx % 25 == 0:
                con.commit()
                print(
                    f"Progress {idx}/{len(rows)}: matched={stats.get('matched', 0)} "
                    f"review={stats.get('review', 0)} ambiguous={stats.get('ambiguous', 0)} "
                    f"unmatched={stats.get('unmatched', 0)} errors={stats['errors']}",
                    flush=True,
                )

    if args.workers <= 1:
        for idx, condo in enumerate(rows, 1):
            record_result(idx, condo, geocode_condo_remote(condo, args.sleep))
    else:
        with ThreadPoolExecutor(max_workers=args.workers) as executor:
            futures = {
                executor.submit(geocode_condo_remote, dict(condo), args.sleep): condo
                for condo in rows
            }
            for idx, future in enumerate(as_completed(futures), 1):
                condo = futures[future]
                try:
                    result = future.result()
                except Exception as e:
                    result = {"status": "unmatched", "confidence": 0, "query": None, "geo": None, "error": str(e)}
                record_result(idx, condo, result)

    if not args.dry_run:
        con.commit()
        exported = export_geocodes(con, args.export_json)
    else:
        exported = 0

    totals = con.execute(
        """
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN lat IS NOT NULL AND lng IS NOT NULL THEN 1 ELSE 0 END) AS geocoded,
          SUM(CASE WHEN geocode_status = 'matched' THEN 1 ELSE 0 END) AS matched,
          SUM(CASE WHEN geocode_status = 'review' THEN 1 ELSE 0 END) AS review,
          SUM(CASE WHEN geocode_status = 'ambiguous' THEN 1 ELSE 0 END) AS ambiguous,
          SUM(CASE WHEN geocode_status = 'unmatched' THEN 1 ELSE 0 END) AS unmatched,
          SUM(CASE WHEN geocode_status = 'error' THEN 1 ELSE 0 END) AS errors
        FROM condos
        """
    ).fetchone()
    print("OneMap stats:", stats)
    print("DB totals:", dict(totals))
    if exported:
        print(f"Exported {exported} geocodes -> {args.export_json}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nInterrupted; committed progress is preserved.", file=sys.stderr)
        sys.exit(130)
