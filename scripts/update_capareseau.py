#!/usr/bin/env python3
"""Met à jour data/postes.json à partir de capareseau.fr.

Capareseau publie, pour chaque région, un fichier JSON des postes (coordonnées
WGS84 + indicateurs S3REnR). Ce script :
  1. lit la page /region/<code> pour trouver la clé du fichier « postes » ;
  2. télécharge /medias/<clé> ;
  3. ne garde que les champs utiles à l'outil et écrit data/postes.json + data/meta.json.

Usage :
  python3 scripts/update_capareseau.py              # téléchargement en ligne
  python3 scripts/update_capareseau.py --from-raw data/raw   # à partir d'extraits r<code>.json déjà compactés
"""
import argparse, datetime, glob, json, os, re, sys, time, urllib.request

BASE = "https://www.capareseau.fr"
REGIONS = {
    "11": "Île-de-France", "24": "Centre-Val de Loire", "27": "Bourgogne-Franche-Comté",
    "28": "Normandie", "32": "Hauts-de-France", "44": "Grand Est", "52": "Pays de la Loire",
    "53": "Bretagne", "75": "Nouvelle-Aquitaine", "76": "Occitanie",
    "84": "Auvergne-Rhône-Alpes", "93": "Provence-Alpes-Côte d'Azur",
}
# Codes Capareseau conservés (voir site/datas/AttributeConfig.json sur capareseau.fr)
KEEP = ["INFO_NA", "INFO_CR", "INFO_FA", "INFO_FAS3R", "INFO_ESS3R", "INFO_MES", "INFO_TX",
        "INFO_QP", "RTE_CDR", "GRD1_CDR", "GRD2_CDR", "GRDHTB_CDR", "GRD1_CTR", "GRD1_FAP",
        "RTE_TVX", "GRD1_TVX", "INFO_SAT", "RTE_PRHTB1", "RTE_PRHTB2"]
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UA = {"User-Agent": "raccord-pv/1.0 (outil de pre-etude; github)"}


def get(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode("utf-8")


def compact(p, region):
    """Même structure que l'extrait fait dans le navigateur."""
    vals = p.get("values") or {}
    v = {k: vals[k] for k in KEEP if k in vals and vals[k] not in ("", None)}
    g1 = (p.get("grd1") or {}).get("name")
    g2 = (p.get("grd2") or {}).get("name")
    return {
        "n": p.get("name"), "c": (p.get("code") or "").strip(),
        "lat": round(float(p["Y"]), 5), "lon": round(float(p["X"]), 5),
        "u": p.get("u_max"), "pj": p.get("project"), "up": p.get("updated"),
        "ht": p.get("htb_type"), "g1": g1, "g2": g2, "r": region, "v": v,
    }


def fetch_region(code):
    html = get(f"{BASE}/region/{code}")
    m = re.search(r"posts_key\s*=\s*'([A-F0-9-]+)'", html)
    if not m:
        raise RuntimeError(f"clé des postes introuvable pour la région {code}")
    data = json.loads(get(f"{BASE}/medias/{m.group(1)}"))
    return [compact(p, code) for p in data if p.get("X") and p.get("Y")]


def build(postes_by_region, source):
    postes = []
    for code in sorted(postes_by_region):
        postes += postes_by_region[code]
    # dates de mise à jour par région (la plus récente indiquée par poste)
    def parse(d):
        try:
            return datetime.datetime.strptime(d, "%d/%m/%Y").date()
        except Exception:
            return None
    regions = {}
    for code, lst in postes_by_region.items():
        dates = [parse(p["up"]) for p in lst if p.get("up")]
        dates = [d for d in dates if d]
        regions[code] = {"nom": REGIONS.get(code, code), "postes": len(lst),
                         "maj_max": max(dates).isoformat() if dates else None}
    meta = {"extraction": datetime.date.today().isoformat(), "source": source,
            "nb_postes": len(postes), "regions": regions}
    os.makedirs(os.path.join(ROOT, "data"), exist_ok=True)
    with open(os.path.join(ROOT, "data", "postes.json"), "w", encoding="utf-8") as f:
        json.dump(postes, f, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(ROOT, "data", "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
    print(f"{len(postes)} postes écrits ({len(postes_by_region)} régions)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--from-raw", help="dossier contenant des r<code>.json déjà compactés")
    a = ap.parse_args()
    out = {}
    if a.from_raw:
        for f in sorted(glob.glob(os.path.join(a.from_raw, "r*.json"))):
            code = os.path.basename(f)[1:-5]
            out[code] = json.load(open(f, encoding="utf-8"))
        build(out, "capareseau.fr (extrait navigateur)")
        return
    errors = []
    for code in REGIONS:
        try:
            out[code] = fetch_region(code)
            print(f"région {code}: {len(out[code])} postes")
        except Exception as e:
            errors.append(f"{code}: {e}")
            print(f"région {code}: ERREUR {e}", file=sys.stderr)
        time.sleep(1)
    if len(out) < len(REGIONS) // 2:
        sys.exit("Trop d'échecs, data/postes.json non modifié :\n" + "\n".join(errors))
    if errors:  # garde les régions précédentes en cas d'échec partiel
        old = json.load(open(os.path.join(ROOT, "data", "postes.json"), encoding="utf-8"))
        for p in old:
            if p["r"] not in out:
                out.setdefault(p["r"], []).append(p)
    build(out, "capareseau.fr")


if __name__ == "__main__":
    main()
