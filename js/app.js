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

  const state = { postes: [], meta: null, site: null, results: [], sel: 0, localProj: [], importedProj: [], projects: [], routeSeq: 0 };

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
    cMl: num($("#cMl").value) ?? 160, pDep: Math.max(1, num($("#pDep").value) || 12), cCell: (num($("#cCell").value) ?? 120) * 1e3,
    cPdl: (num($("#cPdl").value) ?? 90) * 1e3, kDet: num($("#kDet").value) || 1.3,
  });
  const capOf = (p) => num(p.v.INFO_NA);
  function capClass(cap, P) { if (cap === null || cap <= 0) return "none"; return cap >= P ? "ok" : "part"; }
  const capColor = (cls) => css(cls === "ok" ? "--ok" : cls === "part" ? "--part" : "--none");
  const isGrd = (p) => !!(p.g1 || p.g2);

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
      <div class="pm">Capareseau, mise à jour ${esc(p.up || "—")}</div>`;
  }

  /* ---------- état dans l'URL ----------
   * #45.61000,5.15000&p=10&n=5&min=0&r=20&cap=1&rte=0&y=1&ml=160&dep=12&cell=120&pdl=90&k=1.3
   * Le site est facultatif ; les anciens liens « #lat,lon » restent valides. */
  const URL_FIELDS = [
    ["p", "#p"], ["n", "#n"], ["min", "#minCap"], ["r", "#radius"],
    ["cap", "#withCap"], ["rte", "#withRte"], ["y", "#projYears"],
    ["ml", "#cMl"], ["dep", "#pDep"], ["cell", "#cCell"], ["pdl", "#cPdl"], ["k", "#kDet"],
  ];
  const COST_KEYS = ["ml", "dep", "cell", "pdl", "k"];
  const DEFAULTS = Object.fromEntries(URL_FIELDS.map(([k, s]) => { const el = $(s); return [k, el.type === "checkbox" ? (el.checked ? "1" : "0") : el.value]; }));
  function writeHash() {
    const parts = [];
    if (state.site) parts.push(`${state.site.lat.toFixed(5)},${state.site.lon.toFixed(5)}`);
    for (const [k, s] of URL_FIELDS) {
      const el = $(s);
      const v = el.type === "checkbox" ? (el.checked ? "1" : "0") : String(el.value).trim().replace(",", ".");
      if (v !== "") parts.push(`${k}=${encodeURIComponent(v)}`);
    }
    try { history.replaceState(null, "", "#" + parts.join("&")); } catch (_) {}
  }
  function readHash() {
    let site = null, costChanged = false;
    for (const tok of location.hash.slice(1).split("&")) {
      if (!tok) continue;
      const eq = tok.indexOf("=");
      if (eq < 0) {
        const c = tok.split(",").map(Number);
        if (c.length === 2 && c.every(Number.isFinite) && Math.abs(c[0]) <= 90 && Math.abs(c[1]) <= 180) site = { lat: c[0], lon: c[1] };
        continue;
      }
      const k = tok.slice(0, eq), raw = decodeURIComponent(tok.slice(eq + 1));
      const f = URL_FIELDS.find(([key]) => key === k); if (!f) continue;
      const el = $(f[1]);
      if (el.type === "checkbox") el.checked = raw === "1" || raw === "true";
      else if (el.tagName === "SELECT") { if ([...el.options].some((o) => o.value === raw)) el.value = raw; }
      else if (Number.isFinite(num(raw))) el.value = num(raw);
      if (COST_KEYS.includes(k) && String(num(raw)) !== String(num(DEFAULTS[k]))) costChanged = true;
    }
    if (costChanged) $(".hyp").open = true; // montre que des hypothèses non standard sont appliquées
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

  function costFor(r, pr) {
    const qp = num(r.p.v.INFO_QP); // k€/MW
    const L_m = r.route ?? r.d * pr.kDet;
    const dep = Math.ceil(pr.p / pr.pDep);
    const liaison = L_m * pr.cMl * dep;
    const cell = dep * pr.cCell;
    const qpart = qp !== null ? qp * 1e3 * pr.p : NaN;
    const raccord = liaison + cell + (Number.isFinite(qpart) ? qpart : 0);
    return { qp, L_m, dep, liaison, cell, qpart, pdl: pr.cPdl, raccord, total: raccord + pr.cPdl, estimated: r.route === null };
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
      if (p.pj === "1") chips.push(`<span class="chip warn">poste en projet S3REnR</span>`);
      if (cls === "part") chips.push(`<span class="chip warn">capacité &lt; ${fmt(pr.p)} MW</span>`);
      if (c.dep > 1) chips.push(`<span class="chip warn">${c.dep} départs HTA</span>`);
      if (pr.p > 17) chips.push(`<span class="chip warn">&gt; 17 MW : raccordement HTB à étudier</span>`);
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
          <div class="row"><span>Liaison HTA ${c.dep > 1 ? c.dep + " × " : ""}${km(c.L_m)}${c.estimated ? " (estimée)" : ""}</span><b>${keur(c.liaison)}</b></div>
          <div class="row"><span>Cellule${c.dep > 1 ? "s" : ""} départ poste source</span><b>${keur(c.cell)}</b></div>
          <div class="row tot"><span>Raccordement indicatif</span><b>${keur(c.raccord)}</b></div>
          <div class="row"><span>+ poste de livraison</span><b>${keur(c.total)}</b></div>
        </div>
        <div class="links"><a href="${gm}" target="_blank" rel="noopener">Itinéraire Google Maps</a><a href="https://www.capareseau.fr/region/${esc(p.r)}?postCode=${encodeURIComponent(p.c)}" target="_blank" rel="noopener">Fiche Capareseau</a><span class="pm">màj ${esc(p.up || "—")}</span></div>`;
      li.addEventListener("click", (e) => { if (e.target.closest("a")) return; select(idx); });
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
  }

  function drawPostes() {
    lyrPostes.clearLayers(); lyrLinks.clearLayers(); lyrRoute.clearLayers();
    const pr = params();
    state.results.forEach((r, idx) => {
      const cls = capClass(capOf(r.p), pr.p), col = capColor(cls);
      L.polyline([[state.site.lat, state.site.lon], [r.p.lat, r.p.lon]], { color: col, weight: idx === state.sel ? 2.5 : 1.5, dashArray: "6 6", opacity: 0.9, interactive: false }).addTo(lyrLinks);
      const html = `<div class="pin-poste" style="--c:${col}"><div class="pt"></div><div class="lab">${idx + 1} · ${fmt(capOf(r.p))} MW</div></div>`;
      L.marker([r.p.lat, r.p.lon], { icon: L.divIcon({ className: "", html, iconSize: [0, 0] }), zIndexOffset: 500 - idx })
        .on("click", () => select(idx)).bindPopup(postePopupHtml(r.p)).addTo(lyrPostes);
      if (r.routeGeom) {
        L.geoJSON(r.routeGeom, { style: { color: idx === state.sel ? css("--accent") : col, weight: idx === state.sel ? 5 : 2.5, opacity: idx === state.sel ? 0.9 : 0.45 } }).addTo(lyrRoute);
      }
    });
  }
  function select(idx) {
    state.sel = idx;
    document.querySelectorAll("#list .poste").forEach((el, i) => el.classList.toggle("sel", i === idx));
    drawPostes();
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
  async function computeRoutes() {
    const seq = ++state.routeSeq;
    const site = state.site;
    for (const r of state.results) {
      let res = null;
      try { res = await routeIGN(site, r.p); } catch (_) { try { res = await routeOSRM(site, r.p); } catch (__) { res = null; } }
      if (seq !== state.routeSeq) return; // un autre calcul a démarré
      if (res) { r.route = res.d; r.routeGeom = res.geom; r.routeSrc = res.src; } else { r.routeSrc = "err"; }
      renderList(nearest(site, params().p).firstFull);
      document.querySelectorAll("#list .poste").forEach((el, i) => el.classList.toggle("sel", i === state.sel));
      drawPostes();
    }
  }

  /* ---------- projets ---------- */
  function classify(x) {
    if (x.vp_status === "ouvert") return "Consultation du public en cours";
    if (x.dc_relation_decision) return "Décision publiée";
    if (x.dc_relation_expertise_avisae) return "Avis de l'autorité environnementale publié";
    return "Dossier publié";
  }
  const mwc = (t) => { const m = String(t || "").match(/(\d+(?:[.,]\d+)?)\s*(MWc|MWp|MW)\b/i); return m ? m[1].replace(",", ".") + " " + m[2] : null; };

  async function loadProjects() {
    const pr = params(), site = state.site;
    lyrProj.clearLayers(); lyrRadius.clearLayers();
    L.circle([site.lat, site.lon], { radius: pr.radius * 1000, color: css("--proj"), weight: 1, dashArray: "4 6", fill: false, interactive: false }).addTo(lyrRadius);
    $("#projSummary").textContent = "Recherche des projets publiés…";
    let where = `within_distance(geo_point_2d, geom'POINT(${site.lon.toFixed(5)} ${site.lat.toFixed(5)})', ${pr.radius}km) and (search("photovolta") or search("solaire") or search("agrivolta"))`;
    if (pr.projYears) { const d = new Date(); d.setFullYear(d.getFullYear() - 5); where += ` and dc_date >= date'${d.toISOString().slice(0, 10)}'`; }
    const sel = "dc_title,descriptif_du_projet,dc_type,vp_status,dc_date,date_de_la_prefecture,dateouverture,datefermeture,dc_location,geo_point_2d,localisation,dc_relation_decision,dc_relation_expertise_avisae,dc_relation_expertise_etudeimpact,dc_relation_synthesis,dc_relation_informationnote,dc_relation_websitedebate,dc_subject_category,recordsid,source";
    let remote = [], err = null;
    try {
      const u = API_PROJ + "?" + new URLSearchParams({ where, select: sel, limit: "100", order_by: "dc_date desc" });
      const r = await fetch(u); const j = await r.json();
      if (!r.ok) throw new Error(j.message || r.status);
      remote = (j.results || []).filter((x) => x.geo_point_2d && PV_RE.test([x.dc_title, x.descriptif_du_projet, x.dc_subject_category].flat().join(" ")));
    } catch (e) { err = e.message || String(e); }
    if (state.site !== site) return;
    const projs = remote.map((x) => ({
      kind: "pe", title: x.dc_title, lat: x.geo_point_2d.lat, lon: x.geo_point_2d.lon, geom: x.localisation?.geometry,
      proc: [].concat(x.dc_type || []).join(", "), statut: classify(x), date: (x.dc_date || "").slice(0, 10), dep: x.dc_location,
      puissance: mwc(x.descriptif_du_projet) || mwc(x.dc_title), desc: x.descriptif_du_projet,
      links: [["Avis AE", x.dc_relation_expertise_avisae], ["Étude d'impact", x.dc_relation_expertise_etudeimpact], ["Résumé non technique", x.dc_relation_synthesis], ["Décision", x.dc_relation_decision], ["Page préfecture", x.dc_relation_informationnote || x.dc_relation_websitedebate]].filter((l) => l[1] && /^https?:/.test(l[1])),
    }));
    const locals = [...state.localProj, ...state.importedProj].filter((p) => haversine(site, p) <= pr.radius * 1000);
    state.projects = [...locals, ...projs].map((p) => ({ ...p, d: haversine(site, p) })).sort((a, b) => a.d - b.d);
    drawProjects();
    const n1 = projs.length, n2 = locals.length;
    $("#projSummary").innerHTML = err
      ? `Projets-environnement.gouv.fr n'a pas répondu (${esc(err)}). ${n2 ? n2 + " projet(s) ajouté(s) affiché(s)." : ""}`
      : `${n1} projet${n1 > 1 ? "s" : ""} PV publié${n1 > 1 ? "s" : ""} sur projets-environnement.gouv.fr${n2 ? ` et ${n2} projet${n2 > 1 ? "s" : ""} ajouté${n2 > 1 ? "s" : ""}` : ""} dans un rayon de ${pr.radius} km.`;
  }
  function projPopup(p) {
    return `<h3>${esc(p.title)}</h3><div class="pm">${esc(p.proc || "")}${p.dep ? " · " + esc(p.dep) : ""}</div>
      <div><b>${esc(p.statut || "")}</b>${p.date ? " · " + esc(p.date) : ""}${p.puissance ? " · " + esc(p.puissance) : ""}</div>
      ${p.desc ? `<div class="pm">${esc(String(p.desc).slice(0, 260))}${String(p.desc).length > 260 ? "…" : ""}</div>` : ""}
      <div>${(p.links || []).map(([t, u]) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)}</a>`).join(" · ")}</div>`;
  }
  function drawProjects() {
    lyrProj.clearLayers();
    const ul = $("#projList"); ul.innerHTML = "";
    state.projects.forEach((p) => {
      const loc = p.kind !== "pe";
      if (p.geom) L.geoJSON(p.geom, { style: { color: css("--proj"), weight: 1.5, fillOpacity: 0.12 }, interactive: false }).addTo(lyrProj);
      const m = L.marker([p.lat, p.lon], { icon: L.divIcon({ className: "", html: `<div class="pin-proj${loc ? " loc" : ""}"></div>`, iconSize: [12, 12], iconAnchor: [6, 6] }) })
        .bindPopup(projPopup(p)).addTo(lyrProj);
      const li = document.createElement("li");
      li.className = "proj" + (loc ? " loc" : "");
      li.innerHTML = `<div class="pt">${esc(p.title)}</div><div class="pm">${esc(p.statut || "")}${p.date ? " · " + esc(p.date) : ""}${p.puissance ? " · " + esc(p.puissance) : ""} · ${km(p.d)}</div>`;
      li.addEventListener("click", () => { map.setView([p.lat, p.lon], Math.max(map.getZoom(), 13)); m.openPopup(); });
      ul.appendChild(li);
    });
  }

  /* projets ajoutés à la main : data/projets-locaux.geojson + import de fichiers */
  function featureToProj(f, kind) {
    const g = f.geometry; if (!g) return null;
    let lat, lon;
    if (g.type === "Point") [lon, lat] = g.coordinates;
    else { const b = L.geoJSON(f).getBounds(); if (!b.isValid()) return null; ({ lat, lng: lon } = b.getCenter()); }
    const pp = f.properties || {};
    return { kind, title: pp.nom || pp.name || pp.titre || "Projet", lat, lon, geom: g.type === "Point" ? null : g,
      proc: pp.procedure || "", statut: pp.statut || "", date: pp.date || "", dep: pp.commune || "",
      puissance: pp.puissance_mwc ? pp.puissance_mwc + " MWc" : null, desc: pp.commentaire || "",
      links: pp.source && /^https?:/.test(pp.source) ? [["Source", pp.source]] : [] };
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
      if (state.site) loadProjects();
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
  ["#radius", "#projYears"].forEach((s) => $(s).addEventListener("change", () => { writeHash(); if (state.site) loadProjects(); }));
  ["#cMl", "#pDep", "#cCell", "#cPdl", "#kDet"].forEach((s) => $(s).addEventListener("input", () => { writeHash(); if (state.results.length) { renderList(nearest(state.site, params().p).firstFull); document.querySelectorAll("#list .poste").forEach((el, i) => el.classList.toggle("sel", i === state.sel)); } }));
  $("#copy").addEventListener("click", async () => {
    const pr = params();
    const head = ["Rang", "Poste", "Code", "GRD", "Reste à affecter S3REnR (MW)", "Capacité réservée (MW)", "Remplissage", "Vol d'oiseau (km)", "Trajet piéton (km)", "Quote-part (k€/MW)", "Quote-part (k€)", "Liaison HTA (k€)", "Cellules (k€)", "Raccordement (k€)", "Avec poste de livraison (k€)", "Màj Capareseau"];
    const rows = state.results.map((r, i) => { const c = costFor(r, pr), v = r.p.v; return [i + 1, r.p.n, r.p.c, r.p.g1 || "RTE", num(v.INFO_NA), num(v.INFO_CR), v.INFO_TX || "", (r.d / 1000).toFixed(2), r.route !== null ? (r.route / 1000).toFixed(2) : "", c.qp ?? "", Math.round(c.qpart / 1e3) || "", Math.round(c.liaison / 1e3), Math.round(c.cell / 1e3), Math.round(c.raccord / 1e3), Math.round(c.total / 1e3), r.p.up || ""]; });
    const title = `Site ${state.site.lat.toFixed(5)}, ${state.site.lon.toFixed(5)} — ${fmt(pr.p)} MW — hypothèses ${pr.cMl} €/m HTA, ${pr.cCell / 1e3} k€/cellule, ${pr.pDep} MW/départ`;
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
      const gj = await fetch("data/projets-locaux.geojson").then((r) => (r.ok ? r.json() : null));
      state.localProj = (gj?.features || []).map((f) => featureToProj(f, "local")).filter(Boolean);
    } catch (_) {}
    drawAllPostes();
    const m = state.meta;
    const regs = m ? Object.values(m.regions).map((r) => r.maj_max).filter(Boolean).sort() : [];
    $("#meta").innerHTML = `<p>${m ? m.nb_postes.toLocaleString("fr-FR") : state.postes.length} postes · extraction Capareseau du ${m ? new Date(m.extraction).toLocaleDateString("fr-FR") : "—"}${regs.length ? ` (données régionales mises à jour entre le ${new Date(regs[0]).toLocaleDateString("fr-FR")} et le ${new Date(regs[regs.length - 1]).toLocaleDateString("fr-FR")})` : ""}. Corse et outre-mer non couverts par les S3REnR.</p>
      <p>Sources : <a href="https://www.capareseau.fr/" target="_blank" rel="noopener">Capareseau</a> (RTE, GRD), <a href="https://www.projets-environnement.gouv.fr/" target="_blank" rel="noopener">projets-environnement.gouv.fr</a>, itinéraires <a href="https://geoservices.ign.fr/" target="_blank" rel="noopener">IGN Géoplateforme</a> (secours OSRM/OSM). Les capacités évoluent en continu : seule une demande de raccordement (PTF) engage le gestionnaire de réseau.</p>`;
    const site = readHash();
    drawAllPostes(); // couleurs selon la puissance lue dans l'URL
    if (site) { map.setView([site.lat, site.lon], 11); setSite(site.lat, site.lon); } else if (location.hash) writeHash();
  }
  // lien collé dans le même onglet : on réapplique tout
  window.addEventListener("hashchange", () => {
    const site = readHash();
    drawAllPostes();
    if (site) { map.setView([site.lat, site.lon], 11); setSite(site.lat, site.lon); } else analyse(false);
  });
  boot();
})();
