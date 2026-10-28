#!/usr/bin/env python3
"""Collecte des projets d'injection voisins (photovoltaïque, éolien, stockage) pour Raccord PV.

Sources
  pe     projets-environnement.gouv.fr : dossiers d'étude d'impact (API Opendatasoft)
  novae  plateforme nationale de l'évaluation environnementale : avis MRAe et cas par cas (depuis 2025)
  mrae   site des MRAe : avis rendus sur projets, pages annuelles (2022 à 2025)
  pref   sites des préfectures : participations du public (PPVE), enquêtes publiques (moteur de recherche commun)

Pour chaque projet, l'avis de l'autorité environnementale, le résumé non technique ou l'avis d'enquête
sont lus (pdftotext) pour en tirer la puissance et le ou les postes sources cités, rapprochés des postes
Capareseau proches du projet.

Écrit data/projets.json (lu par la page), data/projets-meta.json (bilan) et data/projets-cache.json
(documents et géocodages déjà traités : seuls les nouveaux sont lus aux passages suivants).

Usage : python3 scripts/collect_projets.py [--only pe,novae,mrae,pref] [--depts 46,17] [--max-docs 2500]
Dépendances : beautifulsoup4, poppler-utils (pdftotext).
"""
import argparse, concurrent.futures as cf, datetime as dt, json, math, os, re, subprocess, sys, tempfile, threading, time
import unicodedata, urllib.error, urllib.parse, urllib.request
from collections import Counter, defaultdict

from bs4 import BeautifulSoup

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
UA = "Mozilla/5.0 (compatible; raccord-pv/1.0; +https://github.com/cbt135/raccord-pv)"
TODAY = dt.date.today()
CUTOFF = TODAY.replace(year=TODAY.year - 6)
MAX_PDF = 25 * 1024 * 1024
PDF_PAGES = 45

# ---------------------------------------------------------------- utilitaires
def log(*a):
    print(*a, flush=True)


class TooBig(Exception):
    pass


def fix_url(u):
    p = urllib.parse.urlsplit(u)
    path = urllib.parse.quote(urllib.parse.unquote(p.path), safe="/%:@()'!,;=+$&-._~")
    return urllib.parse.urlunsplit((p.scheme, p.netloc, path, p.query, p.fragment))


_host_locks = defaultdict(lambda: threading.Semaphore(3))


def http(url, binary=False, max_bytes=None, timeout=60, tries=3):
    url = fix_url(url)
    host = urllib.parse.urlsplit(url).netloc
    last = None
    for k in range(tries):
        try:
            with _host_locks[host]:
                req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "fr"})
                with urllib.request.urlopen(req, timeout=timeout) as r:
                    cl = r.headers.get("Content-Length")
                    if max_bytes and cl and cl.isdigit() and int(cl) > max_bytes:
                        raise TooBig(int(cl))
                    data = r.read(max_bytes + 1) if max_bytes else r.read()
                    if max_bytes and len(data) > max_bytes:
                        raise TooBig(len(data))
                    if binary:
                        return data
                    return data.decode(r.headers.get_content_charset() or "utf-8", "replace")
        except TooBig:
            raise
        except urllib.error.HTTPError as e:
            if e.code in (400, 401, 403, 404, 410):
                raise
            last = e
        except Exception as e:  # réseau, délai
            last = e
        time.sleep(3 * (k + 1))
    raise last


def jget(url, **kw):
    return json.loads(http(url, **kw))


def strip_accents(s):
    return unicodedata.normalize("NFD", s or "").encode("ascii", "ignore").decode()


def norm(s):
    """Majuscules sans accents ni ponctuation ; ST/STE/MT développés ; garde les décimales."""
    s = re.sub(r"[’'`´ʼ‘]", " ", s or "")
    s = strip_accents(s).upper()
    s = re.sub(r"(\d),(\d)", r"\1.\2", s)
    s = re.sub(r"[^A-Z0-9.]+", " ", s)
    s = re.sub(r"\.(?!\d)", " ", s)
    s = re.sub(r"\bSTE\b", "SAINTE", s)
    s = re.sub(r"\bST\b", "SAINT", s)
    s = re.sub(r"\bMT\b", "MONT", s)
    return re.sub(r"\s+", " ", s).strip()


MONTHS = {m: i + 1 for i, m in enumerate(["JANVIER", "FEVRIER", "MARS", "AVRIL", "MAI", "JUIN", "JUILLET", "AOUT", "SEPTEMBRE", "OCTOBRE", "NOVEMBRE", "DECEMBRE"])}


def fr_date(s):
    m = re.search(r"\b(\d{1,2})(?:ER)?\s+(" + "|".join(MONTHS) + r")\s+(\d{4})", norm(s))
    if m:
        try:
            return dt.date(int(m.group(3)), MONTHS[m.group(2)], int(m.group(1))).isoformat()
        except ValueError:
            return None
    m = re.search(r"\b(\d{2})/(\d{2})/(\d{4})\b", s or "")
    if m:
        try:
            return dt.date(int(m.group(3)), int(m.group(2)), int(m.group(1))).isoformat()
        except ValueError:
            return None
    return None


def hav(a, b):
    r = math.pi / 180
    h = math.sin((b[0] - a[0]) * r / 2) ** 2 + math.cos(a[0] * r) * math.cos(b[0] * r) * math.sin((b[1] - a[1]) * r / 2) ** 2
    return 2 * 6371.0088 * math.asin(math.sqrt(h))


def in_metro(lat, lon):
    return lat is not None and lon is not None and 41.2 < lat < 51.3 and -5.5 < lon < 9.9


# ---------------------------------------------------------------- type, puissance
TYPE_RE = {
    "eol": re.compile(r"\bEOLIEN|\bEOLIENNE|AEROGENERATEUR|\bPARC EOLIEN|ICPE INB EOLIENNES"),
    "bess": re.compile(r"STOCKAGE (?:D |DE L |PAR )?(?:ENERGIE|ELECTRICITE|BATTERIE)|BATTERIES? DE STOCKAGE|\bBESS\b|STOCKAGE PAR BATTERIE|SYSTEME DE STOCKAGE|STOCKAGE ELECTROCHIMIQUE|UNITE DE STOCKAGE"),
    "pv": re.compile(r"PHOTOVOLT|AGRIVOLT|AGRISOLAIRE|CENTRALE SOLAIRE|PARC SOLAIRE|FERME SOLAIRE|OMBRIERE|SOLAIRE FLOTTANT|FLOTTANTE? SOLAIRE|SOLAIRE AU SOL|CENTRALE AU SOL|PANNEAUX SOLAIRES|SOLAIRE PV"),
}
NOT_ENERGY = re.compile(r"RECYCL|FABRICATION|GIGAFACTORY|USINE DE (?:BATTERIES|CELLULES|PANNEAUX)|PRODUCTION DE (?:BATTERIES|CELLULES|PANNEAUX)|SOLAIRE THERMIQUE|CHAUFFE EAU|RESEAU DE CHALEUR|DEMANTELEMENT")


