#!/usr/bin/env python3
"""Données de référence complémentaires de Raccord PV.

  etf     : pour chaque poste Capareseau, dernier « État technique et financier » (ETF)
            du S3REnR publié par RTE qui cite le poste (lien PDF + page).
            -> data/etf.json
  prives  : postes HTB privés (producteurs, industriels) recensés dans OpenStreetMap,
            hors postes RTE et gestionnaires de réseau de distribution.
            -> data/postes-prives.json

Usage : python3 scripts/collect_refs.py [etf] [prives]
"""
import datetime as dt, json, os, re, subprocess, sys, tempfile, urllib.parse, urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import collect_projets as cp  # noqa: E402  (norm, Postes, http, log)

DATA = cp.DATA
log = cp.log

# ------------------------------------------------------------------ ETF S3REnR
RTE = "https://www.rte-france.com/projets/schemas-regionaux-s3renr/raccordement-energies-renouvelables-"
REGION_PAGES = {  # code région Capareseau -> page régionale RTE
    "84": "auvergne-rhone-alpes", "27": "bourgogne-franche-comte", "53": "bretagne", "24": "centre-val-loire",
    "44": "grand-est", "32": "hauts-de-france", "11": "ile-de-france", "28": "normandie",
    "75": "nouvelle-aquitaine", "52": "pays-loire", "93": "paca",
}
A = "https://assets.rte-france.com/prod/public/pdf/web_download/public/"
# Relevé du 28/10/2026 ; complété automatiquement par la lecture des pages régionales quand elles répondent.
KNOWN = [
    ("84", 2025, "Auvergne-Rhône-Alpes", A + "2026-06/2026-06-17-etat-technique-financier-aura-2025.pdf"),
    ("84", 2024, "Auvergne-Rhône-Alpes", A + "2025-06/2025-06-30-etat-technique-financier-aura-2024.pdf"),
    ("27", 2025, "Bourgogne-Franche-Comté", A + "2026-05/2026-05-18-etat-technique-financier-2025-bourgogne-franche-comte.pdf"),
    ("27", 2024, "Bourgogne-Franche-Comté", A + "2025-06/2025-06-24-etat-technique-financier-2024-bourgogne-franche-comte.pdf"),
    ("53", 2025, "Bretagne", A + "2026-05/2026-05-12-etf-bretagne.pdf"),
    ("53", 2024, "Bretagne", A + "2025-08/2025-08-05-etat-technique-financier-2024-bretagne.pdf"),
    ("24", 2025, "Centre-Val de Loire", A + "2026-08/2026-08-27-etat-technique-et-financier-2025-centre-val-de-loire.pdf"),
    ("44", 2025, "Grand Est", A + "2026-05/2026-05-20-etat-technique-financier-grand-est.pdf"),
    ("32", 2025, "Hauts-de-France", A + "2026-04/2026-04-30-etat-technique-financier-hdf-2025.pdf"),
    ("32", 2024, "Hauts-de-France", A + "2025-07/2025-07-03-etat-technique-financier-hdf-2024_0.pdf"),
    ("11", 2025, "Île-de-France", A + "2026-09/2026-09-10-etat-technique-financier-2025-idf.pdf"),
    ("11", 2024, "Île-de-France", A + "2025-06/2025-06-27-etat-technique-et-financier-2024-idf.pdf"),
    ("28", 2025, "Basse-Normandie", A + "2026-09/2026-09-10-etat-technique-financier-2025-bno.pdf"),
    ("28", 2025, "Haute-Normandie", A + "2026-09/2026-09-10-etat-technique-financier-2025-hno.pdf"),
    ("75", 2025, "Nouvelle-Aquitaine", A + "2026-06/2026-06-23-etats-techniques-financiers-2025-s3renr-nouvelle-aquitaine.pdf"),
    ("52", 2025, "Pays de la Loire", A + "2026-05/2026-05-12-etf-pays-de-la-loire.pdf"),
    ("93", 2025, "Provence-Alpes-Côte d'Azur", A + "2026-06/2026-06-22-etats-techniques-financiers-2025-s3renr-paca.pdf"),
    ("93", 2024, "Provence-Alpes-Côte d'Azur", A + "2025-06/2025-06-20-etats-techniques-financiers-2024-s3renr-paca.pdf"),
    ("76", 2025, "Occitanie", "https://assets.rte-france.com/prod/public/2026-05/2026-05-20-etats-techniques-financiers-2025-s3renr-occitanie.pdf"),
    ("76", 2024, "Occitanie", "https://assets.rte-france.com/prod/public/2025-06/2025-06-26-etats-techniques-financiers-2024-s3renr-occitanie.pdf"),
]
REGION_NAMES = {r: n for r, _, n, _ in KNOWN}


