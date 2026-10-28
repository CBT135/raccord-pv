/* Raccord PV — pré-étude de raccordement en injection.
 * Sources : capareseau.fr (instantané data/postes.json), projets-environnement.gouv.fr (API live),
 * Géoplateforme IGN (itinéraire piéton, géocodage, fonds), OSRM (itinéraire de secours). */
(() => {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const API_PROJ = "https://www.projets-environnement.gouv.fr/api/explore/v2.1/catalog/datasets/projets-environnement-diffusion/records";
  const IGN_ROUTE = "https://data.geopf.fr/navigation/itineraire";
  const OSRM_FOOT = "https://routing.openstreetmap.de/routed-foot/route/v1/foot/";
  const GEOCODE = "https://data.geopf.fr/geocodage/search";
  const PV_RE = /photovolta|solaire|agrivolta|\bPV\b|ombri[eè]re/i;

  const state = { postes: [], meta: null, site: null, results: [], sel: 0, localProj: [], importedProj: [], projects: [], routeSeq: 0,
    corr: {}, corrRepo: {}, lastDrag: 0, corrError: null, reporting: null, collected: [], projMeta: null, live: null, liveSig: null, liveErr: null };
  const LS_CORR = "raccordpv.positions"; // positions corrigées dans ce navigateur

  /* ---------- utilitaires ---------- */
  const num = (v) => { if (v === undefined || v === null || v === "") return null; const n = parseFloat(String(v).replace(",", ".").replace(/[^\d.\-]/g, "")); return Number.isFinite(n) ? n : null; };
  const fmt = (n, d = 1) => n === null || n === undefined || !Number.isFinite(n) ? "—" : n.toLocaleString("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d });
  const km = (m) => m === null || m === undefined ? "—" : (m >= 10000 ? fmt(m / 1000, 1) : fmt(m / 1000, 2)) + " km";
  const keur = (e) => !Number.isFinite(e) ? "—" : (e >= 1e6 ? fmt(e / 1e6, 2) + " M€" : fmt(e / 1e3, 0) + " k€");
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  function haversine(a, b) {
    const R = 6371008.8, r = Math.PI / 180;
    const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  const params = () => ({
    p: Math.max(0.1, num($("#p").value) || 10), n: parseInt($("#n").value, 10) || 5,
    minCap: Math.max(0, num($("#minCap").value) || 0), radius: Math.min(80, Math.max(2, num($("#radius").value) || 20)),
    withCap: $("#withCap").checked, withRte: $("#withRte").checked, projYears: $("#projYears").checked,
    cMl: num($("#cMl").value) ?? 140, cMl2: num($("#cMl2").value) ?? 230,
    pDep: Math.max(1, num($("#pDep").value) || 17), cCell: (num($("#cCell").value) ?? 90) * 1e3,
    cMlB: num($("#cMlB").value) ?? 110, cMl2B: num($("#cMl2B").value) ?? 190,
    cPdl: (num($("#cPdl").value) ?? 180) * 1e3, kDet: num($("#kDet").value) || 1.3,
    kV: Math.min(36, Math.max(5, num($("#kV").value) || 20)), duMax: Math.max(0.5, num($("#duMax").value) || 6),
    tphi: Math.max(-1, Math.min(1, num($("#tphi").value) ?? 0)), kIz: Math.max(0.3, num($("#kIz").value) || 1),
    p240: Math.max(0, num($("#p240").value) ?? 11.8),
  });
  const capOf = (p) => num(p.v.INFO_NA);
  function capClass(cap, P) { if (cap === null || cap <= 0) return "none"; return cap >= P ? "ok" : "part"; }
  const capColor = (cls) => css(cls === "ok" ? "--ok" : cls === "part" ? "--part" : "--none");
  const isGrd = (p) => !!(p.g1 || p.g2);

  /* ---------- positions corrigées des postes ----------
   * Ordre de priorité : data/postes-corrections.json (dépôt) < ce navigateur < lien (paramètre mv). */
  const keyOf = (p) => `${p.r}:${p.c}`;
  function loadLocalCorr() {
    try { const o = JSON.parse(localStorage.getItem(LS_CORR) || "{}"); return o && typeof o === "object" ? o : {}; } catch (_) { return {}; }
  }
  function saveLocalCorr() {
    // on ne garde dans le navigateur que ce qui diffère du fichier du dépôt
    const own = {};
    for (const [k, v] of Object.entries(state.corr)) { const r = state.corrRepo[k]; if (!r || r.lat !== v.lat || r.lon !== v.lon) own[k] = v; }
    for (const k of Object.keys(state.corrRepo)) if (!state.corr[k]) own[k] = null; // retour à la position Capareseau
    try { localStorage.setItem(LS_CORR, JSON.stringify(own)); } catch (_) {}
  }
  function mergeCorr(src) {
    for (const [k, v] of Object.entries(src || {})) {
      if (v === null) delete state.corr[k];
      else if (v && Number.isFinite(+v.lat) && Number.isFinite(+v.lon)) state.corr[k] = { lat: +(+v.lat).toFixed(6), lon: +(+v.lon).toFixed(6), n: v.n };
    }
  }
  function applyCorrections() {
    for (const p of state.postes) {
      if (p.lat0 === undefined) { p.lat0 = p.lat; p.lon0 = p.lon; }
      const c = state.corr[keyOf(p)];
      p.lat = c ? c.lat : p.lat0; p.lon = c ? c.lon : p.lon0; p.moved = !!c;
    }
    const nLocal = Object.keys(state.corr).filter((k) => { const r = state.corrRepo[k], v = state.corr[k]; return !r || r.lat !== v.lat || r.lon !== v.lon; }).length
      + Object.keys(state.corrRepo).filter((k) => !state.corr[k]).length;
    const b = $("#copyCorr");
    b.hidden = !nLocal;
    b.textContent = `Copier les positions corrigées (${nLocal} à enregistrer)`;
  }
  function setPosteLatLng(p, latlng) {
    if (latlng) state.corr[keyOf(p)] = { lat: +latlng.lat.toFixed(6), lon: +latlng.lng.toFixed(6), n: p.n };
    else delete state.corr[keyOf(p)];
    saveLocalCorr();
    applyCorrections();
    drawAllPostes();
    for (const r of state.results) if (r.p === p) { r.d = haversine(state.site, p); r.route = null; r.routeGeom = null; r.routeSrc = null; routeOne(r); }
    // reclassement par distance (même ordre qu'à l'ouverture d'un lien partagé), le poste déplacé reste sélectionné
    state.results.sort((a, b) => a.d - b.d);
    const i = state.results.findIndex((r) => r.p === p);
    if (i >= 0) state.sel = i;
    writeHash();
    refreshResults();
    refreshProjects();
  }

  /* ---------- carte ---------- */
  const ign = (layer, fmtImg = "image/png", style = "normal") =>
    `https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layer}&STYLE=${style}&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=${fmtImg}`;
  const ignAttr = '&copy; <a href="https://geoservices.ign.fr/" target="_blank" rel="noopener">IGN</a>';
  const base = {
    "Plan IGN": L.tileLayer(ign("GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2"), { maxZoom: 19, attribution: ignAttr }),
    "Photographies aériennes": L.tileLayer(ign("ORTHOIMAGERY.ORTHOPHOTOS", "image/jpeg"), { maxZoom: 19, attribution: ignAttr }),
    "OpenStreetMap": L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>' }),
  };
  const overlays = {
    "Cadastre": L.tileLayer(ign("CADASTRALPARCELS.PARCELLAIRE_EXPRESS", "image/png", "PCI vecteur"), { maxZoom: 19, minZoom: 13, attribution: ignAttr, opacity: 0.8 }),
  };
  const map = L.map("map", { zoomControl: true, preferCanvas: false }).setView([46.6, 2.5], 6);
  base["Plan IGN"].addTo(map);
  const canvas = L.canvas({ padding: 0.5 });
  const lyrAll = L.layerGroup().addTo(map);
  const lyrLinks = L.layerGroup().addTo(map);
  const lyrRoute = L.layerGroup().addTo(map);
  const lyrPostes = L.layerGroup().addTo(map);
  const lyrProj = L.layerGroup().addTo(map);
  const lyrRadius = L.layerGroup().addTo(map);
  overlays["Tous les postes Capareseau"] = lyrAll;
  overlays["Projets PV"] = lyrProj;
  L.control.layers(base, overlays, { collapsed: true }).addTo(map);
  L.control.scale({ imperial: false }).addTo(map);
  let siteMarker = null;
  // Carte ouverte dans un onglet masqué, rotation d'écran, redimensionnement : on remesure la carte,
  // et si elle avait une taille nulle, on recadre sur le site et les postes.
  let mapW = map.getContainer().clientWidth;
  if ("ResizeObserver" in window) new ResizeObserver(() => {
    const w = map.getContainer().clientWidth;
    map.invalidateSize();
    if (mapW === 0 && w > 0 && state.site && state.results.length)
      map.fitBounds(L.latLngBounds([[state.site.lat, state.site.lon], ...state.results.map((r) => [r.p.lat, r.p.lon])]).pad(0.15));
    mapW = w;
  }).observe(map.getContainer());

  function drawAllPostes() {
    lyrAll.clearLayers();
    const P = params().p;
    for (const p of state.postes) {
      const cls = capClass(capOf(p), P);
      L.circleMarker([p.lat, p.lon], { renderer: canvas, radius: 3.5, weight: 1, color: "#fff", fillColor: capColor(cls), fillOpacity: 0.85 })
        .bindTooltip(`${esc(p.n)} · ${fmt(capOf(p))} MW`, { direction: "top" })
        .on("click", (e) => { L.DomEvent.stopPropagation(e); showPostePopup(p, e.latlng); })
        .addTo(lyrAll);
    }
  }
  function showPostePopup(p, latlng) {
    L.popup().setLatLng(latlng || [p.lat, p.lon]).setContent(postePopupHtml(p)).openOn(map);
  }
  function postePopupHtml(p) {
    const v = p.v;
    return `<h3>${esc(p.n)}</h3><div class="pm">${esc(p.c)} · ${esc(p.g1 || "RTE")}${p.ht ? " · " + esc(p.ht) : ""}${p.pj === "1" ? " · poste en projet" : ""}</div>
      <div>Reste à affecter S3REnR : <b>${fmt(num(v.INFO_NA))} MW</b></div>
      <div>Capacité réservée : ${fmt(num(v.INFO_CR))} MW · remplissage ${esc(v.INFO_TX || "—")}</div>
      <div>File d'attente S3REnR : ${fmt(num(v.INFO_FAS3R))} MW · en service : ${fmt(num(v.INFO_ESS3R))} MW</div>
      <div>Quote-part : ${esc(v.INFO_QP || "—")}</div>
      <div class="pm">Capareseau, mise à jour ${esc(p.up || "—")}${p.moved ? " · position corrigée à la main" : ""}</div>`;
  }

  /* ---------- état dans l'URL ----------
   * #45.61000,5.15000&p=10&n=5&min=0&r=20&cap=1&rte=0&y=1&ml=160&dep=12&cell=120&pdl=90&k=1.3
   * Le site est facultatif ; les anciens liens « #lat,lon » restent valides. */
  const URL_FIELDS = [
    ["nom", "#nom"], ["p", "#p"], ["n", "#n"], ["min", "#minCap"], ["r", "#radius"],
    ["cap", "#withCap"], ["rte", "#withRte"], ["y", "#projYears"], ["tpv", "#t_pv"], ["teol", "#t_eol"], ["tbess", "#t_bess"], ["pu", "#projUnknown"],
    ["ml", "#cMl"], ["ml2", "#cMl2"], ["mlb", "#cMlB"], ["ml2b", "#cMl2B"], ["pcab", "#pDep"], ["cell", "#cCell"], ["pdl", "#cPdl"], ["k", "#kDet"], ["kv", "#kV"], ["du", "#duMax"], ["p240", "#p240"], ["tphi", "#tphi"], ["kiz", "#kIz"],
  ];
  const COST_KEYS = ["ml", "ml2", "mlb", "ml2b", "pcab", "cell", "pdl", "k"];
  const CAB_KEYS = ["kv", "du", "tphi", "kiz", "p240"];
  const DEFAULTS = Object.fromEntries(URL_FIELDS.map(([k, s]) => { const el = $(s); return [k, el.type === "checkbox" ? (el.checked ? "1" : "0") : el.value]; }));
  function setTitle() { const n = $("#nom").value.trim(); document.title = n ? `${n} · Raccord PV` : "Raccord PV"; }
  function writeHash() {
    const parts = [];
    if (state.site) parts.push(`${state.site.lat.toFixed(5)},${state.site.lon.toFixed(5)}`);
    for (const [k, s] of URL_FIELDS) {
      const el = $(s);
      const v = el.type === "checkbox" ? (el.checked ? "1" : "0") : el.type === "text" ? el.value.trim() : String(el.value).trim().replace(",", ".");
      if (v !== "") parts.push(`${k}=${encodeURIComponent(v)}`);
    }
    // positions corrigées des postes affichés, pour qu'un lien partagé donne les mêmes distances
    const shown = new Set(state.results.map((r) => keyOf(r.p)));
    const mv = Object.entries(state.corr).filter(([k]) => shown.has(k)).map(([k, v]) => `${k}:${v.lat}:${v.lon}`);
    if (mv.length) parts.push("mv=" + encodeURIComponent(mv.join(";")));
    try { history.replaceState(null, "", "#" + parts.join("&")); } catch (_) {}
  }
  function readHash() {
    let site = null, costChanged = false, cabChanged = false;
    for (const tok of location.hash.slice(1).split("&")) {
      if (!tok) continue;
      const eq = tok.indexOf("=");
      if (eq < 0) {
        const c = tok.split(",").map(Number);
        if (c.length === 2 && c.every(Number.isFinite) && Math.abs(c[0]) <= 90 && Math.abs(c[1]) <= 180) site = { lat: c[0], lon: c[1] };
        continue;
      }
      const k = tok.slice(0, eq);
      let raw; try { raw = decodeURIComponent(tok.slice(eq + 1)); } catch (_) { continue; }
      if (k === "mv") {
        const o = {};
        for (const item of raw.split(";")) {
          const a = item.split(":"); if (a.length < 4) continue;
          const lon = num(a.pop()), lat = num(a.pop());
          if (Number.isFinite(lat) && Number.isFinite(lon)) o[a.join(":")] = { lat, lon };
        }
        mergeCorr(o);
        continue;
      }
      const f = URL_FIELDS.find(([key]) => key === k); if (!f) continue;
      const el = $(f[1]);
      if (el.type === "checkbox") el.checked = raw === "1" || raw === "true";
      else if (el.tagName === "SELECT") { if ([...el.options].some((o) => o.value === raw)) el.value = raw; }
      else if (el.type === "text") el.value = raw.slice(0, 120);
      else if (Number.isFinite(num(raw))) el.value = num(raw);
      if (COST_KEYS.includes(k) && String(num(raw)) !== String(num(DEFAULTS[k]))) costChanged = true;
      if (CAB_KEYS.includes(k) && String(num(raw)) !== String(num(DEFAULTS[k]))) cabChanged = true;
    }
    if (costChanged) $(".hyp").open = true; // montre que des hypothèses non standard sont appliquées
    if (cabChanged) $("#hypCab").open = true;
    setTitle();
    return site;
  }

  /* ---------- placement du site ---------- */
  map.on("click", (e) => setSite(e.latlng.lat, e.latlng.lng, true));
  function setSite(lat, lon, fromClick = false) {
    state.site = { lat, lon };
    if (!siteMarker) {
      siteMarker = L.marker([lat, lon], { draggable: true, icon: L.divIcon({ className: "", html: '<div class="pin-site"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), zIndexOffset: 1000 })
        .addTo(map).bindTooltip("Site envisagé (déplaçable)");
      siteMarker.on("dragend", () => { const ll = siteMarker.getLatLng(); setSite(ll.lat, ll.lng, true); });
    } else siteMarker.setLatLng([lat, lon]);
    writeHash();
    analyse(!fromClick);
  }

  /* ---------- analyse ---------- */
  function nearest(site, P) {
    const pr = params();
    const cands = state.postes.filter((p) => (pr.withRte || isGrd(p)));
    const withD = cands.map((p) => ({ p, d: haversine(site, p) })).sort((a, b) => a.d - b.d);
    const ok = withD.filter(({ p }) => { const c = capOf(p); if (pr.withCap && !(c > 0)) return false; return (c ?? 0) >= pr.minCap; });
    const firstFull = withD.find(({ p }) => (capOf(p) ?? 0) >= P);
    return { list: ok.slice(0, pr.n), firstFull };
  }

  function analyse(fit) {
    if (!state.site || !state.postes.length) return;
    const pr = params();
    const { list, firstFull } = nearest(state.site, pr.p);
    state.results = list.map((x, i) => ({ ...x, i, route: null, routeSrc: null, routeGeom: null }));
    state.sel = 0;
    $("#site").textContent = `Site : ${state.site.lat.toFixed(5)}, ${state.site.lon.toFixed(5)}`;
    $("#hint").hidden = true;
    renderList(firstFull);
    drawPostes();
    writeHash(); // inclut les positions corrigées des postes affichés
    if (fit && state.results.length) {
      const b = L.latLngBounds([[state.site.lat, state.site.lon], ...state.results.map((r) => [r.p.lat, r.p.lon])]);
      map.fitBounds(b.pad(0.15));
    } else if (state.results.length) {
      const b = L.latLngBounds([[state.site.lat, state.site.lon], ...state.results.map((r) => [r.p.lat, r.p.lon])]);
      if (!map.getBounds().contains(b)) map.fitBounds(b.pad(0.15));
    }
    computeRoutes();
    loadProjects();
  }

  /* ---------- dimensionnement du câble HTA ----------
   * Câbles aluminium 12/20 kV (NF C 33-226), 3 câbles unipolaires en trèfle, enterrés.
   * R à 90 °C et X en Ω/km, Iz en A (pose enterrée, sol 20 °C, 1 K·m/W, un circuit) : valeurs typiques de catalogue.
   * Chute (élévation) de tension en injection : ΔU/U = (R·P + X·Q)·L / U², P et Q triphasés par départ, U composée.
   * Q = P·tan φ (tan φ < 0 : le producteur absorbe du réactif, ce qui réduit l'élévation de tension). */
  const CABLES = [
    { s: 240, r: 0.161, x: 0.11, iz: 375, prix: (pr) => pr.cMl, prixB: (pr) => pr.cMlB, pmax: (pr) => pr.p240 }, // 240 mm² : ≤ 11,8 MW par câble
    { s: 400, r: 0.102, x: 0.105, iz: 480, prix: (pr) => pr.cMl2, prixB: (pr) => pr.cMl2B, pmax: () => Infinity },
  ];
  /* Liaison : 17 MW au plus par câble ; au-delà, câbles doublés (parts égales), le premier au prix normal,
   * chaque câble supplémentaire au prix « câble doublé » (110 €/m en 240 mm², 190 €/m en 400 mm²).
   * Solution la moins chère respectant chute de tension, intensité admissible et limite du 240 mm². */
  function cableSizing(Pmw, Lkm, pr, depMin) {
    const U = pr.kV * 1e3;
    const calc = (n) => {
      const P = (Pmw * 1e6) / n, Q = P * pr.tphi, S = Math.hypot(P, Q), I = S / (Math.sqrt(3) * U);
      const rows = CABLES.map((c) => {
        const du = (100 * (c.r * P + c.x * Q) * Lkm) / (U * U);
        const izc = c.iz * pr.kIz, prix = c.prix(pr), prixB = c.prixB(pr);
        // un câble triphasé = une cellule départ au poste source + un poste de livraison
        const liaison = Lkm * 1000 * (prix + (n - 1) * prixB), cells = n * pr.cCell, pdls = n * pr.cPdl;
        return { s: c.s, r: c.r, x: c.x, iz: c.iz, izc, prix, prixB, du, okDu: Math.abs(du) <= pr.duMax, okI: I <= izc,
          okP: P / 1e6 <= c.pmax(pr) + 1e-9, loss: (100 * c.r * Lkm * S * S) / (U * U) / P, liaison, cells, pdls, cost: liaison + cells + pdls };
      }).map((c) => ({ ...c, ok: c.okDu && c.okI && c.okP }));
      return { n, P: P / 1e6, I, rows };
    };
    // autant de câbles que l'impose la limite par câble ; un câble de plus seulement si aucune section ne tient la chute de tension
    let best = null;
    for (let n = depMin; n <= depMin + 6 && !best; n++) {
      const r = calc(n);
      for (const c of r.rows) if (c.ok && (!best || c.cost < best.best.cost)) best = { ...r, best: c };
    }
    if (best) return { ...best, added: best.n - depMin, ref: calc(depMin), calc };
    const r = calc(depMin);
    return { ...r, best: null, added: 0, fail: true, ref: r, calc };
  }

  function costFor(r, pr) {
    const qp = num(r.p.v.INFO_QP); // k€/MW
    const L_m = r.route ?? r.d * pr.kDet;
    const depP = Math.ceil(pr.p / pr.pDep);
    const cab = cableSizing(pr.p, L_m / 1000, pr, depP);
    const dep = cab.fail ? depP : cab.n;
    const prixMl = cab.best ? cab.best.prix : pr.cMl2, prixMlB = cab.best ? cab.best.prixB : pr.cMl2B;
    const liaison = cab.best ? cab.best.liaison : L_m * (prixMl + (dep - 1) * prixMlB);
    const cell = dep * pr.cCell, pdl = dep * pr.cPdl;
    const qpart = qp !== null ? qp * 1e3 * pr.p : NaN;
    const raccord = liaison + cell + (Number.isFinite(qpart) ? qpart : 0);
    return { qp, L_m, dep, depP, cab, prixMl, prixMlB, liaison, cell, qpart, pdl, raccord, total: raccord + pdl, estimated: r.route === null };
  }

  function cabLine(c, pr) {
    const b = c.cab.best;
    if (!b) return `Câble : ni le 240 ni le 400 mm² ne tiennent ${fmt(pr.duMax, 1)} % de chute de tension, même avec ${c.dep + 6} câbles (${fmt(Math.abs(c.cab.rows.at(-1).du), 1)} % en 400 mm² avec ${c.dep} câble${c.dep > 1 ? "s" : ""})`;
    return `Câble${c.dep > 1 ? "s " + c.dep + " × " : " "}3×1×${b.s} mm² Alu · ΔU ${fmt(b.du, 1)} % · ${fmt(c.cab.I, 0)} A / ${fmt(b.izc, 0)} A · pertes ${fmt(b.loss, 1)} %`;
  }
  function cabTitle(c, pr) {
    return `${fmt(pr.kV, 1)} kV, ${fmt(c.cab.P, 2)} MW par câble, ${fmt(c.L_m / 1000, 2)} km, tan φ ${fmt(pr.tphi, 2)}\n` +
      c.cab.ref.rows.map((x) => `${c.cab.ref.n} câble${c.cab.ref.n > 1 ? "s" : ""} en ${x.s} mm² : ΔU ${fmt(x.du, 2)} %${x.okDu ? "" : " (trop)"} · Iz ${fmt(x.izc, 0)} A${x.okI ? "" : " (insuffisant)"}${x.okP ? "" : ` · réservé aux projets ≤ ${fmt(pr.p240, 1)} MW`} · ${keur(x.cost)}`).join("\n");
  }
  function renderList(firstFull) {
    const pr = params();
    const ol = $("#list");
    ol.innerHTML = "";
    if (!state.results.length) {
      ol.innerHTML = `<li class="notice">Aucun poste ne répond aux filtres. Baissez la capacité minimale ou décochez « uniquement avec capacité ».</li>`;
      $("#copy").hidden = true;
      return;
    }
    state.results.forEach((r, idx) => {
      const p = r.p, v = p.v, cap = capOf(p), cls = capClass(cap, pr.p), c = costFor(r, pr);
      const li = document.createElement("li");
      li.className = "poste" + (idx === state.sel ? " sel" : "");
      li.style.setProperty("--c", capColor(cls));
      li.tabIndex = 0;
      const chips = [];
      chips.push(`<span class="chip">${esc(p.g1 || "RTE")}${p.g2 ? " / " + esc(p.g2) : ""}</span>`);
      if (p.ht) chips.push(`<span class="chip">${esc(p.ht)}</span>`);
      if (p.moved) chips.push(`<span class="chip moved">position corrigée</span>`);
      if (p.pj === "1") chips.push(`<span class="chip warn">poste en projet S3REnR</span>`);
      if (cls === "part") chips.push(`<span class="chip warn">capacité &lt; ${fmt(pr.p)} MW</span>`);
      if (c.dep > 1) chips.push(`<span class="chip warn">câbles doublés (${c.dep} × ${fmt(c.cab.P, 1)} MW${c.cab.added ? ", chute de tension" : ""})</span>`);
      const gm = `https://www.google.com/maps/dir/?api=1&origin=${state.site.lat},${state.site.lon}&destination=${p.lat},${p.lon}&travelmode=walking`;
      const tvx = v.RTE_TVX && !/sans objet/i.test(v.RTE_TVX) ? `<div class="tvx">Travaux S3REnR : ${esc(v.RTE_TVX)}</div>` : "";
      li.innerHTML = `
        <div class="t"><div class="name"><span class="rank">${idx + 1}</span>${esc(p.n)}</div><div class="cap">${fmt(cap)} MW</div></div>
        <div class="kv">
          <div><span>Vol d'oiseau</span><b>${km(r.d)}</b></div>
          <div><span>Trajet piéton</span><b class="rt">${r.route !== null ? km(r.route) : (r.routeSrc === "err" ? "indispo." : "calcul…")}</b></div>
          <div><span>Remplissage</span><b>${esc(v.INFO_TX || "—")}</b></div>
          <div><span>Réservée S3REnR</span><b>${fmt(num(v.INFO_CR))} MW</b></div>
          <div><span>File d'attente</span><b>${fmt(num(v.INFO_FAS3R))} MW</b></div>
          <div><span>Quote-part</span><b>${c.qp !== null ? fmt(c.qp, 2) + " k€/MW" : "—"}</b></div>
        </div>
        <div class="chips">${chips.join("")}</div>
        ${tvx}
        <div class="cost">
          <div class="row"><span>Quote-part S3REnR (${fmt(pr.p)} MW)</span><b>${keur(c.qpart)}</b></div>
          <div class="row"><span>Liaison HTA ${km(c.L_m)}${c.estimated ? " (estimée)" : ""} à ${fmt(c.prixMl, 0)} €/m${c.dep > 1 ? ` + ${c.dep > 2 ? c.dep - 1 + " × " : ""}${fmt(c.prixMlB, 0)} €/m (câble doublé)` : ""}</span><b>${keur(c.liaison)}</b></div>
          <div class="cab${c.cab.fail ? " fail" : ""}" title="${esc(cabTitle(c, pr))}">${cabLine(c, pr)}</div>
          <div class="row"><span>${c.dep > 1 ? c.dep + " cellules" : "Cellule"} départ poste source</span><b>${keur(c.cell)}</b></div>
          <div class="row tot"><span>Raccordement indicatif</span><b>${keur(c.raccord)}</b></div>
          <div class="row"><span>+ ${c.dep > 1 ? c.dep + " postes" : "poste"} de livraison</span><b>${keur(c.total)}</b></div>
        </div>
        <div class="links"><button type="button" class="ghost rep"${state.reporting !== null ? " disabled" : ""}>${state.reporting === idx ? "Rapport en cours…" : "Rapport PDF"}</button><a href="${gm}" target="_blank" rel="noopener">Itinéraire Google Maps</a><a href="https://www.capareseau.fr/region/${esc(p.r)}?postCode=${encodeURIComponent(p.c)}" target="_blank" rel="noopener">Fiche Capareseau</a>${p.moved ? `<button type="button" class="linkbtn reset">Rétablir la position Capareseau</button>` : ""}<span class="pm">màj ${esc(p.up || "—")}</span></div>`;
      li.querySelector(".reset")?.addEventListener("click", (e) => { e.stopPropagation(); setPosteLatLng(p, null); });
      li.querySelector(".rep").addEventListener("click", (e) => { e.stopPropagation(); report(idx, e.currentTarget); });
      li.addEventListener("click", (e) => { if (e.target.closest("a, button")) return; select(idx); });
      li.addEventListener("keydown", (e) => { if (e.key === "Enter") select(idx); });
      ol.appendChild(li);
    });
    if (firstFull && !state.results.some((r) => r.p === firstFull.p)) {
      const li = document.createElement("li");
      li.className = "notice";
      li.innerHTML = `Aucun de ces postes n'a ${fmt(pr.p)} MW restants. Le plus proche qui les a : <b>${esc(firstFull.p.n)}</b> (${fmt(capOf(firstFull.p))} MW) à ${km(firstFull.d)} à vol d'oiseau.`;
      ol.appendChild(li);
    }
    $("#copy").hidden = false;
    $("#dragHint").hidden = false;
  }
  /* ---------- rapport PDF ---------- */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function reportData(idx) {
    const pr = params();
    const baseName = Object.keys(base).find((k) => map.hasLayer(base[k])) || "Plan IGN";
    return {
      nom: $("#nom").value.trim(), p: pr.p, pr, site: { ...state.site }, sel: idx, projYears: pr.projYears,
      base: baseName.startsWith("Photo") ? "ortho" : baseName === "OpenStreetMap" ? "osm" : "plan",
      postes: state.results.map((r) => {
        const p = r.p, cap = capOf(p);
        return { nom: p.n, code: p.c, r: p.r, grd: [p.g1 || "RTE", p.g2].filter(Boolean).join(" / "), ht: p.ht, pj: p.pj, up: p.up, moved: !!p.moved,
          lat: p.lat, lon: p.lon, v: p.v, cap, cls: capClass(cap, pr.p), d: r.d, route: r.route, routeSrc: r.routeSrc, routeGeom: r.routeGeom, cost: costFor(r, pr) };
      }),
      projets: state.projects.map((x) => ({ label: x.label, kind: x.kind, n: x.n, t: x.t, mw: x.mw, mwh: x.mwh, st: x.st, pr: x.pr, date: x.d, com: x.com, dep: x.dep,
        d: x.d0, dP: x.dP, lat: x.lat, lon: x.lon, same: x.same, geo: x.geo, rac: x.rac.map((r) => r.n + (r.km ? ` (${fmt(r.km, 0)} km)` : "")), src: x.src })),
      zone: (() => { const A = projArea(); return { R: A.R, centers: A.centers, rings: unionRings(A.centers, A.R) }; })(),
      projMeta: state.projMeta,
      cableAt: (n) => { const r = state.results[idx]; const c = costFor(r, pr); return c.cab.calc(n).rows; },
      regionNom: (code) => state.meta?.regions?.[code]?.nom || code,
      extraction: state.meta ? new Date(state.meta.extraction).toLocaleDateString("fr-FR") : null,
      url: location.href,
    };
  }
  async function report(idx, btn) {
    if (state.reporting !== null || !window.RaccordReport) return;
    if (state.sel !== idx) select(idx); // zone et projets voisins calculés pour ce poste
    state.reporting = idx; refreshResults();
    let msg = null;
    try {
      const r = state.results[idx], t0 = Date.now();
      while (r && r.routeSrc === null && Date.now() - t0 < 10000) await sleep(250); // laisse finir le calcul d'itinéraire
      await window.RaccordReport.generate(reportData(state.results.indexOf(r)));
    } catch (e) { msg = `Rapport impossible : ${e.message || e}`; }
    state.reporting = null; refreshResults();
    if (msg) { const b = document.querySelectorAll("#list .poste .rep")[idx]; if (b) { b.textContent = msg; setTimeout(refreshResults, 5000); } }
  }

  function refreshResults() {
    if (!state.site) return;
    renderList(nearest(state.site, params().p).firstFull);
    document.querySelectorAll("#list .poste").forEach((el, i) => el.classList.toggle("sel", i === state.sel));
    drawPostes();
  }

  function drawPostes() {
    lyrPostes.clearLayers(); lyrLinks.clearLayers(); lyrRoute.clearLayers();
    const pr = params();
    state.results.forEach((r, idx) => {
      const cls = capClass(capOf(r.p), pr.p), col = capColor(cls);
      const line = L.polyline([[state.site.lat, state.site.lon], [r.p.lat, r.p.lon]], { color: col, weight: idx === state.sel ? 2.5 : 1.5, dashArray: "6 6", opacity: 0.9, interactive: false }).addTo(lyrLinks);
      const html = `<div class="pin-poste${r.p.moved ? " moved" : ""}" style="--c:${col}"><div class="pt"></div><div class="lab">${idx + 1} · ${fmt(capOf(r.p))} MW</div></div>`;
      L.marker([r.p.lat, r.p.lon], { icon: L.divIcon({ className: "", html, iconSize: [0, 0] }), zIndexOffset: 500 - idx, draggable: true, autoPan: true })
        .bindTooltip(r.p.moved ? "Position corrigée — glisser pour ajuster" : "Glisser pour corriger la position", { direction: "bottom", offset: [0, 12] })
        .on("dragstart", () => map.closePopup())
        .on("drag", (e) => line.setLatLngs([[state.site.lat, state.site.lon], e.target.getLatLng()]))
        .on("dragend", (e) => { state.lastDrag = Date.now(); setPosteLatLng(r.p, e.target.getLatLng()); })
        .on("click", () => { if (Date.now() - state.lastDrag > 400) select(idx); })
        .bindPopup(postePopupHtml(r.p)).addTo(lyrPostes);
      if (r.routeGeom) {
        L.geoJSON(r.routeGeom, { style: { color: idx === state.sel ? css("--accent") : col, weight: idx === state.sel ? 5 : 2.5, opacity: idx === state.sel ? 0.9 : 0.45 } }).addTo(lyrRoute);
      }
    });
  }
  function select(idx) {
    state.sel = idx;
    document.querySelectorAll("#list .poste").forEach((el, i) => el.classList.toggle("sel", i === idx));
    drawPostes();
    refreshProjects();
    const r = state.results[idx];
    if (r) {
      const pts = [[state.site.lat, state.site.lon], [r.p.lat, r.p.lon]];
      if (r.routeGeom) L.geoJSON(r.routeGeom).getLayers().forEach((l) => l.getLatLngs && pts.push(...l.getLatLngs().flat(2)));
      map.fitBounds(L.latLngBounds(pts).pad(0.2));
    }
  }

  /* ---------- itinéraires ---------- */
  async function routeIGN(a, b) {
    const u = `${IGN_ROUTE}?resource=bdtopo-pgr&profile=pedestrian&optimization=shortest&start=${a.lon},${a.lat}&end=${b.lon},${b.lat}&geometryFormat=geojson&getSteps=false&distanceUnit=meter`;
    const r = await fetch(u); if (!r.ok) throw new Error("IGN " + r.status);
    const j = await r.json();
    let d = num(j.distance); if (d === null) throw new Error("IGN sans distance");
    if (/kilo/i.test(j.distanceUnit || "")) d *= 1000;
    return { d, geom: j.geometry, src: "IGN" };
  }
  async function routeOSRM(a, b) {
    const r = await fetch(`${OSRM_FOOT}${a.lon},${a.lat};${b.lon},${b.lat}?overview=full&geometries=geojson`);
    if (!r.ok) throw new Error("OSRM " + r.status);
    const j = await r.json(); if (j.code !== "Ok" || !j.routes?.length) throw new Error("OSRM " + j.code);
    return { d: j.routes[0].distance, geom: j.routes[0].geometry, src: "OSM" };
  }
  let routeTok = 0;
  async function fetchRoute(a, b) {
    try { return await routeIGN(a, b); } catch (_) { try { return await routeOSRM(a, b); } catch (__) { return null; } }
  }
  async function computeRoutes() {
    const seq = ++state.routeSeq;
    for (const r of state.results) {
      await routeOne(r);
      if (seq !== state.routeSeq) return; // un autre calcul a démarré
    }
  }
  // (re)calcule l'itinéraire d'un poste ; ignoré si le poste ou le site a bougé entre-temps
  async function routeOne(r) {
    const tok = (r.tok = ++routeTok), site = state.site, to = { lat: r.p.lat, lon: r.p.lon };
    const res = await fetchRoute(site, to);
    if (r.tok !== tok || state.site !== site || !state.results.includes(r)) return;
    if (res) { r.route = res.d; r.routeGeom = res.geom; r.routeSrc = res.src; } else { r.routeSrc = "err"; }
    refreshResults();
  }

  /* ---------- projets voisins (PV, éolien, stockage ≥ 1 MW) ----------
   * Source principale : data/projets.json (collecte hebdomadaire : projets-environnement, avis MRAe, préfectures),
   * complété par data/projets-locaux.geojson et les fichiers importés. À défaut de collecte, interrogation directe
   * de projets-environnement.gouv.fr.
   * Zone : union des cercles de rayon R autour du site et du poste sélectionné. */
  const TYPES = { pv: "PV", eol: "Éolien", bess: "Stockage" };
  const TYPE_RX = {
    eol: /[ée]olien|a[ée]rog[ée]n[ée]rateur/i,
    bess: /stockage (?:d['’ ]?)?(?:[ée]nergie|[ée]lectricit[ée]|par batterie)|batteries? de stockage|\bBESS\b|stockage par batteries?|syst[èe]me de stockage/i,
    pv: /photovolta|agrivolta|agrisolaire|centrale solaire|parc solaire|ferme solaire|ombri[èe]re|solaire flottant|solaire au sol/i,
  };
  const typesOf = (txt) => Object.keys(TYPE_RX).filter((k) => TYPE_RX[k].test(txt || "")).sort((a, b) => ["pv", "eol", "bess"].indexOf(a) - ["pv", "eol", "bess"].indexOf(b));
  function mwOf(txt) {
    const t = String(txt || "").replace(/[  ]/g, " ");
    const m = t.match(/(\d{1,3}(?: \d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?)\s*(GWc?|MWc|MWp|MWe|MW|kWc|kWp|kW)\b(?!\s*h)/i);
    if (!m) return null;
    let v = parseFloat(m[1].replace(/ /g, "").replace(",", "."));
    const u = m[2].toLowerCase();
    if (u.startsWith("k")) v /= 1000; else if (u.startsWith("g")) v *= 1000;
    return Number.isFinite(v) ? v : null;
  }
  const normName = (s) => String(s || "").replace(/[’'`´]/g, " ").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase()
    .replace(/\(.*?\)/g, " ").replace(/[^A-Z0-9]+/g, " ").replace(/\bSTE\b/g, "SAINTE").replace(/\bST\b/g, "SAINT").replace(/\bMT\b/g, "MONT").replace(/\s+/g, " ").trim();
  // « Pons », « 75:PONS » ou « PONS, JONZAC » → postes Capareseau proches (60 km)
  function postesFromText(txt, lat, lon) {
    const out = [];
    for (const part of String(txt || "").split(/[;,/]|\bou\b/i).map((x) => x.trim()).filter(Boolean)) {
      const byKey = state.postes.find((p) => keyOf(p) === part.toUpperCase());
      const nn = normName(part);
      const hit = byKey || state.postes.filter((p) => normName(p.n) === nn).sort((a, b) => haversine({ lat, lon }, a) - haversine({ lat, lon }, b))[0];
      if (hit && haversine({ lat, lon }, hit) < 60000 && !out.some((r) => r.k === keyOf(hit))) out.push({ k: keyOf(hit), n: hit.n, km: null });
    }
    return out;
  }
  const projOf = (o) => ({ t: [], mw: null, mwh: null, geo: "p", com: null, dep: null, d: "", st: "", pr: "", src: [], l: [], rac: [], x: null, raw: [], ...o });

  function projArea() {
    const R = params().radius * 1000, sel = state.results[state.sel] || null;
    const centers = [{ lat: state.site.lat, lon: state.site.lon }];
    if (sel) centers.push({ lat: sel.p.lat, lon: sel.p.lon });
    return { R, centers, sel };
  }
  // contour de l'union de deux cercles (repère local en mètres)
  function unionRings(centers, R) {
    const c0 = centers[0], k = Math.cos((c0.lat * Math.PI) / 180);
    const toXY = (c) => [(c.lon - c0.lon) * 111320 * k, (c.lat - c0.lat) * 110574];
    const toLL = ([x, y]) => [c0.lat + y / 110574, c0.lon + x / (111320 * k)];
    const N = 180, ring = (c) => { const [cx, cy] = toXY(c); return Array.from({ length: N }, (_, i) => [cx + R * Math.cos((2 * Math.PI * i) / N), cy + R * Math.sin((2 * Math.PI * i) / N)]); };
    if (centers.length < 2) return [ring(c0).map(toLL)];
    const [a, b] = centers.map(toXY), d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    if (d < 1) return [ring(c0).map(toLL)];
    if (d >= 2 * R) return centers.map((c) => ring(c).map(toLL));
    const ra = ring(centers[0]), rb = ring(centers[1]);
    const outside = (pts, o) => pts.map(([x, y]) => Math.hypot(x - o[0], y - o[1]) > R);
    const run = (pts, out) => { // portion hors de l'autre cercle, dans l'ordre trigonométrique
      const s = out.findIndex((v, i) => v && !out[(i - 1 + N) % N]);
      const r = []; for (let i = 0; i < N && out[(s + i) % N]; i++) r.push(pts[(s + i) % N]);
      return r;
    };
    return [[...run(ra, outside(ra, b)), ...run(rb, outside(rb, a))].map(toLL)];
  }

  // repli : interrogation directe de projets-environnement.gouv.fr tant que la collecte n'existe pas
  async function liveFallback(A) {
    const sig = A.centers.map((c) => c.lat.toFixed(3) + "," + c.lon.toFixed(3)).join(";") + "|" + A.R;
    if (state.liveSig === sig) return;
    state.liveSig = sig; state.live = [];
    const zone = A.centers.map((c) => `within_distance(geo_point_2d, geom'POINT(${c.lon.toFixed(5)} ${c.lat.toFixed(5)})', ${A.R / 1000}km)`).join(" or ");
    const where = `(${zone}) and (search("photovolta") or search("solaire") or search("agrivolta") or search("éolien") or search("aérogénérateur") or search("stockage"))`;
    const sel = "dc_title,descriptif_du_projet,dc_type,vp_status,dc_date,dc_location,geo_point_2d,dc_relation_decision,dc_relation_expertise_avisae,dc_relation_synthesis,dc_relation_informationnote,dc_relation_websitedebate,dc_subject_category,recordsid";
    try {
      const j = await fetch(API_PROJ + "?" + new URLSearchParams({ where, select: sel, limit: "100", order_by: "dc_date desc" })).then((r) => r.json());
      state.live = (j.results || []).filter((x) => x.geo_point_2d).map((x) => {
        const t = typesOf([x.dc_title, x.descriptif_du_projet, x.dc_subject_category].flat().join(" "));
        return projOf({ kind: "pe", id: "pe:" + x.recordsid, n: x.dc_title, t, mw: mwOf(x.descriptif_du_projet) ?? mwOf(x.dc_title),
          lat: x.geo_point_2d.lat, lon: x.geo_point_2d.lon, dep: (x.dc_location || "").slice(0, 2), d: (x.dc_date || "").slice(0, 10),
          st: x.vp_status === "ouvert" ? "Consultation du public en cours" : x.dc_relation_decision ? "Décision publiée" : x.dc_relation_expertise_avisae ? "Avis AE publié" : "Dossier publié",
          pr: [].concat(x.dc_type || []).join(", "), src: ["PE"],
          l: [["Avis AE", x.dc_relation_expertise_avisae], ["Résumé non technique", x.dc_relation_synthesis], ["Décision", x.dc_relation_decision], ["Page préfecture", x.dc_relation_informationnote || x.dc_relation_websitedebate]].filter((l) => l[1] && /^https?:/.test(l[1])) });
      }).filter((p) => p.t.length);
    } catch (e) { state.liveErr = e.message || String(e); }
    refreshProjects();
  }

  function refreshProjects() {
    if (!state.site) return;
    const pr = params(), A = projArea(), selKey = A.sel ? keyOf(A.sel.p) : null;
    const types = ["pv", "eol", "bess"].filter((t) => $("#t_" + t).checked);
    const withUnknown = $("#projUnknown").checked;
    const cut = new Date(); cut.setFullYear(cut.getFullYear() - 5); const cutoff = cut.toISOString().slice(0, 10);
    if (!state.collected.length) liveFallback(A);
    const pool = [...(state.collected.length ? state.collected : state.live || []), ...state.localProj, ...state.importedProj];
    state.projects = [];
    for (const p of pool) {
      if (p.mw !== null && p.mw < 1) continue;
      if (p.mw === null && !withUnknown) continue;
      if (!p.t.some((t) => types.includes(t)) && p.t.length) continue;
      if (pr.projYears && (p.kind === "collecte" || p.kind === "pe") && p.d && p.d < cutoff) continue;
      const dS = haversine(state.site, p), dP = A.sel ? haversine(A.sel.p, p) : Infinity;
      if (Math.min(dS, dP) > A.R) continue;
      const same = !!selKey && p.rac.some((r) => r.k === selKey);
      state.projects.push({ ...p, d0: dS, dP, same });
    }
    state.projects.sort((a, b) => (b.same - a.same) || (Math.min(a.d0, a.dP) - Math.min(b.d0, b.dP)));
    state.projects.forEach((p, i) => (p.label = "P" + (i + 1)));
    drawProjects(A);
  }
  // compat : appelé par analyse()
  const loadProjects = () => refreshProjects();

  const fmtMW = (p) => (p.mw !== null && p.mw !== undefined ? `${fmt(p.mw, p.mw < 10 ? 1 : 0)} MW` : "puissance non renseignée") + (p.mwh ? ` / ${fmt(p.mwh, 0)} MWh` : "");
  function racHtml(p, selKey) {
    if (!p.rac.length) return p.raw && p.raw.length ? `<div class="rac">Poste cité, absent de Capareseau : ${esc(p.raw.join(", "))}</div>` : `<div class="rac pm">Poste de raccordement non indiqué dans les documents lus</div>`;
    return `<div class="rac">Raccordement envisagé : ${p.rac.map((r, i) => `<b class="${r.k === selKey ? "hit" : ""}">${esc(r.n)}</b>${r.km ? ` (${fmt(r.km, 0)} km)` : ""}${p.rac.length > 1 && i === 0 ? "" : ""}`).join(p.rac.length > 1 ? " ou " : "")}${p.rac.length > 1 ? " (options)" : ""}</div>`;
  }
  function projTip(p, selKey) {
    const ty = p.t.map((t) => `<span class="tchip t-${t}">${TYPES[t]}</span>`).join("");
    return `<div class="ptip-in${p.same ? " same" : ""}">
      ${p.same ? `<div class="flag">Raccordement envisagé sur le poste étudié</div>` : ""}
      <div class="pt">${esc(p.n)}</div>
      <div>${ty} <b>${fmtMW(p)}</b>${p.com ? " · " + esc(p.com) : ""}${p.dep ? ` (${esc(p.dep)})` : ""}</div>
      <div class="pm">${esc(p.st || "")}${p.d ? " · " + esc(new Date(p.d).toLocaleDateString("fr-FR")) : ""}${p.pr && !String(p.st).includes(p.pr) ? " · " + esc(p.pr) : ""}</div>
      ${racHtml(p, selKey)}
      ${p.x ? `<div class="x">${esc(p.x.slice(0, 260))}</div>` : ""}
      <div class="pm">${km(p.d0)} du site${Number.isFinite(p.dP) ? ` · ${km(p.dP)} du poste étudié` : ""}${p.geo === "c" ? " · position approximative (centre de la commune)" : ""}${p.src.length ? " · " + esc(p.src.join(", ")) : ""}</div>
    </div>`;
  }
  function projPopup(p, selKey) {
    return projTip(p, selKey) + `<div class="plinks">${(p.l || []).map(([t, u]) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)}</a>`).join(" · ")}</div>`;
  }
  function drawProjects(A) {
    lyrProj.clearLayers(); lyrRadius.clearLayers();
    for (const ring of unionRings(A.centers, A.R))
      L.polygon(ring, { color: css("--proj"), weight: 1.4, dashArray: "5 6", fillColor: css("--proj"), fillOpacity: 0.04, interactive: false }).addTo(lyrRadius);
    const selKey = A.sel ? keyOf(A.sel.p) : null;
    const ul = $("#projList"); ul.innerHTML = "";
    const same = state.projects.filter((p) => p.same);
    // les projets sur le poste étudié sont dessinés en dernier (au-dessus)
    for (const p of [...state.projects].reverse()) {
      const t0 = p.t[0] || "pv", man = p.kind === "local" || p.kind === "import";
      if (p.same) L.polyline([[p.lat, p.lon], [A.sel.p.lat, A.sel.p.lon]], { color: css("--accent"), weight: 2, dashArray: "2 6", opacity: 0.9, interactive: false }).addTo(lyrProj);
      const sz = p.same ? 20 : 13;
      L.marker([p.lat, p.lon], {
        icon: L.divIcon({ className: "", html: `<div class="pin-p t-${t0}${p.same ? " same" : ""}${man ? " man" : ""}${p.geo === "c" ? " approx" : ""}"><span>${p.same ? "⚡" : ""}</span></div>`, iconSize: [sz, sz], iconAnchor: [sz / 2, sz / 2] }),
        zIndexOffset: p.same ? 400 : 0, keyboard: false,
      }).bindTooltip(projTip(p, selKey), { direction: "top", offset: [0, -sz / 2], className: "ptip", opacity: 1 })
        .bindPopup(projPopup(p, selKey), { maxWidth: 340 }).addTo(lyrProj);
    }
    state.projects.slice(0, 80).forEach((p) => {
      const li = document.createElement("li");
      li.className = "proj t-" + (p.t[0] || "pv") + (p.same ? " same" : "") + (p.kind === "local" || p.kind === "import" ? " loc" : "");
      li.innerHTML = `<div class="pt">${esc(p.label)} · ${esc(p.n)}</div>
        <div class="pm">${p.t.map((t) => TYPES[t]).join(" + ")} · ${fmtMW(p)} · ${esc(p.st || p.pr || "")}${p.d ? " · " + esc(p.d.slice(0, 7)) : ""} · ${km(Math.min(p.d0, p.dP))}</div>
        ${p.rac.length ? `<div class="pm">→ ${p.rac.map((r) => (r.k === selKey ? `<b>${esc(r.n)}</b>` : esc(r.n))).join(" ou ")}</div>` : ""}`;
      li.addEventListener("click", () => { map.setView([p.lat, p.lon], Math.max(map.getZoom(), 12)); lyrProj.eachLayer((l) => { if (l.getLatLng && l.getLatLng().lat === p.lat && l.getLatLng().lng === p.lon) l.openPopup(); }); });
      ul.appendChild(li);
    });
    // bilan
    const pr = params(), n = state.projects.length, byT = (t) => state.projects.filter((p) => p.t.includes(t)).length;
    const sumSame = same.reduce((a, p) => a + (p.mw || 0), 0), unk = same.filter((p) => p.mw === null).length;
    const cap = A.sel ? capOf(A.sel.p) : null;
    const meta = state.projMeta;
    $("#projSummary").innerHTML = `
      <p>${n} projet${n > 1 ? "s" : ""} (PV ${byT("pv")}, éolien ${byT("eol")}, stockage ${byT("bess")}) dans un rayon de ${fmt(pr.radius, 0)} km autour du site${A.sel ? ` et du poste n° ${state.sel + 1} ${esc(A.sel.p.n)}` : ""}.${n > 80 ? " Liste limitée aux 80 plus proches." : ""}</p>
      ${A.sel ? `<p class="${same.length ? "samebox" : ""}">${same.length
        ? `<b>${same.length} projet${same.length > 1 ? "s" : ""} envisage${same.length > 1 ? "nt" : ""} un raccordement sur ${esc(A.sel.p.n)}</b> : ${fmt(sumSame, 1)} MW${unk ? ` + ${unk} de puissance non renseignée` : ""}, pour ${fmt(cap)} MW de capacité réservée restante.`
        : `Aucun projet du rayon ne cite ${esc(A.sel.p.n)} comme poste de raccordement dans les documents lus.`}</p>` : ""}
      ${meta ? "" : state.liveErr ? `<p class="notice">Collecte indisponible et projets-environnement.gouv.fr injoignable (${esc(state.liveErr)}).</p>` : `<p class="pm">Collecte hebdomadaire pas encore disponible : projets lus en direct sur projets-environnement.gouv.fr, sans poste de raccordement.</p>`}`;
  }

  /* projets ajoutés à la main : data/projets-locaux.geojson + import de fichiers
   * propriétés lues : nom, type (pv / éolien / stockage), puissance_mw (ou puissance_mwc), procedure, statut, date,
   * commune, poste_raccordement (nom du poste, ou « région:code »), source (URL), commentaire */
  function featureToProj(f, kind) {
    const g = f.geometry; if (!g) return null;
    let lat, lon;
    if (g.type === "Point") [lon, lat] = g.coordinates;
    else { const b = L.geoJSON(f).getBounds(); if (!b.isValid()) return null; ({ lat, lng: lon } = b.getCenter()); }
    const pp = f.properties || {};
    const t = typesOf(pp.type || "") .length ? typesOf(pp.type) : /eol|éol/i.test(pp.type || "") ? ["eol"] : /stock|bess|batt/i.test(pp.type || "") ? ["bess"] : typesOf((pp.nom || "") + " " + (pp.commentaire || "")).length ? typesOf((pp.nom || "") + " " + (pp.commentaire || "")) : ["pv"];
    const mw = num(pp.puissance_mw ?? pp.puissance_mwc ?? pp.puissance);
    return projOf({ kind, id: kind + ":" + (pp.nom || lat + "," + lon), n: pp.nom || pp.name || pp.titre || "Projet", t, mw, lat, lon, geo: "p",
      com: pp.commune || null, d: pp.date || "", st: pp.statut || "", pr: pp.procedure || "", src: [kind === "local" ? "Projets ajoutés" : "Import"],
      l: pp.source && /^https?:/.test(pp.source) ? [["Source", pp.source]] : [], x: pp.commentaire || null,
      rac: pp.poste_raccordement ? postesFromText(pp.poste_raccordement, lat, lon) : [] });
  }
  function parseCsv(text) {
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    const sep = (lines[0].match(/;/g) || []).length > (lines[0].match(/,/g) || []).length ? ";" : ",";
    const head = lines[0].split(sep).map((h) => h.trim().toLowerCase());
    const ix = (names) => head.findIndex((h) => names.includes(h));
    const iLat = ix(["lat", "latitude", "y"]), iLon = ix(["lon", "lng", "long", "longitude", "x"]);
    if (iLat < 0 || iLon < 0) throw new Error("colonnes lat / lon introuvables");
    return lines.slice(1).map((l) => {
      const c = l.split(sep), props = {};
      head.forEach((h, i) => (props[h] = (c[i] || "").trim()));
      return { type: "Feature", geometry: { type: "Point", coordinates: [num(c[iLon]), num(c[iLat])] }, properties: props };
    }).filter((f) => f.geometry.coordinates.every(Number.isFinite));
  }
  $("#import").addEventListener("change", async (e) => {
    const file = e.target.files[0]; if (!file) return;
    try {
      const text = await file.text();
      const feats = /\.csv$/i.test(file.name) ? parseCsv(text) : (JSON.parse(text).features || []);
      state.importedProj = feats.map((f) => featureToProj(f, "import")).filter(Boolean);
      $("#projSummary").textContent = `${state.importedProj.length} projet(s) importé(s) depuis ${file.name}.`;
      if (state.site) refreshProjects();
    } catch (err) { $("#projSummary").textContent = `Import impossible : ${err.message}. Attendu : GeoJSON, ou CSV avec colonnes lat et lon.`; }
    e.target.value = "";
  });

  /* ---------- recherche d'adresse ---------- */
  let sugg = [], sIdx = -1, sTimer = null;
  const coordRe = /^\s*(-?\d+(?:[.,]\d+)?)\s*[,;\s]\s*(-?\d+(?:[.,]\d+)?)\s*$/;
  $("#q").addEventListener("input", () => {
    clearTimeout(sTimer);
    const q = $("#q").value.trim();
    if (q.length < 3 || coordRe.test(q)) { $("#suggest").hidden = true; return; }
    sTimer = setTimeout(async () => {
      try {
        const j = await fetch(`${GEOCODE}?${new URLSearchParams({ q, limit: "6" })}`).then((r) => r.json());
        sugg = (j.features || []).map((f) => ({ label: f.properties.label + (f.properties.context ? " — " + f.properties.context : ""), lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] }));
        renderSuggest();
      } catch (_) { $("#suggest").hidden = true; }
    }, 250);
  });
  function renderSuggest() {
    const ul = $("#suggest"); ul.innerHTML = ""; sIdx = -1;
    sugg.forEach((s, i) => { const li = document.createElement("li"); li.textContent = s.label; li.addEventListener("mousedown", (e) => { e.preventDefault(); go(i); }); ul.appendChild(li); });
    ul.hidden = !sugg.length;
  }
  function go(i) { const s = sugg[i]; if (!s) return; $("#suggest").hidden = true; $("#q").value = s.label; map.setView([s.lat, s.lon], 14); setSite(s.lat, s.lon); }
  $("#q").addEventListener("keydown", (e) => {
    const lis = [...$("#suggest").children];
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); if (!lis.length) return; sIdx = (sIdx + (e.key === "ArrowDown" ? 1 : -1) + lis.length) % lis.length; lis.forEach((l, i) => l.setAttribute("aria-selected", i === sIdx)); }
    if (e.key === "Escape") $("#suggest").hidden = true;
  });
  $("#q").addEventListener("blur", () => setTimeout(() => ($("#suggest").hidden = true), 150));
  $("#search").addEventListener("submit", (e) => {
    e.preventDefault();
    const m = $("#q").value.match(coordRe);
    if (m) { const a = num(m[1]), b = num(m[2]); const [lat, lon] = Math.abs(a) <= 90 && a > 40 ? [a, b] : [b, a]; map.setView([lat, lon], 14); setSite(lat, lon); return; }
    go(sIdx >= 0 ? sIdx : 0);
  });

  /* ---------- paramètres & export ---------- */
  ["#p", "#n", "#minCap", "#withCap", "#withRte"].forEach((s) => $(s).addEventListener("change", () => { writeHash(); if (s === "#p") drawAllPostes(); analyse(false); }));
  $("#nom").addEventListener("input", () => { setTitle(); writeHash(); });
  ["#t_pv", "#t_eol", "#t_bess", "#projUnknown"].forEach((s) => $(s).addEventListener("change", () => { writeHash(); refreshProjects(); }));
  ["#radius", "#projYears"].forEach((s) => $(s).addEventListener("change", () => { writeHash(); if (state.site) loadProjects(); }));
  ["#cMl", "#cMl2", "#cMlB", "#cMl2B", "#pDep", "#cCell", "#cPdl", "#kDet", "#kV", "#duMax", "#tphi", "#kIz", "#p240"].forEach((s) => $(s).addEventListener("input", () => { writeHash(); if (state.results.length) refreshResults(); }));
  $("#copyCorr").addEventListener("click", async () => {
    const out = {};
    for (const k of Object.keys(state.corr).sort()) out[k] = state.corr[k];
    const btn = $("#copyCorr"), txt = JSON.stringify(out, null, 1);
    try { await navigator.clipboard.writeText(txt); btn.textContent = "Copié : à coller dans data/postes-corrections.json"; }
    catch (_) { btn.textContent = "Copie refusée par le navigateur"; }
    setTimeout(applyCorrections, 3500);
  });
  $("#copy").addEventListener("click", async () => {
    const pr = params();
    const head = ["Rang", "Poste", "Code", "GRD", "Reste à affecter S3REnR (MW)", "Capacité réservée (MW)", "Remplissage", "Vol d'oiseau (km)", "Trajet piéton (km)", "Quote-part (k€/MW)", "Quote-part (k€)", "Liaison HTA (km)", "Câbles en parallèle", "Câble (mm² Alu)", "Chute de tension (%)", "Courant par départ (A)", "Prix HTA (€/m)", "Liaison HTA (k€)", "Cellules (k€)", "Raccordement (k€)", "Avec poste de livraison (k€)", "Màj Capareseau"];
    const rows = state.results.map((r, i) => { const c = costFor(r, pr), v = r.p.v; return [i + 1, r.p.n, r.p.c, r.p.g1 || "RTE", num(v.INFO_NA), num(v.INFO_CR), v.INFO_TX || "", (r.d / 1000).toFixed(2), r.route !== null ? (r.route / 1000).toFixed(2) : "", c.qp ?? "", Math.round(c.qpart / 1e3) || "", (c.L_m / 1000).toFixed(2), c.dep, c.cab.best ? c.cab.best.s : "aucune", c.cab.best ? c.cab.best.du.toFixed(2) : "", Math.round(c.cab.I), c.prixMl, Math.round(c.liaison / 1e3), Math.round(c.cell / 1e3), Math.round(c.raccord / 1e3), Math.round(c.total / 1e3), (r.p.up || "") + (r.p.moved ? " (position corrigée)" : "")]; });
    const title = `Site ${state.site.lat.toFixed(5)}, ${state.site.lon.toFixed(5)} — ${fmt(pr.p)} MW — ${fmt(pr.kV, 1)} kV, chute de tension max ${fmt(pr.duMax, 1)} %, tan φ ${fmt(pr.tphi, 2)} — 240 mm² ${pr.cMl} €/m, 400 mm² ${pr.cMl2} €/m, ${pr.cCell / 1e3} k€/cellule, ${pr.cPdl / 1e3} k€/poste de livraison, ${pr.pDep} MW/départ`;
    const tsv = [title, head.join("\t"), ...rows.map((r) => r.map((x) => String(x).replace(".", ",")).join("\t"))].join("\n");
    const btn = $("#copy");
    try { await navigator.clipboard.writeText(tsv); btn.textContent = "Tableau copié"; } catch (_) { btn.textContent = "Copie refusée par le navigateur"; }
    setTimeout(() => (btn.textContent = "Copier le tableau"), 2000);
  });

  /* ---------- démarrage ---------- */
  async function boot() {
    try {
      const [postes, meta] = await Promise.all([fetch("data/postes.json").then((r) => r.json()), fetch("data/meta.json").then((r) => r.json()).catch(() => null)]);
      state.postes = postes; state.meta = meta;
    } catch (e) {
      $("#hint").textContent = "Impossible de charger data/postes.json. Ouvrez la page via un serveur web (GitHub Pages) plutôt qu'en fichier local.";
      return;
    }
    try {
      const cj = await fetch("data/postes-corrections.json").then(async (r) => {
        if (!r.ok) return {};
        const txt = await r.text();
        try { return JSON.parse(txt); } catch (e) { state.corrError = e.message; return {}; }
      });
      for (const [k, v] of Object.entries(cj || {})) if (v && Number.isFinite(+v.lat) && Number.isFinite(+v.lon)) state.corrRepo[k] = { lat: +(+v.lat).toFixed(6), lon: +(+v.lon).toFixed(6), n: v.n };
    } catch (_) {}
    mergeCorr(state.corrRepo);
    mergeCorr(loadLocalCorr());
    try {
      const [pj, pm] = await Promise.all([
        fetch("data/projets.json").then((r) => (r.ok ? r.json() : [])).catch(() => []),
        fetch("data/projets-meta.json").then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ]);
      state.collected = (Array.isArray(pj) ? pj : []).map((p) => projOf({ ...p, kind: "collecte", id: "c:" + p.id, rac: p.rac || [], l: p.l || [], src: p.src || [] }));
      state.projMeta = state.collected.length ? pm : null;
    } catch (_) {}
    try {
      const gj = await fetch("data/projets-locaux.geojson").then((r) => (r.ok ? r.json() : null));
      state.localProj = (gj?.features || []).map((f) => featureToProj(f, "local")).filter(Boolean);
    } catch (_) {}
    drawAllPostes();
    const m = state.meta;
    const regs = m ? Object.values(m.regions).map((r) => r.maj_max).filter(Boolean).sort() : [];
    $("#meta").innerHTML = `<p>${m ? m.nb_postes.toLocaleString("fr-FR") : state.postes.length} postes · extraction Capareseau du ${m ? new Date(m.extraction).toLocaleDateString("fr-FR") : "—"}${regs.length ? ` (données régionales mises à jour entre le ${new Date(regs[0]).toLocaleDateString("fr-FR")} et le ${new Date(regs[regs.length - 1]).toLocaleDateString("fr-FR")})` : ""}. Corse et outre-mer non couverts par les S3REnR.${Object.keys(state.corrRepo).length ? ` ${Object.keys(state.corrRepo).length} position(s) de poste corrigée(s) dans le dépôt.` : ""}</p>
      ${state.projMeta ? `<p>Projets voisins : collecte du ${new Date(state.projMeta.collecte).toLocaleDateString("fr-FR")} (${state.collected.length.toLocaleString("fr-FR")} projets PV, éolien et stockage depuis ${new Date(state.projMeta.depuis).getFullYear()} ; sources : projets-environnement.gouv.fr, avis MRAe, sites des préfectures). Le poste de raccordement provient des documents lus (avis, résumé non technique, avis d'enquête).</p>` : ""}
      ${state.corrError ? `<p class="notice">Le fichier data/postes-corrections.json du dépôt est illisible (${esc(state.corrError)}) : ses positions corrigées ne sont pas appliquées. Vérifiez les virgules et les accolades.</p>` : ""}
      <p>Sources : <a href="https://www.capareseau.fr/" target="_blank" rel="noopener">Capareseau</a> (RTE, GRD), <a href="https://www.projets-environnement.gouv.fr/" target="_blank" rel="noopener">projets-environnement.gouv.fr</a>, itinéraires <a href="https://geoservices.ign.fr/" target="_blank" rel="noopener">IGN Géoplateforme</a> (secours OSRM/OSM). Les capacités évoluent en continu : seule une demande de raccordement (PTF) engage le gestionnaire de réseau.</p>`;
    const site = readHash();
    applyCorrections();
    drawAllPostes(); // couleurs et positions selon l'URL
    if (site) { map.setView([site.lat, site.lon], 11); setSite(site.lat, site.lon); } else if (location.hash) writeHash();
  }
  // lien collé dans le même onglet : on réapplique tout
  window.addEventListener("hashchange", () => {
    const site = readHash();
    applyCorrections();
    drawAllPostes();
    if (site) { map.setView([site.lat, site.lon], 11); setSite(site.lat, site.lon); } else analyse(false);
  });
  boot();
})();