def types_of(*texts):
    t = norm(" ".join(x for x in texts if x))
    if NOT_ENERGY.search(t) and not re.search(r"PHOTOVOLT|AGRIVOLT|EOLIEN", t):
        return []
    return [k for k in ("pv", "eol", "bess") if TYPE_RE[k].search(t)]


NUM = r"(\d{1,3}(?:[   ]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?)"
P_UNIT = r"(GWC|GWP|GW|MWC|MWP|MWE|MW|KWC|KWP|KWE|KW)\b(?!\s*H)"
E_UNIT = r"(GWH|MWH|KWH)\b(?!\s*/?\s*(?:AN|AN\b|PAR AN))"


def parse_num(s, unit):
    s = s.replace(" ", " ").replace(" ", " ")
    if re.fullmatch(r"\d{1,3}(?: \d{3})+(?:[.,]\d+)?", s):
        s = s.replace(" ", "")
    if "," in s:
        s = s.replace(".", "").replace(",", ".")
    elif re.fullmatch(r"\d{1,3}\.\d{3}", s) and unit.startswith("K"):
        s = s.replace(".", "")
    try:
        v = float(s)
    except ValueError:
        return None
    if unit.startswith("K"):
        v /= 1000
    elif unit.startswith("G"):
        v *= 1000
    return v


def power_of(text, prefer_context=True):
    """Puissance en MW (et énergie MWh pour le stockage) tirée d'un texte."""
    t = strip_accents(text or "").upper().replace(" ", " ").replace(" ", " ")
    t = re.sub(r"\s+", " ", t)
    mw = None
    if prefer_context:
        m = re.search(r"PUISSANCE(?: TOTALE| INSTALLEE| CRETE| NOMINALE| MAXIMALE| ELECTRIQUE| D INJECTION| DE RACCORDEMENT| CUMULEE)*[^.;:]{0,60}?" + NUM + r"\s*" + P_UNIT, t)
        if m:
            mw = parse_num(m.group(1), m.group(2))
    if mw is None:
        for m in re.finditer(NUM + r"\s*" + P_UNIT, t[:20000]):
            v = parse_num(m.group(1), m.group(2))
            if v and 0.05 <= v <= 3000:
                mw = v
                break
    mwh = None
    m = re.search(NUM + r"\s*" + E_UNIT, t[:20000])
    if m:
        mwh = parse_num(m.group(1), m.group(2).replace("H", ""))
    if mw is not None and not (0.01 <= mw <= 5000):
        mw = None
    return mw, mwh


# ---------------------------------------------------------------- postes Capareseau
class Postes:
    def __init__(self):
        postes = json.load(open(os.path.join(DATA, "postes.json"), encoding="utf-8"))
        try:
            corr = json.load(open(os.path.join(DATA, "postes-corrections.json"), encoding="utf-8"))
        except Exception:
            corr = {}
        self.items = []
        for p in postes:
            k = f"{p['r']}:{p['c']}"
            c = corr.get(k) or {}
            lat, lon = c.get("lat", p["lat"]), c.get("lon", p["lon"])
            self.items.append({"k": k, "c": p["c"], "r": p["r"], "n": p["n"], "lat": lat, "lon": lon, "keys": self.keys(p["n"])})

    @staticmethod
    def keys(name):
        base = re.sub(r"\(.*?\)", " ", name)
        keys = {norm(base)}
        m = re.match(r"^\s*(.*?)\s*\((LES|LA|LE|L)\)\s*$", name.strip(), re.I)
        if m:
            keys.add(norm(m.group(2) + " " + m.group(1)))
        return [k for k in keys if len(k) >= 3]

    def near(self, lat, lon, km=55):
        if lat is None:
            return []
        return [p for p in self.items if abs(p["lat"] - lat) < 0.6 and abs(p["lon"] - lon) < 0.9 and hav((lat, lon), (p["lat"], p["lon"])) <= km]


EXCLUDE_AFTER_POSTE = re.compile(r"^S? (?:DE LIVRAISON|DE TRANSFORMATION|ONDULEUR|DE CONVERSION|HTA BT|BT|DE DELIVRANCE|DE COMPTAGE|DE GARDE|PRIVE|ELEVATEUR|DE STOCKAGE)")


def find_postes(text, cands):
    """Postes Capareseau cités à proximité du mot « poste ». Renvoie [(poste, km|None, extrait)] dans l'ordre du texte."""
    if not cands:
        return []
    t = norm(text)
    orig = re.sub(r"\s+", " ", text or "")
    opos = [m.start() for m in re.finditer(r"\bpostes?\b", orig, re.I)]
    npos = [m.start() for m in re.finditer(r"\bPOSTES?\b", t)]
    found, seen = [], set()
    for m in re.finditer(r"\bPOSTE", t):
        after = t[m.end(): m.end() + 140]
        if EXCLUDE_AFTER_POSTE.match(after):
            continue
        head = after[:80]
        best = None
        for p in cands:
            for k in p["keys"]:
                mm = re.search(r"\b" + re.escape(k) + r"\b", head)
                if mm and (best is None or mm.start() < best[1] or (mm.start() == best[1] and len(k) > best[2])):
                    best = (p, mm.start(), len(k), mm.end())
        if best and best[0]["k"] not in seen:
            p = best[0]
            seen.add(p["k"])
            rest = after[best[3]: best[3] + 70]
            km = re.search(r"\b(\d+(?:\.\d+)?) KM\b", rest)
            ex = t[max(0, m.start() - 90): m.end() + best[3] + 60]
            if m.start() in npos and len(opos) == len(npos):  # même occurrence dans le texte d'origine
                o = opos[npos.index(m.start())]
                a, b = max(0, o - 110), min(len(orig), o + 200)
                a = orig.rfind(" ", 0, a) + 1 if a else 0
                b = orig.find(" ", b) if orig.find(" ", b) > 0 else len(orig)
                ex = ("…" if a else "") + orig[a:b].strip() + ("…" if b < len(orig) else "")
            found.append((p, float(km.group(1)) if km else None, ex))
    return found