def url_date(u):
    m = re.search(r"/(20\d\d)-(\d\d)(?:-(\d\d))?", u)
    return f"{m.group(1)}-{m.group(2)}-{m.group(3) or '01'}" if m else None


def discover():
    """Lit les pages régionales RTE ; renvoie les ETF (PDF) trouvés, sans doublon."""
    out = {(u): (r, y, n, u) for r, y, n, u in KNOWN}
    for code, slug in REGION_PAGES.items():
        try:
            html = cp.http(RTE + slug, timeout=40, tries=2)
        except Exception as e:
            log(f"ETF : page {slug} illisible ({e}) ; liste connue utilisée")
            continue
        for m in re.finditer(r'<a[^>]+href="([^"]+\.pdf)"[^>]*>(.*?)</a>', html, re.S | re.I):
            u, label = m.group(1), re.sub(r"<[^>]+>|\s+", " ", m.group(2)).strip()
            if not re.search(r"tats? techniques? (et )?financiers?", label, re.I):
                continue
            y = re.search(r"(20\d\d)", label)
            sub = re.search(r"(Basse|Haute)[ -]Normandie", label, re.I)
            name = sub.group(0).replace(" ", "-").title() if sub else REGION_NAMES.get(code, slug)
            u = urllib.parse.urljoin(RTE + slug, u)
            if u not in out:
                log(f"ETF : nouveau document {label} -> {u}")
                out[u] = (code, int(y.group(1)) if y else 0, name, u)
    return sorted(out.values(), key=lambda t: (t[0], -t[1], url_date(t[3]) or ""), reverse=False)


def pdf_pages(url):
    data = cp.http(url, binary=True, timeout=180)
    if not data.startswith(b"%PDF"):
        raise ValueError("pas un PDF")
    with tempfile.NamedTemporaryFile(suffix=".pdf") as f:
        f.write(data)
        f.flush()
        r = subprocess.run(["pdftotext", "-q", "-enc", "UTF-8", f.name, "-"], capture_output=True, timeout=300)
    pages = r.stdout.decode("utf-8", "replace").split("\f")
    return [" " + cp.norm(p) + " " for p in pages], [cp.strip_accents(p) for p in pages], len(data)


def name_rx(key):
    return re.compile(r"(?<![A-Z0-9])" + re.escape(key).replace(r"\ ", r"\s+") + r"(?![A-Z0-9])")