def raw_poste_names(text):
    """Noms de postes cités mais absents de Capareseau (pour information)."""
    t = norm(text)
    out = []
    for m in re.finditer(r"\bPOSTES? SOURCES? (?:DE LA |DE L |DES |DU |DE |D )([A-Z][A-Z ]{2,40}?)(?= A | SITUE| LOCALISE| DISTANT| ENVIRON| QUI | DONT | ET | OU | EST | SERA | PAR | AU |\d| LE | LA | LES | EN |$)", t):
        n = m.group(1).strip()
        if n not in out and not re.match(r"^(PLUS|LE PLUS|PROCHE|LOCAL|EXISTANT|ENEDIS|RTE)\b", n):
            out.append(n)
    return out[:4]


# ---------------------------------------------------------------- PDF
_tmp = tempfile.mkdtemp(prefix="rpv-")


def pdf_text(url):
    data = http(url, binary=True, max_bytes=MAX_PDF, timeout=120)
    if not data.startswith(b"%PDF"):
        # certains liens renvoient une page HTML
        txt = data[:400000].decode("utf-8", "replace")
        return BeautifulSoup(txt, "html.parser").get_text(" ") if "<html" in txt.lower() else ""
    fn = os.path.join(_tmp, f"{threading.get_ident()}.pdf")
    with open(fn, "wb") as f:
        f.write(data)
    try:
        r = subprocess.run(["pdftotext", "-q", "-l", str(PDF_PAGES), "-enc", "UTF-8", fn, "-"], capture_output=True, timeout=180)
        return r.stdout.decode("utf-8", "replace")
    finally:
        os.remove(fn)


# ---------------------------------------------------------------- géocodage communes
class Geo:
    def __init__(self, cache):
        self.c = cache.setdefault("geo", {})
        self.dep_communes = {}
        self.lock = threading.Lock()

    def commune(self, nom, dep=None):
        nom = re.sub(r"\s+", " ", (nom or "").strip(" -,.;"))
        if not nom:
            return None
        r = self._commune(nom, dep)
        if r is None:  # « sol d'Arconcey », « Parc de Villiers » : on retente avec la fin du nom
            m = re.search(r"(?:\bd['’]|\s(?:de|du|des|à|a|sur)\s)([^'’]+)$", nom, re.I)
            if m and m.group(1) != nom:
                r = self._commune(m.group(1), dep)
        return r

    def _commune(self, nom, dep=None):
        key = f"{dep or ''}|{norm(nom)}"
        if key in self.c:
            return self.c[key]
        q = {"nom": nom, "fields": "nom,code,centre,codeDepartement", "format": "json", "boost": "population", "limit": "5"}
        if dep:
            q["codeDepartement"] = dep
        res = None
        try:
            js = jget("https://geo.api.gouv.fr/communes?" + urllib.parse.urlencode(q))
            nn = norm(nom)
            exact = [x for x in js if norm(x["nom"]) == nn]
            inside = [x for x in js if len(norm(x["nom"])) >= 4 and re.search(r"\b" + re.escape(norm(x["nom"])) + r"\b", nn)]
            x = (exact or inside or [None])[0]
            if x and x.get("centre"):
                lon, lat = x["centre"]["coordinates"]
                res = [round(lat, 5), round(lon, 5), x["code"], x["nom"], x.get("codeDepartement")]
        except Exception as e:
            log("  géocodage impossible", nom, dep, e)
            return None
        with self.lock:
            self.c[key] = res
        return res

    def postcode(self, cp):
        key = f"cp|{cp}"
        if key in self.c:
            return self.c[key]
        res = None
        try:
            js = jget(f"https://geo.api.gouv.fr/communes?codePostal={cp}&fields=nom,code,centre,codeDepartement&format=json")
            if js and js[0].get("centre"):
                lon, lat = js[0]["centre"]["coordinates"]
                res = [round(lat, 5), round(lon, 5), js[0]["code"], js[0]["nom"], js[0].get("codeDepartement")]
        except Exception:
            return None
        with self.lock:
            self.c[key] = res
        return res

    def communes_of(self, dep):
        if dep not in self.dep_communes:
            try:
                js = jget(f"https://geo.api.gouv.fr/departements/{dep}/communes?fields=nom,code,centre&format=json")
                self.dep_communes[dep] = sorted(
                    [(norm(x["nom"]), x) for x in js if x.get("centre") and len(norm(x["nom"])) >= 4], key=lambda y: -len(y[0]))
            except Exception:
                self.dep_communes[dep] = []
        return self.dep_communes[dep]

    def find_in_text(self, text, dep):
        t = " " + norm(text) + " "
        for n, x in self.communes_of(dep):
            if f" {n} " in t:
                lon, lat = x["centre"]["coordinates"]
                return [round(lat, 5), round(lon, 5), x["code"], x["nom"], dep]
        return None


COMMUNE_DEP_RE = re.compile(r"(?:COMMUNES? D[EU]S?\s+|COMMUNES? D['’]|(?<![\wÀ-ÿ])[AÀ]\s+|\bAU\s+|\bSUR\s+|\bDE\s+|\bD['’]|^)([A-ZÀ-Ü][\wÀ-ÿ'’\- ]{1,60}?)\s*\((\d{2}|2A|2B)\)", re.I)


def commune_dep_from(text):
    """« … sur la commune de Parville (27) » → ("Parville", "27")."""
    for m in COMMUNE_DEP_RE.finditer(text or ""):
        nom = re.sub(r"^(?:la commune de |commune de |la |les |le )", "", m.group(1).strip(), flags=re.I)
        nom = re.split(r"\s+(?:sur|à|au|en|de la commune de|commune de)\s+", nom)[-1]
        if 2 <= len(nom) <= 50:
            return nom, m.group(2)
    return None


# ---------------------------------------------------------------- sources
PE_API = "https://www.projets-environnement.gouv.fr/api/explore/v2.1/catalog/datasets/projets-environnement-diffusion"


def src_pe(geo):
    sel = ",".join(["dc_title", "descriptif_du_projet", "dc_subject_category", "dc_subject_theme", "dc_type", "vp_status", "dc_date", "dateouverture", "datefermeture",
                    "dc_location", "geo_point_2d", "dc_relation_decision", "dc_relation_expertise_avisae", "dc_relation_synthesis", "dc_relation_informationnote",
                    "dc_relation_websitedebate", "dc_relation_expertise_etudeimpact", "recordsid", "location_ville", "codepostal"])
    url = f"{PE_API}/exports/json?" + urllib.parse.urlencode({"where": f"dc_date >= date'{CUTOFF.isoformat()}'", "select": sel})
    rows = json.loads(http(url, timeout=300))
    log(f"projets-environnement : {len(rows)} dossiers depuis {CUTOFF}")
    out = []
    for x in rows:
        cat = " ".join(x.get("dc_subject_category") or []) + " " + " ".join(x.get("dc_subject_theme") or [])
        ty = types_of(x.get("dc_title"), x.get("descriptif_du_projet"), cat)
        if not ty:
            continue
        dep = (re.match(r"\s*(\d{2}|2A|2B)", x.get("dc_location") or "") or [None, None])[1]
        g = x.get("geo_point_2d")
        lat = lon = None
        gq, com, insee = "p", None, None
        if g and in_metro(g.get("lat"), g.get("lon")):
            lat, lon = g["lat"], g["lon"]
        elif dep:
            # deux dossiers sur trois n'ont pas de coordonnées : commune déclarée, code postal, ou commune citée
            c = None
            if x.get("location_ville"):
                c = geo.commune(str(x["location_ville"]).split(",")[0], dep)
            if not c and x.get("codepostal") and re.fullmatch(r"\d{5}", str(x["codepostal"]).strip()):
                c = geo.postcode(str(x["codepostal"]).strip())
            if not c:
                cd = commune_dep_from(f'{x.get("dc_title") or ""} . {x.get("descriptif_du_projet") or ""}')
                c = geo.commune(*cd) if cd and cd[1] == dep else None
            if not c:
                c = geo.find_in_text(x.get("dc_title") or "", dep) or geo.find_in_text((x.get("descriptif_du_projet") or "")[:800], dep)
            if c:
                lat, lon, insee, com, gq = c[0], c[1], c[2], c[3], "c"
        if not in_metro(lat, lon):
            continue
        st = "Consultation du public en cours" if x.get("vp_status") == "ouvert" else ("Décision publiée" if x.get("dc_relation_decision") else ("Avis AE publié" if x.get("dc_relation_expertise_avisae") else "Dossier publié"))
        docs = [("Avis de l'autorité environnementale", x.get("dc_relation_expertise_avisae")), ("Résumé non technique", x.get("dc_relation_synthesis"))]
        links = [("Avis AE", x.get("dc_relation_expertise_avisae")), ("Résumé non technique", x.get("dc_relation_synthesis")), ("Décision", x.get("dc_relation_decision")),
                 ("Page préfecture", x.get("dc_relation_informationnote") or x.get("dc_relation_websitedebate"))]
        out.append({
            "src": "PE", "id": f"pe:{x.get('recordsid')}", "n": (x.get("dc_title") or "").strip(), "t": ty,
            "desc": x.get("descriptif_du_projet") or "", "lat": lat, "lon": lon, "geo": gq, "dep": dep, "com": com, "insee": insee,
            "d": (x.get("dc_date") or "")[:10], "st": st, "pr": ", ".join(x.get("dc_type") or []),
            "docs": [(l, u) for l, u in docs if u and u.startswith("http")],
            "links": [(l, u) for l, u in links if u and u.startswith("http")],
        })
    log(f"  dont projets d'injection (PV, éolien, stockage) : {len(out)}")
    return out


NOVAE = "https://gatew-evaluation-environnementale.developpement-durable.gouv.fr/api/"
NOVAE_CATS = {
    "Demande d’avis d’une autorité environnementale pour un projet": "Avis MRAe",
    "Demande d’examen au cas par cas préalable à la réalisation d’une étude d’impact pour un projet": "Cas par cas MRAe",
}
NOVAE_DOM = re.compile(r"PHOTOVOLTAIQUE|EOLIENNES|AUTRES ENERGIES RENOUVELABLES")


def src_novae(geo, cache):
    att_cache = cache.setdefault("novae_att", {})
    out = []
    for cat, label in NOVAE_CATS.items():
        start, rows = 0, []
        while True:
            js = jget(NOVAE + "PublishedDocument/Get?" + urllib.parse.urlencode({"start": start, "length": 1000, "descending_order_id": "true", "categoryName": cat}), timeout=180)
            rows += js.get("data") or []
            start += 1000
            if start >= (js.get("totalCount") or 0) or not js.get("data"):
                break
        log(f"NOVAE {label} : {len(rows)} publications")
        keep = []
        for x in rows:
            ty = types_of(x.get("projectTitle"), x.get("domaine"))
            if not ty and not NOVAE_DOM.search(norm(x.get("domaine"))):
                continue
            if not ty:
                ty = ["eol"] if "EOLIEN" in norm(x.get("domaine")) else ["pv"] if "PHOTOVOLT" in norm(x.get("domaine")) else []
            if not ty:
                continue
            keep.append((x, ty))
        log(f"  dont projets d'injection : {len(keep)}")

        def detail(item):
            x, ty = item
            did = str(x["documentId"])
            if did not in att_cache:
                try:
                    d = jget(NOVAE + f"PublishedDocument/GetByDocumentId?documentId={did}")
                    att_cache[did] = [[a.get("folderName"), a.get("id"), a.get("name"), a.get("storageFileSize")] for a in (d.get("attachments") or [])]
                except Exception as e:
                    log("  NOVAE détail impossible", did, e)
                    att_cache[did] = None
            return item

        with cf.ThreadPoolExecutor(6) as ex:
            list(ex.map(detail, keep))
        for x, ty in keep:
            mun = x.get("municipality") or ""
            m = re.match(r"\s*(.+?)\s*\((\d{2}|2A|2B)\)", mun)
            dep = (re.match(r"\s*(\d{2}|2A|2B)", x.get("department") or "") or [None, None])[1]
            g = geo.commune(m.group(1), m.group(2)) if m else (geo.commune(mun.split(",")[0], dep) if mun else None)
            if not g:
                cd = commune_dep_from(x.get("projectTitle"))
                g = geo.commune(*cd) if cd else None
            if not g or not in_metro(g[0], g[1]):
                continue
            atts = att_cache.get(str(x["documentId"])) or []
            docs, links = [], []
            for folder, aid, name, size in atts:
                f = norm(folder)
                u = f"{NOVAE[:-4]}documents/{aid}/document.pdf"
                if re.search(r"AVIS|DECISION", f):
                    docs.insert(0, (folder or "Avis", u))
                    links.insert(0, (folder or "Avis", u))
                elif "RESUME" in f and (size or 0) <= MAX_PDF:
                    docs.append(("Résumé non technique", u))
                    links.append(("Résumé non technique", u))
            links.append(("Fiche NOVAE", f"https://evaluation-environnementale.ecologie.gouv.fr/publication/view-document/{x['documentId']}"))
            out.append({
                "src": "MRAe", "id": f"novae:{x['documentId']}", "n": (x.get("projectTitle") or "").strip(), "t": ty, "desc": "",
                "lat": g[0], "lon": g[1], "geo": "c", "insee": g[2], "com": g[3], "dep": g[4] or dep,
                "d": (x.get("publishedDate") or "")[:10], "st": f"{label} – {x.get('documentStatus') or ''}".strip(" –"), "pr": label,
                "docs": docs[:2], "links": links[:4],
            })
    return out