def etf():
    postes = cp.Postes()
    docs = discover()
    res, meta_docs = {}, []
    for code, year, name, url in docs:
        try:
            pages, raw, size = pdf_pages(url)
        except Exception as e:
            log(f"ETF {name} {year} : échec ({e})")
            continue
        meta_docs.append({"r": code, "y": year, "n": name, "u": url, "d": url_date(url), "pages": len(pages), "ko": size // 1024})
        hits = 0
        for p in postes.items:
            if p["r"] != code:
                continue
            found = []
            for key in p["keys"]:
                if len(key) < 4 and " " not in key:
                    # nom court (GY, HAM, RUE…) : seulement écrit en capitales dans le texte d'origine
                    rx = re.compile(r"(?<![A-Za-z0-9])" + re.escape(key) + r"(?![A-Za-z0-9])")
                    found += [i + 1 for i, t in enumerate(raw) if rx.search(t)]
                    continue
                rx = name_rx(key)
                found += [i + 1 for i, t in enumerate(pages) if rx.search(t)]
            if not found:
                continue
            pg = sorted(set(found))
            prev = res.get(p["k"])
            cand = {"u": url, "y": year, "d": url_date(url), "n": name, "p": pg[0], "pp": pg[:12]}
            if prev is None or (year, cand["d"] or "") > (prev["y"], prev["d"] or ""):
                res[p["k"]] = cand
                hits += 1
        log(f"ETF {name} {year} : {len(pages)} pages, {hits} postes")
    out = {"maj": dt.date.today().isoformat(), "docs": meta_docs, "postes": dict(sorted(res.items()))}
    json.dump(out, open(os.path.join(DATA, "etf.json"), "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    log(f"ETF : {len(res)} postes reliés à un ETF")


# ------------------------------------------------------------------ postes privés (OSM)
OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter",
            "https://maps.mail.ru/osm/tools/overpass/api/interpreter"]
QUERY = """[out:json][timeout:600];
area["ISO3166-1"="FR"][admin_level=2]->.fr;
nwr["power"="substation"]["voltage"~"(^|;)(45000|63000|90000|150000|225000|400000)($|;)"](area.fr);
out center tags;"""
ELD = re.compile(r"GREENALP|RESEDA|\bSER\b|SYNELVA|VIALIS|SUD REOLE|ENERCAL|BRIANCONNAIS|MAYOTTE|GEREDIS|\bSRD\b|SEOLIS|SICAE|\bURM\b|REGIE|HUNELEC|"
                 r"ENERGIES? SERVICES|\bENE\b|STRASBOURG|\bGEG\b|GAZ ET ELECTRICITE|ENEDIS|ERDF|\bRTE\b|RESEAU DE TRANSPORT|ELECTRICITE DE FRANCE|\bEDF\b|EDF SEI|COOPERATIVE")
GRID = re.compile(r"\b(RTE|R\.T\.E|ENEDIS|ERDF|EDF(?! ?(?:RENOUVELABLES|EN\b|-?R\b))|GRDF|SICAE|REGIE|RÉGIE|GEG|SRD|GEREDIS|GÉRÉDIS|STRASBOURG|ÉLECTRICITÉ DE STRASBOURG|ELECTRICITE DE STRASBOURG|ES RESEAUX|URM|SEOLIS|SÉOLIS|ENERGIS|COMPAGNIE NATIONALE DU RHONE|SOREA|SER |RESEAU DE TRANSPORT|RÉSEAU DE TRANSPORT|GAZELEC)\b", re.I)
RAIL = re.compile(r"SNCF|RFF|R[ée]seau ferr|RATP|TRAMWAY|M[ée]tro", re.I)
PROD = re.compile(r"[ée]olien|solaire|photovolta|parc |centrale|wind|solar|neoen|valorem|engie|total|q ?energy|boralex|voltalia|urbasolar|edf renouvelables|edf-r|akuo|cnr|tenergie|baywa|iberdrola|enercoop|rwe|abo |vsb|wpd|eole|res |innovent|ostwind|enertrag|eurocape|elicio|tse|arkolia|langa|valeco|amarenco|apex", re.I)


def overpass(query=None):
    query = query or QUERY
    last = None
    for ep in OVERPASS:
        try:
            req = urllib.request.Request(ep, data=urllib.parse.urlencode({"data": query}).encode(),
                                         headers={"User-Agent": "raccord-pv/1.0 (github.com/cbt135/raccord-pv)"})
            with urllib.request.urlopen(req, timeout=700) as r:
                return json.load(r)["elements"]
        except Exception as e:
            last = e
            log(f"Overpass {ep} : {e}")
    raise RuntimeError(f"Overpass indisponible : {last}")


def kv(v):
    out = []
    for x in re.split(r"[;,]", v or ""):
        try:
            out.append(round(int(float(x)) / 1000))
        except ValueError:
            pass
    return sorted(set(out), reverse=True)


def prives():
    postes = cp.Postes()
    els = overpass()
    log(f"OSM : {len(els)} postes HTB")
    out = []
    for e in els:
        t = e.get("tags", {})
        lat = e.get("lat") or (e.get("center") or {}).get("lat")
        lon = e.get("lon") or (e.get("center") or {}).get("lon")
        if lat is None:
            continue
        op = (t.get("operator") or "").strip()
        own = (t.get("owner") or "").strip()
        name = (t.get("name") or t.get("ref") or "").strip()
        sub = t.get("substation", "")
        who = " ".join([op, own])
        if not cp.in_metro(lat, lon) or (lon > 8.4 and lat < 43.1):
            continue  # métropole continentale (Corse et outre-mer hors S3REnR)
        if sub in ("traction", "converter") or RAIL.search(who) or RAIL.search(name):
            continue
        nwho = cp.norm(who)
        if sub != "generation":
            if not op and not own and sub != "industrial" and not PROD.search(name):
                continue  # sans exploitant renseigné : le plus souvent un poste RTE ou un poste source
            if ELD.search(nwho) or GRID.search(who) or (not who.strip() and GRID.search(name)):
                continue  # RTE, Enedis, entreprises locales de distribution, EDF hors centrales
        # déjà un poste Capareseau à moins de 400 m : on considère qu'il s'agit du même
        if any(cp.hav((lat, lon), (p["lat"], p["lon"])) < 0.4 for p in postes.near(lat, lon, 2)):
            continue
        kind = "prod" if (sub == "generation" or PROD.search(who + " " + name)) else ("ind" if sub in ("industrial", "transition") or op else "autre")
        out.append({"id": f"{e['type'][0]}{e['id']}", "n": name or None, "op": op or own or None, "own": own if own and own != op else None,
                    "kv": kv(t.get("voltage")), "t": kind, "sub": sub or None,
                    "lat": round(lat, 5), "lon": round(lon, 5),
                    "start": t.get("start_date") or None, "ref": t.get("ref:FR:RTE") or t.get("ref") or None})
    out.sort(key=lambda x: (x["t"], x["op"] or "", x["n"] or ""))
    meta = {"maj": dt.date.today().isoformat(), "source": "OpenStreetMap (ODbL), requête Overpass power=substation ≥ 45 kV",
            "n": len(out), "types": {k: sum(1 for x in out if x["t"] == k) for k in ("prod", "ind", "autre")}}
    json.dump({"meta": meta, "postes": out}, open(os.path.join(DATA, "postes-prives.json"), "w", encoding="utf-8"),
              ensure_ascii=False, separators=(",", ":"))
    log(f"Postes privés : {meta}")


# ------------------------------------------------------------------ positions aberrantes des postes Capareseau
# Capareseau publie pour certains postes des coordonnées inversées, fausses ou nulles (Lambert 93 (0,0) -> golfe de Guinée).
QUERY_POS = """[out:json][timeout:600];
area["ISO3166-1"="FR"][admin_level=2]->.fr;
(nwr["power"="substation"]["ref:FR:RTE"](area.fr);
 nwr["power"="substation"]["name"]["voltage"~"(^|;)(45000|63000|90000|150000|225000|400000)($|;)"](area.fr););
out center tags;"""
FR_BOX = (41.3, 51.2, -5.2, 9.7)


def in_fr(lat, lon):
    return lat is not None and lon is not None and FR_BOX[0] < lat < FR_BOX[1] and FR_BOX[2] < lon < FR_BOX[3] and not (lon > 8.0 and lat < 43.2)


def osm_name(n):
    n = cp.norm(n)
    n = re.sub(r"^(POSTE (ELECTRIQUE|SOURCE|DE TRANSFORMATION|RTE)?( DE| DU| DES| D)?|SOUS STATION( DE| DU| D)?)\s+", "", n)
    return n.strip()


def commune_geo(name, region):
    """Centre de la commune portant exactement le nom du poste, dans la région du poste."""
    base = re.sub(r"\(.*?\)|\d+$", " ", name).strip()
    m = re.match(r"^\s*(.*?)\s*\((LES|LA|LE|L)\)\s*$", name.strip(), re.I)
    cands = [base] + ([f"{m.group(2)} {m.group(1)}"] if m else [])
    for c in cands:
        try:
            js = json.loads(cp.http("https://geo.api.gouv.fr/communes?" + urllib.parse.urlencode(
                {"nom": c, "codeRegion": region, "fields": "nom,centre,codeDepartement", "boost": "population", "limit": 5}), timeout=30))
        except Exception as e:
            log(f"  geo.api : {e}")
            continue
        for x in js:
            if cp.norm(x["nom"]) == cp.norm(c) and x.get("centre"):
                lon, lat = x["centre"]["coordinates"]
                return lat, lon, x["nom"]
    return None


def positions():
    path = os.path.join(DATA, "postes.json")
    postes = json.load(open(path, encoding="utf-8"))
    bad = [p for p in postes if not in_fr(p["lat"], p["lon"]) or p.get("pos")]
    log(f"Positions : {len(bad)} postes hors de France ou déjà repositionnés")
    if not bad:
        return
    try:
        els = overpass(QUERY_POS)
    except Exception as e:
        log(f"Overpass indisponible ({e}) : seules l'inversion et la commune sont essayées")
        els = []
    by_ref, by_name = {}, {}
    for e in els:
        t = e.get("tags", {})
        lat = e.get("lat") or (e.get("center") or {}).get("lat")
        lon = e.get("lon") or (e.get("center") or {}).get("lon")
        if lat is None:
            continue
        if t.get("ref:FR:RTE"):
            by_ref.setdefault(t["ref:FR:RTE"].strip().upper(), []).append((lat, lon))
        if t.get("name"):
            by_name.setdefault(osm_name(t["name"]), []).append((lat, lon))
    n = {"inversion": 0, "osm": 0, "commune": 0, "inconnue": 0}
    for p in bad:
        lat0, lon0 = p.get("olat", p["lat"]), p.get("olon", p["lon"])
        p["olat"], p["olon"] = lat0, lon0  # coordonnées publiées par Capareseau, gardées pour mémoire
        res = None
        if in_fr(lon0, lat0):
            res = (lon0, lat0, "inversion")
        if not res and p["c"].upper() in by_ref and len(by_ref[p["c"].upper()]) >= 1:
            la, lo = by_ref[p["c"].upper()][0]
            res = (la, lo, "osm")
        if not res:
            keys = {osm_name(k) for k in cp.Postes.keys(p["n"])}
            hits = [ll for k in keys for ll in by_name.get(k, [])]
            if len({(round(a, 2), round(b, 2)) for a, b in hits}) == 1:
                res = (hits[0][0], hits[0][1], "osm")
        if not res:
            c = commune_geo(p["n"], p["r"])
            if c:
                res = (c[0], c[1], "commune")
        if res and in_fr(res[0], res[1]):
            p["lat"], p["lon"], p["pos"] = round(res[0], 5), round(res[1], 5), res[2]
        else:
            p["pos"] = "inconnue"
        n[p["pos"]] += 1
        log(f"  {p['r']}:{p['c']} {p['n']} ({lat0}, {lon0}) -> {p['pos']} ({p['lat']}, {p['lon']})")
    log(f"Positions corrigées : {n}")
    json.dump(postes, open(path, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))


if __name__ == "__main__":
    what = sys.argv[1:] or ["etf", "prives"]
    if "etf" in what:
        etf()
    if "prives" in what:
        prives()
    if "positions" in what:
        positions()