MRAE = "https://www.mrae.developpement-durable.gouv.fr/"
MRAE_RUBRIQUES = [302, 303, 304, 305, 306, 307, 309, 310, 311, 312, 313, 314]  # métropole hors Corse


def mrae_entries(cont):
    """[(texte, lien PDF ou None)] : un bloc par avis quand la page en a, sinon découpage au fil des liens PDF."""
    blocks = cont.select(".texteencadre-spip")
    if len(blocks) >= 3:
        out = []
        for b in blocks:
            a = b.select_one('a[href*="IMG/pdf"]')
            txt = " ".join(x.strip() for x in b.find_all(string=True) if x.strip() and not x.find_parent("a"))
            out.append((txt, a["href"] if a else None))
        return out
    entries, buf = [], []
    for el in cont.descendants:
        if getattr(el, "name", None) == "a" and "IMG/pdf" in (el.get("href") or ""):
            entries.append((" ".join(buf), el["href"]))
            buf = []
        elif isinstance(el, str) and not el.find_parent("a"):
            s = el.strip()
            if s:
                buf.append(s)
    return entries


def src_mrae(geo, years=("2022", "2023", "2024", "2025")):
    out = []
    for rid in MRAE_RUBRIQUES:
        try:
            soup = BeautifulSoup(http(f"{MRAE}avis-rendus-sur-projets-r{rid}.html"), "html.parser")
        except Exception as e:
            log("MRAe rubrique illisible", rid, e)
            continue
        arts = {}
        for a in soup.select("a[href]"):
            h, t = a["href"], a.get_text(" ", strip=True)
            m = re.search(r"en ((?:19|20)\d\d)\b", t)
            if re.match(r"avis-rendus-sur-projets.*-a\d+\.html$", h) and m and m.group(1) in years:
                arts[h] = (t, m.group(1))
        for h, (title, year) in arts.items():
            try:
                page = BeautifulSoup(http(MRAE + h), "html.parser")
            except Exception as e:
                log("  page MRAe illisible", h, e)
                continue
            cont = page.select_one(".texte-article") or page.select_one("main") or page
            entries = mrae_entries(cont)
            region = re.sub(r"^Avis rendus sur projets de la ", "", title)
            n_ok = 0
            for txt, href in entries:
                txt = re.sub(r"\s+", " ", txt).strip()
                txt = re.sub(r"^(?:(?:JANVIER|FÉVRIER|FEVRIER|MARS|AVRIL|MAI|JUIN|JUILLET|AOÛT|AOUT|SEPTEMBRE|OCTOBRE|NOVEMBRE|DÉCEMBRE|DECEMBRE)(?: \d{4})? )+", "", txt)
                ty = types_of(txt)
                if not ty:
                    continue
                cd = commune_dep_from(txt)
                g = geo.commune(*cd) if cd else None
                if not g or not in_metro(g[0], g[1]):
                    continue
                n_ok += 1
                pdf = urllib.parse.urljoin(MRAE, href) if href else None
                sans_avis = bool(re.search(r"ABSENCE D AVIS", norm(txt)))
                ttl = re.split(r"(?:Dossier présenté|Projet porté|Avis (?:sur projet |délibéré )?du|\d{4}A\w+ /)", txt)[0].strip(" .-")
                out.append({
                    "src": "MRAe", "id": f"mrae:{href}", "n": ttl[:220] or txt[:200], "t": ty, "desc": txt[:400],
                    "lat": g[0], "lon": g[1], "geo": "c", "insee": g[2], "com": g[3], "dep": g[4],
                    "d": fr_date(txt) or f"{year}-06-30", "st": "Absence d'avis MRAe" if sans_avis else "Avis MRAe publié", "pr": "Avis MRAe",
                    "docs": [("Avis MRAe", pdf)] if pdf else [], "links": ([("Avis MRAe", pdf)] if pdf else []) + [(f"MRAe {region}", MRAE + h)],
                })
            log(f"MRAe {region} : {len(entries)} avis, {n_ok} projets d'injection")
    return out


PREF_DOMAINS = {
    "01": "ain", "02": "aisne", "03": "allier", "04": "alpes-de-haute-provence", "05": "hautes-alpes", "06": "alpes-maritimes", "07": "ardeche", "08": "ardennes",
    "09": "ariege", "10": "aube", "11": "aude", "12": "aveyron", "13": "bouches-du-rhone", "14": "calvados", "15": "cantal", "16": "charente", "17": "charente-maritime",
    "18": "cher", "19": "correze", "21": "cote-dor", "22": "cotes-darmor", "23": "creuse", "24": "dordogne", "25": "doubs", "26": "drome", "27": "eure", "28": "eure-et-loir",
    "29": "finistere", "30": "gard", "31": "haute-garonne", "32": "gers", "33": "gironde", "34": "herault", "35": "ille-et-vilaine", "36": "indre", "37": "indre-et-loire",
    "38": "isere", "39": "jura", "40": "landes", "41": "loir-et-cher", "42": "loire", "43": "haute-loire", "44": "loire-atlantique", "45": "loiret", "46": "lot",
    "47": "lot-et-garonne", "48": "lozere", "49": "maine-et-loire", "50": "manche", "51": "marne", "52": "haute-marne", "53": "mayenne", "54": "meurthe-et-moselle",
    "55": "meuse", "56": "morbihan", "57": "moselle", "58": "nievre", "59": "nord", "60": "oise", "61": "orne", "62": "pas-de-calais", "63": "puy-de-dome",
    "64": "pyrenees-atlantiques", "65": "hautes-pyrenees", "66": "pyrenees-orientales", "67": "bas-rhin", "68": "haut-rhin", "69": "rhone", "70": "haute-saone",
    "71": "saone-et-loire", "72": "sarthe", "73": "savoie", "74": "haute-savoie", "76": "seine-maritime", "77": "seine-et-marne", "78": "yvelines", "79": "deux-sevres",
    "80": "somme", "81": "tarn", "82": "tarn-et-garonne", "83": "var", "84": "vaucluse", "85": "vendee", "86": "vienne", "87": "haute-vienne", "88": "vosges",
    "89": "yonne", "90": "territoire-de-belfort", "91": "essonne", "92": "hauts-de-seine", "93": "seine-saint-denis", "94": "val-de-marne", "95": "val-doise",
}
PREF_KEYWORDS = ["photovoltaïque", "agrivoltaïque", "éolien", "éoliennes", "centrale solaire", "stockage batteries"]
PROC_RE = re.compile(r"ENQUETE PUBLIQUE|PARTICIPATION DU PUBLIC|PARTICIPATION PAR VOIE ELECTRONIQUE|\bPPVE\b|CONSULTATION DU PUBLIC|AUTORISATION ENVIRONNEMENTALE|PERMIS DE CONSTRUIRE|AVIS D ENQUETE|DECLARATION DE PROJET|INSTALLATION CLASSEE|\bICPE\b|ETUDE D IMPACT|MISE A DISPOSITION")
SKIP_URL = re.compile(r"Recueil-des-Actes|RAA|Communique|Salle-de-presse|Actualites|/contenu/telechargement/", re.I)
DOC_RANK = [
    (re.compile(r"AVIS.{0,30}(MRAE|AUTORITE ENVIRONNEMENTALE|\bAE\b|\bAAE\b)|\bMRAE\b"), 0),
    (re.compile(r"RESUME NON TECHNIQUE|\bRNT\b"), 1),
    (re.compile(r"AVIS D (?:OUVERTURE D )?ENQUETE|AVIS AU PUBLIC|AVIS DE (?:PARTICIPATION|CONSULTATION)|AVIS D OUVERTURE"), 2),
    (re.compile(r"ARRETE.{0,40}(OUVERTURE|ORGANISATION|PRESCRIVANT)|\bAPOE\b|\bAOE\b"), 3),
    (re.compile(r"NOTICE|PRESENTATION|NOTE DE PRESENTATION"), 4),
]


def pref_proc(t):
    if re.search(r"PARTICIPATION DU PUBLIC PAR VOIE ELECTRONIQUE|PARTICIPATION PAR VOIE ELECTRONIQUE|\bPPVE\b", t):
        return "PPVE"
    if "ENQUETE PUBLIQUE" in t:
        return "Enquête publique"
    if "CONSULTATION DU PUBLIC" in t:
        return "Consultation du public"
    if "AUTORISATION ENVIRONNEMENTALE" in t:
        return "Autorisation environnementale"
    return "Publication préfecture"


def src_pref(geo, cache, depts=None):
    pc = cache.setdefault("pref", {})
    out, stats = [], {}
    for dep, dom in PREF_DOMAINS.items():
        if depts and dep not in depts:
            continue
        base = f"https://www.{dom}.gouv.fr"
        cards, err = {}, None
        for kw in PREF_KEYWORDS:
            for page in range(12):
                u = f"{base}/content/search?SearchText={urllib.parse.quote(kw)}" if page == 0 else \
                    f"{base}/contenu/recherche/(offset)/{10 * page}?SearchText={urllib.parse.quote(kw)}&dateFilter[]="
                try:
                    soup = BeautifulSoup(http(u, timeout=45, tries=2), "html.parser")
                except Exception as e:
                    err = str(e)[:80]
                    break
                cs = soup.select(".fr-card__content")
                if not cs:
                    break
                old = 0
                for c in cs:
                    a = c.select_one(".fr-card__title a, h3 a, a")
                    if not a or not a.get("href"):
                        continue
                    href = urllib.parse.urljoin(base, a["href"])
                    desc = (c.select_one(".fr-card__desc") or c).get_text(" ", strip=True)
                    det = (c.select_one(".fr-card__detail") or c).get_text(" ", strip=True)
                    d = fr_date(det)
                    if d and d < CUTOFF.isoformat():
                        old += 1
                        continue
                    cards[href] = (a.get_text(" ", strip=True), desc, d)
                if old >= len(cs) - 1 or len(cs) < 10:
                    break
        kept = 0
        for href, (title, desc, d) in cards.items():
            if SKIP_URL.search(href) or not href.startswith(base):
                continue
            t = norm(title + " " + desc)
            ty = types_of(title, desc)
            if not ty or not (PROC_RE.search(t) or re.search(r"PARTICIPATION|ENQUETE|CONSULTATION|ICPE|ENVIRONNEMENT", norm(href))):
                continue
            key = href
            ent = pc.get(key)
            if not ent or ent.get("d") != d:
                try:
                    soup = BeautifulSoup(http(href, timeout=60, tries=2), "html.parser")
                except Exception as e:
                    log("  page préfecture illisible", href, e)
                    continue
                main = soup.select_one("main") or soup
                text = re.sub(r"\s+", " ", main.get_text(" ", strip=True))[:6000]
                docs = []
                for a in main.select("a[href]"):
                    lab = a.get_text(" ", strip=True)
                    h = a["href"]
                    if "/telechargement/" not in h and not h.lower().endswith(".pdf"):
                        continue
                    ms = re.search(r"(\d+(?:[.,]\d+)?)\s*(Mb|Mo|Kb|Ko)", lab, re.I)
                    size = None
                    if ms:
                        size = float(ms.group(1).replace(",", ".")) * (1 if ms.group(2).lower().startswith("m") else 1 / 1024)
                    nl = norm(lab)
                    rank = next((r for rx, r in DOC_RANK if rx.search(nl)), None)
                    if rank is None or (size and size > MAX_PDF / 1024 / 1024):
                        continue
                    docs.append([rank, re.sub(r"^Télécharger\s*", "", lab)[:120], urllib.parse.urljoin(base, h)])
                docs.sort(key=lambda x: x[0])
                ent = {"d": d, "title": title, "text": text, "docs": [x[1:] for x in docs[:3]]}
                pc[key] = ent
            text = ent["text"]
            nt = norm(ent["title"] + " " + text)
            ty = types_of(ent["title"], text[:2500]) or ty
            g = None
            for cp in re.findall(r"\b((?:0[1-9]|[1-8]\d|9[0-5])\d{3})\b", ent["title"] + " " + text[:1500]):
                if cp[:2] == dep or (dep == "20"):
                    g = geo.postcode(cp)
                    if g:
                        break
            if not g:
                cd = commune_dep_from(ent["title"] + " " + text[:1500])
                g = geo.commune(*cd) if cd and cd[1] == dep else None
            if not g:
                g = geo.find_in_text(ent["title"], dep) or geo.find_in_text(text[:1200], dep)
            if not g or not in_metro(g[0], g[1]):
                continue
            kept += 1
            proc = pref_proc(nt)
            dates = re.search(r"DU (\d{1,2}(?:ER)? [A-Z]+ \d{4}) (?:INCLUS )?AU (\d{1,2}(?:ER)? [A-Z]+ \d{4})", nt)
            fd = lambda x: dt.date.fromisoformat(x).strftime("%d/%m/%Y") if x else ""
            st = proc + (f" du {fd(fr_date(dates.group(1)))} au {fd(fr_date(dates.group(2)))}" if dates and fr_date(dates.group(1)) and fr_date(dates.group(2)) else "")
            out.append({
                "src": "Préfecture", "id": f"pref:{href}", "n": ent["title"][:220], "t": ty, "desc": text[:600],
                "lat": g[0], "lon": g[1], "geo": "c", "insee": g[2], "com": g[3], "dep": dep,
                "d": ent["d"] or "", "st": st, "pr": proc,
                "docs": [(l, u) for l, u in ent["docs"][:2]], "links": [("Page préfecture", href)] + [(l, u) for l, u in ent["docs"][:2]],
            })
        stats[dep] = {"resultats": len(cards), "projets": kept, **({"erreur": err} if err and not cards else {})}
        log(f"Préfecture {dep} ({dom}) : {len(cards)} résultats, {kept} projets d'injection{' – ' + err if err and not cards else ''}")
    return out, stats


# ---------------------------------------------------------------- lecture des documents
def analyse_docs(projects, postes, cache, max_docs, deadline):
    dc = cache.setdefault("docs", {})
    todo = []
    for p in projects:
        for lab, u in p["docs"]:
            if u not in dc:
                todo.append((p.get("d") or "", u))
    todo = sorted(set(todo), reverse=True)  # les plus récents d'abord
    log(f"Documents à lire : {len(todo)} nouveaux (plafond {max_docs} pour ce passage)")
    todo = [u for _, u in todo[:max_docs]]
    near_of = {}
    for p in projects:
        for lab, u in p["docs"]:
            near_of.setdefault(u, (p["lat"], p["lon"]))
    done = [0]
    lock = threading.Lock()

    def work(u):
        if time.time() > deadline:
            return None  # budget de temps atteint : repris au prochain passage
        lat, lon = near_of[u]
        try:
            txt = pdf_text(u)
            cands = postes.near(lat, lon)
            fp = find_postes(txt, cands)
            mw, mwh = power_of(txt[:30000])
            res = {"ok": 1, "mw": mw, "mwh": mwh, "rac": [[p["k"], km] for p, km, _ in fp], "x": fp[0][2][:300] if fp else None,
                   "raw": [] if fp else raw_poste_names(txt), "len": len(txt)}
        except TooBig as e:
            res = {"ok": 0, "err": f"trop volumineux ({int(e.args[0]) // 1048576} Mo)"}
        except Exception as e:
            res = {"ok": 0, "err": str(e)[:120]}
        res["at"] = TODAY.isoformat()
        with lock:
            dc[u] = res
            done[0] += 1
            if done[0] % 100 == 0:
                log(f"  {done[0]}/{len(todo)} documents lus")
        return res

    with cf.ThreadPoolExecutor(8) as ex:
        list(ex.map(work, todo))
    return len(todo)


# ---------------------------------------------------------------- fusion des doublons
STOP = set("PROJET PROJETS DE DU DES LA LE LES L D SUR A AU AUX ET EN COMMUNE CENTRALE PARC PHOTOVOLTAIQUE PHOTOVOLTAIQUES SOLAIRE AU SOL EOLIEN EOLIENNES "
           "AGRIVOLTAIQUE CONSTRUCTION CREATION IMPLANTATION INSTALLATION EXPLOITATION DEMANDE AVIS SAS SARL SOCIETE ENERGIE ENERGIES".split())


def words(s):
    return {w for w in norm(s).split() if len(w) > 2 and w not in STOP and not w.isdigit()}


def merge(projects):
    n = len(projects)
    parent = list(range(n))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    cells = defaultdict(list)
    for i, p in enumerate(projects):
        cells[(round(p["lat"] * 20), round(p["lon"] * 20))].append(i)
    for i, p in enumerate(projects):
        cx, cy = round(p["lat"] * 20), round(p["lon"] * 20)
        wi = words(p["n"])
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for j in cells.get((cx + dx, cy + dy), []):
                    if j <= i or find(i) == find(j):
                        continue
                    q = projects[j]
                    if not set(p["t"]) & set(q["t"]):
                        continue
                    d = hav((p["lat"], p["lon"]), (q["lat"], q["lon"]))
                    same_com = p.get("insee") and p.get("insee") == q.get("insee")
                    wj = words(q["n"])
                    jac = len(wi & wj) / max(1, len(wi | wj))
                    pm, qm = p.get("mw"), q.get("mw")
                    close_mw = pm and qm and abs(pm - qm) <= 0.2 * max(pm, qm)
                    if (d <= 4 or same_com) and (jac >= 0.34 or close_mw or (same_com and (not pm or not qm) and jac >= 0.15)):
                        parent[find(j)] = find(i)
    groups = defaultdict(list)
    for i in range(n):
        groups[find(i)].append(projects[i])
    out = []
    for g in groups.values():
        g.sort(key=lambda p: (p["geo"] != "p", p["src"] != "PE"))
        m = dict(g[0])
        m["src"] = sorted({p["src"] for p in g})
        m["t"] = sorted({t for p in g for t in p["t"]}, key=["pv", "eol", "bess"].index)
        m["d"] = max((p.get("d") or "") for p in g)
        best = max(g, key=lambda p: (p.get("d") or ""))
        m["st"] = best["st"]
        m["pr"] = " · ".join(dict.fromkeys(p["pr"] for p in g if p.get("pr")))
        m["mw"] = next((p["mw"] for p in g if p.get("mw")), None)
        m["mwh"] = next((p["mwh"] for p in g if p.get("mwh")), None)
        rac, seen = [], set()
        for p in sorted(g, key=lambda p: -(len(p.get("rac") or []) > 0)):
            for r in p.get("rac") or []:
                if r[0] not in seen:
                    seen.add(r[0]); rac.append(r)
        m["rac"] = rac
        m["x"] = next((p["x"] for p in g if p.get("x")), None)
        m["raw"] = next((p["raw"] for p in g if p.get("raw")), [])
        links, seenu = [], set()
        for p in g:
            for l, u in p["links"]:
                if u not in seenu:
                    seenu.add(u); links.append((l, u))
        m["links"] = links[:7]
        m["ids"] = [p["id"] for p in g]
        out.append(m)
    return out


# ---------------------------------------------------------------- programme
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="pe,novae,mrae,pref")
    ap.add_argument("--depts", default="")
    ap.add_argument("--max-docs", type=int, default=2500)
    ap.add_argument("--budget-min", type=float, default=240, help="durée maximale de la collecte, en minutes")
    a = ap.parse_args()
    only = set(a.only.split(","))
    depts = set(x.strip() for x in a.depts.split(",") if x.strip()) or None

    cpath = os.path.join(DATA, "projets-cache.json")
    try:
        cache = json.load(open(cpath, encoding="utf-8"))
    except Exception:
        cache = {}
    geo = Geo(cache)
    postes = Postes()
    t0 = time.time()
    meta = {"collecte": TODAY.isoformat(), "depuis": CUTOFF.isoformat(), "sources": {}}

    projects = []
    for name, fn in [("pe", lambda: src_pe(geo)), ("novae", lambda: src_novae(geo, cache)), ("mrae", lambda: src_mrae(geo))]:
        if name in only:
            try:
                r = fn()
                projects += r
                meta["sources"][name] = len(r)
            except Exception as e:
                log(f"Source {name} indisponible : {e}")
                meta["sources"][name] = f"erreur : {str(e)[:120]}"
    if "pref" in only:
        try:
            r, st = src_pref(geo, cache, depts)
            projects += r
            meta["sources"]["pref"] = len(r)
            meta["prefectures"] = st
        except Exception as e:
            log(f"Source préfectures indisponible : {e}")
            meta["sources"]["pref"] = f"erreur : {str(e)[:120]}"
    log(f"Total avant lecture des documents : {len(projects)} ({time.time() - t0:.0f} s)")

    meta["documents_lus"] = analyse_docs(projects, postes, cache, a.max_docs, t0 + a.budget_min * 60)
    meta["documents_en_attente"] = sum(1 for p in projects for _, u in p["docs"] if u not in cache.get("docs", {}))
    dc = cache.get("docs", {})
    for p in projects:
        mw0, mwh0 = power_of(p["n"] + " . " + p.get("desc", ""), prefer_context=False)
        p["mw"], p["mwh"], p["rac"], p["x"], p["raw"] = mw0, mwh0, [], None, []
        for lab, u in p["docs"]:
            r = dc.get(u)
            if not r or not r.get("ok"):
                continue
            if p["mw"] is None and r.get("mw"):
                p["mw"] = r["mw"]
            if p["mwh"] is None and r.get("mwh") and "bess" in p["t"]:
                p["mwh"] = r["mwh"]
            if r.get("rac") and not p["rac"]:
                p["rac"], p["x"], p["rf"] = r["rac"], r.get("x"), lab
            if not p["raw"] and r.get("raw"):
                p["raw"] = r["raw"]
    merged = merge(projects)

    pidx = {x["k"]: x for x in postes.items}
    final = []
    for i, m in enumerate(sorted(merged, key=lambda p: p.get("d") or "", reverse=True)):
        if m.get("mw") is not None and m["mw"] < 1:
            continue  # moins de 1 MW
        rac = []
        for k, km in m["rac"][:4]:
            p = pidx.get(k)
            if p:
                rac.append({"k": k, "n": p["n"], "km": km})
        final.append({
            "id": i, "n": m["n"], "t": m["t"], "mw": round(m["mw"], 2) if m.get("mw") else None, "mwh": round(m["mwh"], 1) if m.get("mwh") else None,
            "lat": round(m["lat"], 5), "lon": round(m["lon"], 5), "geo": m["geo"], "com": m.get("com"), "dep": m.get("dep"),
            "d": m.get("d"), "st": m.get("st"), "pr": m.get("pr"), "src": m["src"], "l": [[l, u] for l, u in m["links"]],
            "rac": rac, "x": (m.get("x") or "")[:260] or None, "raw": m.get("raw") or [],
        })
    c = Counter()
    for p in final:
        c["total"] += 1
        c["avec_poste"] += bool(p["rac"])
        c["puissance_inconnue"] += p["mw"] is None
        for t in p["t"]:
            c[t] += 1
    meta["projets"] = dict(c)
    meta["duree_s"] = round(time.time() - t0)
    log("Bilan :", json.dumps(meta["projets"], ensure_ascii=False))

    with open(os.path.join(DATA, "projets.json"), "w", encoding="utf-8") as f:
        json.dump(final, f, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(DATA, "projets-meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
    with open(cpath, "w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False, separators=(",", ":"))


if __name__ == "__main__":
    main()
