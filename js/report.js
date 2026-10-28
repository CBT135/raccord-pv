/* Raccord PV — rapport PDF d'un poste source.
 * jsPDF + AutoTable sont chargés à la demande (premier clic sur « Rapport PDF »).
 * La carte est redessinée à partir des tuiles (IGN ou OSM) avec le site, les postes et les trajets,
 * pour obtenir une image nette et indépendante de l'affichage à l'écran. */
(() => {
  "use strict";

  const LIBS = [
    ["https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js", "sha384-JcnsjUPPylna1s1fvi1u12X5qjY5OL56iySh75FdtrwhO/SWXgMjoVqcKyIIWOLk"],
    ["https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js", "sha384-fCAW/rDWORTbQXSiB7mOg0QtQ5c+r0f544y6XoKjuVva0nMBlCpNUjiFeG5iMdS3"],
  ];
  let libsP = null;
  function loadLibs() {
    if (window.jspdf?.jsPDF?.API?.autoTable) return Promise.resolve();
    if (libsP) return libsP;
    libsP = LIBS.reduce((p, [src, sri]) => p.then(() => new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = src; s.integrity = sri; s.crossOrigin = "anonymous";
      s.onload = res; s.onerror = () => rej(new Error("la bibliothèque PDF n'a pas pu être chargée"));
      document.head.appendChild(s);
    })), Promise.resolve()).catch((e) => { libsP = null; throw e; });
    return libsP;
  }

  /* ---------- couleurs (rapport toujours sur fond clair) ---------- */
  const C = {
    ink: [23, 33, 43], muted: [91, 107, 122], line: [217, 224, 230], band: [238, 242, 245], selRow: [222, 241, 244],
    accent: [11, 114, 133], ok: [43, 138, 62], part: [217, 138, 0], none: [201, 42, 42], proj: [112, 72, 232], loc: [232, 89, 12],
  };
  const rgb = (a) => `rgb(${a.join(",")})`;
  const clsColor = (cls) => (cls === "ok" ? C.ok : cls === "part" ? C.part : C.none);

  /* ---------- texte : jsPDF (polices standard) n'accepte que le jeu Windows-1252 ---------- */
  const WIN = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";
  const T = (s) => String(s ?? "").replace(/[    ]/g, " ").replace(/≥/g, ">=").replace(/≤/g, "<=")
    .replace(/[^\x00-\xff]/g, (c) => (WIN.includes(c) ? c : "?"));
  const fmt = (n, d = 1) => (n === null || n === undefined || !Number.isFinite(n) ? "—" : n.toLocaleString("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d }));
  const kE = (e) => (Number.isFinite(e) ? fmt(e / 1e3, 0) + " k€" : "—");
  const kmTxt = (m) => (m === null || m === undefined || !Number.isFinite(m) ? "—" : fmt(m / 1000, 2) + " km");

  /* ---------- carte ---------- */
  const TILE = 256;
  const worldPx = (lat, lon, z) => {
    const s = TILE * 2 ** z, r = (Math.max(-85, Math.min(85, lat)) * Math.PI) / 180;
    return [((lon + 180) / 360) * s, ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * s];
  };
  function coordsOf(g) {
    if (!g) return [];
    if (g.type === "Feature") return coordsOf(g.geometry);
    if (g.type === "FeatureCollection") return g.features.flatMap(coordsOf);
    if (g.type === "LineString") return g.coordinates;
    if (g.type === "MultiLineString") return g.coordinates.flat();
    return [];
  }
  const TILES = {
    plan: { url: (z, x, y) => `https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&STYLE=normal&TILEMATRIXSET=PM&TILEMATRIX=${z}&TILEROW=${y}&TILECOL=${x}&FORMAT=image/png`, attr: "© IGN – Plan IGN", max: 18 },
    ortho: { url: (z, x, y) => `https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&TILEMATRIXSET=PM&TILEMATRIX=${z}&TILEROW=${y}&TILECOL=${x}&FORMAT=image/jpeg`, attr: "© IGN – Photographies aériennes", max: 18 },
    osm: { url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`, attr: "© contributeurs OpenStreetMap", max: 18 },
  };
  async function loadTile(url) {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 12000);
    try {
      const r = await fetch(url, { mode: "cors", signal: ctl.signal });
      if (!r.ok) throw new Error(r.status);
      return await createImageBitmap(await r.blob());
    } finally { clearTimeout(t); }
  }

  async function renderMap(d, W, H, scale) {
    const pts = [[d.site.lat, d.site.lon], ...d.postes.map((p) => [p.lat, p.lon])];
    for (const p of d.postes) for (const c of coordsOf(p.routeGeom)) pts.push([c[1], c[0]]);
    // zoom continu : on cadre au plus juste, les tuiles du niveau entier le plus proche sont mises à l'échelle (×0,7 à ×1,4)
    const padX = 70, padY = 45, tiles = TILES[d.base] || TILES.plan;
    const xy0 = pts.map(([la, lo]) => worldPx(la, lo, 0)), xs0 = xy0.map((p) => p[0]), ys0 = xy0.map((p) => p[1]);
    const w0 = Math.max(...xs0) - Math.min(...xs0), h0 = Math.max(...ys0) - Math.min(...ys0);
    let zf = Math.min(w0 > 0 ? Math.log2((W - 2 * padX) / w0) : 99, h0 > 0 ? Math.log2((H - 2 * padY) / h0) : 99);
    zf = Math.max(5, Math.min(16, Number.isFinite(zf) ? zf : 15));
    const z = Math.min(tiles.max, Math.round(zf)), k = 2 ** (zf - z), TS = TILE * k;
    const cx = ((Math.max(...xs0) + Math.min(...xs0)) / 2) * 2 ** zf, cy = ((Math.max(...ys0) + Math.min(...ys0)) / 2) * 2 ** zf;
    const ox = cx - W / 2, oy = cy - H / 2;
    const P = (lat, lon) => { const [x, y] = worldPx(lat, lon, z); return [x * k - ox, y * k - oy]; };
    const placed = [];

    const cv = document.createElement("canvas");
    cv.width = W * scale; cv.height = H * scale;
    const g = cv.getContext("2d");
    g.scale(scale, scale);
    g.fillStyle = rgb(C.band); g.fillRect(0, 0, W, H);

    // fond
    const n = 2 ** z, jobs = [];
    g.imageSmoothingQuality = "high";
    for (let tx = Math.floor(ox / TS); tx <= Math.floor((ox + W) / TS); tx++)
      for (let ty = Math.floor(oy / TS); ty <= Math.floor((oy + H) / TS); ty++) {
        if (ty < 0 || ty >= n) continue;
        const wx = ((tx % n) + n) % n;
        // +0,5 px pour éviter les liserés entre tuiles mises à l'échelle
        jobs.push(loadTile(tiles.url(z, wx, ty)).then((img) => g.drawImage(img, tx * TS - ox, ty * TS - oy, TS + 0.5, TS + 0.5)).then(() => 1, () => 0));
      }
    const okTiles = (await Promise.all(jobs)).reduce((a, b) => a + b, 0);
    if (d.base !== "ortho") { g.fillStyle = "rgba(255,255,255,0.18)"; g.fillRect(0, 0, W, H); } // atténue le fond

    const path = (coords) => { g.beginPath(); coords.forEach(([lon, lat], i) => { const [x, y] = P(lat, lon); i ? g.lineTo(x, y) : g.moveTo(x, y); }); };
    const [sx, sy] = P(d.site.lat, d.site.lon);

    // liaisons à vol d'oiseau
    g.setLineDash([7, 6]); g.lineWidth = 1.6;
    for (const p of d.postes) { const [x, y] = P(p.lat, p.lon); g.strokeStyle = rgb(clsColor(p.cls)); g.globalAlpha = 0.85; g.beginPath(); g.moveTo(sx, sy); g.lineTo(x, y); g.stroke(); }
    g.setLineDash([]); g.globalAlpha = 1;

    // trajets : autres postes d'abord, poste étudié au-dessus
    const order = d.postes.map((p, i) => i).sort((a, b) => (a === d.sel) - (b === d.sel));
    for (const i of order) {
      const p = d.postes[i], co = coordsOf(p.routeGeom); if (co.length < 2) continue;
      g.lineJoin = g.lineCap = "round";
      if (i === d.sel) {
        path(co); g.strokeStyle = "#fff"; g.lineWidth = 8; g.stroke();
        path(co); g.strokeStyle = rgb(C.accent); g.lineWidth = 4.5; g.stroke();
      } else {
        path(co); g.strokeStyle = rgb(clsColor(p.cls)); g.globalAlpha = 0.55; g.lineWidth = 2.6; g.stroke(); g.globalAlpha = 1;
      }
    }

    // marqueurs (projets, postes, site), puis étiquettes placées sans se chevaucher
    const marks = [];
    for (const pr of d.projets) {
      const [x, y] = P(pr.lat, pr.lon); if (x < 6 || y < 6 || x > W - 6 || y > H - 6) continue;
      pr.onMap = true;
      g.save(); g.translate(x, y); g.rotate(Math.PI / 4);
      g.fillStyle = rgb(pr.kind === "pe" ? C.proj : C.loc); g.strokeStyle = "#fff"; g.lineWidth = 1.6;
      g.fillRect(-4.5, -4.5, 9, 9); g.strokeRect(-4.5, -4.5, 9, 9); g.restore();
      placed.push([x - 7, y - 7, x + 7, y + 7]);
      marks.push({ t: pr.label, x, y, col: rgb(pr.kind === "pe" ? C.proj : C.loc), size: 10, bold: false, off: 8, prio: 3 });
    }
    d.postes.forEach((p, i) => {
      const [x, y] = P(p.lat, p.lon), col = rgb(clsColor(p.cls)), sel = i === d.sel;
      g.save(); g.translate(x, y); g.rotate(Math.PI / 4);
      const s = sel ? 8 : 6.5;
      g.fillStyle = col; g.strokeStyle = sel ? rgb(C.accent) : "#fff"; g.lineWidth = sel ? 3 : 2;
      g.fillRect(-s, -s, 2 * s, 2 * s); g.strokeRect(-s, -s, 2 * s, 2 * s); g.restore();
      placed.push([x - 12, y - 12, x + 12, y + 12]);
      marks.push({ t: `${i + 1} · ${p.nom}`, x, y, col: sel ? rgb(C.accent) : col, size: sel ? 12.5 : 11.5, bold: true, off: 14, prio: sel ? 1 : 2 });
    });
    g.beginPath(); g.arc(sx, sy, 8, 0, 2 * Math.PI); g.fillStyle = rgb(C.accent); g.fill(); g.lineWidth = 3; g.strokeStyle = "#fff"; g.stroke();
    placed.push([sx - 11, sy - 11, sx + 11, sy + 11]);
    marks.push({ t: "Site", x: sx, y: sy, col: rgb(C.ink), size: 12, bold: true, off: 13, prio: 0 });
    marks.sort((a, b) => a.prio - b.prio).forEach((m) => placeLabel(g, m, W, H, placed));

    // échelle
    const mpp = (156543.03392 * Math.cos((d.site.lat * Math.PI) / 180)) / 2 ** zf;
    const target = 130 * mpp, dec = 10 ** Math.floor(Math.log10(target));
    const nice = [5, 2, 1].map((m) => m * dec).find((v) => v <= target) || dec;
    const bw = nice / mpp, txt = nice >= 1000 ? `${fmt(nice / 1000, nice % 1000 ? 1 : 0)} km` : `${nice} m`;
    g.fillStyle = "rgba(255,255,255,0.88)"; g.fillRect(10, H - 32, bw + 24, 24);
    g.fillStyle = rgb(C.ink); g.fillRect(22, H - 15, bw, 3); g.fillRect(22, H - 20, 2, 8); g.fillRect(22 + bw - 2, H - 20, 2, 8);
    g.font = "600 11px Helvetica, Arial, sans-serif"; g.textAlign = "center"; g.fillText(txt, 22 + bw / 2, H - 23);

    // nord
    g.textAlign = "center"; g.fillStyle = "rgba(255,255,255,0.88)"; g.beginPath(); g.arc(W - 24, 26, 15, 0, 2 * Math.PI); g.fill();
    g.fillStyle = rgb(C.ink); g.beginPath(); g.moveTo(W - 24, 13); g.lineTo(W - 30, 30); g.lineTo(W - 24, 26); g.lineTo(W - 18, 30); g.closePath(); g.fill();
    g.font = "700 9px Helvetica, Arial, sans-serif"; g.fillText("N", W - 24, 36);

    // attribution
    g.font = "10px Helvetica, Arial, sans-serif"; g.textAlign = "right";
    const at = tiles.attr + (okTiles ? "" : " (fond indisponible)"), aw = g.measureText(at).width;
    g.fillStyle = "rgba(255,255,255,0.85)"; g.fillRect(W - aw - 12, H - 17, aw + 12, 17);
    g.fillStyle = rgb(C.muted); g.fillText(at, W - 6, H - 8);

    return { img: cv.toDataURL("image/jpeg", 0.9), z: zf, okTiles, attr: tiles.attr };
  }
  // essaie plusieurs positions autour du marqueur et garde la première libre (sinon la moins gênante)
  function placeLabel(g, m, W, H, placed) {
    g.font = `${m.bold ? "700" : "600"} ${m.size}px Helvetica, Arial, sans-serif`;
    const w = g.measureText(m.t).width + 8, h = m.size + 6, o = m.off;
    const cands = [[m.x + o, m.y - h / 2], [m.x - o - w, m.y - h / 2], [m.x + o * 0.6, m.y - o - h + 2], [m.x + o * 0.6, m.y + o - 2],
      [m.x - o * 0.6 - w, m.y - o - h + 2], [m.x - o * 0.6 - w, m.y + o - 2], [m.x - w / 2, m.y - o - h - 4], [m.x - w / 2, m.y + o + 4]];
    const hit = (r) => placed.reduce((a, q) => a + Math.max(0, Math.min(r[2], q[2]) - Math.max(r[0], q[0])) * Math.max(0, Math.min(r[3], q[3]) - Math.max(r[1], q[1])), 0);
    let best = null, bestScore = Infinity;
    for (const [x0, y0] of cands) {
      const r = [x0, y0, x0 + w, y0 + h];
      const out = (x0 < 2 || y0 < 2 || x0 + w > W - 2 || y0 + h > H - 2) ? 1e6 : 0;
      const score = out + hit(r);
      if (score < bestScore) { best = r; bestScore = score; if (!score) break; }
    }
    placed.push(best);
    label(g, m.t, best[0], best[1] + h / 2, m.col, "#fff", m.size, m.bold);
  }
  function label(g, text, x, y, color, bg, size, bold, align = "left") {
    g.font = `${bold ? "700" : "600"} ${size}px Helvetica, Arial, sans-serif`;
    g.textAlign = "left"; g.textBaseline = "middle";
    const w = g.measureText(text).width, h = size + 6, x0 = align === "right" ? x - w - 8 : x;
    g.fillStyle = bg; g.globalAlpha = 0.9; g.fillRect(x0, y - h / 2, w + 8, h); g.globalAlpha = 1;
    g.strokeStyle = color; g.lineWidth = 1; g.strokeRect(x0 + 0.5, y - h / 2 + 0.5, w + 7, h - 1);
    g.fillStyle = color; g.fillText(text, x0 + 4, y + 0.5);
  }

  /* ---------- commune : découpage communal (geo.api.gouv.fr), à défaut adresse la plus proche (IGN) ---------- */
  const getJson = async (url) => { const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 5000); try { return await fetch(url, { signal: ctl.signal }).then((r) => r.json()); } finally { clearTimeout(t); } };
  async function commune(site) {
    try {
      const j = await getJson(`https://geo.api.gouv.fr/communes?lat=${site.lat}&lon=${site.lon}&fields=nom,codeDepartement&format=json`);
      if (Array.isArray(j) && j[0]?.nom) return `${j[0].nom} (${j[0].codeDepartement})`;
    } catch (_) {}
    try {
      const j = await getJson(`https://data.geopf.fr/geocodage/reverse?lon=${site.lon}&lat=${site.lat}&index=address&limit=1`);
      const p = j.features?.[0]?.properties; if (p?.city) return `${p.city}${p.postcode ? ` (${p.postcode.slice(0, 2)})` : ""}`;
    } catch (_) {}
    return null;
  }

  /* ---------- PDF ---------- */
  async function generate(d) {
    await loadLibs();
    const { jsPDF } = window.jspdf;
    const MW = 1000, MH = 560;
    const [map, ville] = await Promise.all([renderMap(d, MW, MH, 2).catch(() => null), commune(d.site)]);

    const doc = new jsPDF({ unit: "mm", format: "a4", compress: true });
    const M = 15, W = 180, pageH = 297, bottom = 20;
    const nom = d.nom || "Projet sans nom", P = d.postes[d.sel], c = P.cost;
    const today = new Date().toLocaleDateString("fr-FR");
    doc.setProperties({ title: T(`Raccord PV – ${nom} – ${P.nom}`), subject: "Pré-étude de raccordement en injection", creator: "Raccord PV" });
    const set = (size, style = "normal", color = C.ink) => { doc.setFont("helvetica", style); doc.setFontSize(size); doc.setTextColor(...color); };
    let y = 12;

    // en-tête
    set(8, "bold", C.accent); doc.text("RACCORD PV", M, y);
    const wR = doc.getTextWidth("RACCORD PV ");
    set(8, "normal", C.muted); doc.text(T("· Pré-étude de raccordement en injection"), M + wR, y);
    doc.text(T(`Édité le ${today}`), M + W, y, { align: "right" });
    doc.setDrawColor(...C.line); doc.setLineWidth(0.3); doc.line(M, y + 2.5, M + W, y + 2.5);
    y += 11;
    set(18, "bold"); const tl = doc.splitTextToSize(T(nom), W).slice(0, 2); doc.text(tl, M, y); y += 7 * tl.length;
    set(9.5, "normal", C.muted);
    doc.text(doc.splitTextToSize(T(`${ville ? ville + " · " : ""}site ${d.site.lat.toFixed(5)}, ${d.site.lon.toFixed(5)} · poste étudié : ${P.nom} (n° ${d.sel + 1})`), W), M, y);
    y += 4;

    // carte
    const mh = (W * MH) / MW;
    if (map) doc.addImage(map.img, "JPEG", M, y, W, mh, undefined, "FAST");
    else { doc.setFillColor(...C.band); doc.rect(M, y, W, mh, "F"); set(9, "normal", C.muted); doc.text("Carte indisponible", M + W / 2, y + mh / 2, { align: "center" }); }
    doc.setDrawColor(...C.line); doc.rect(M, y, W, mh);
    y += mh + 4.5;

    // légende
    set(7.5, "normal", C.muted);
    const items = [
      ["site", C.accent, "Site"], ["route", C.accent, "Trajet piéton du poste étudié"],
      ["sq", C.ok, "Capacité restante suffisante"], ["sq", C.part, "Capacité partielle"], ["sq", C.none, "Sans capacité restante"],
      ["sq", C.proj, "Projet PV publié (P1…)"],
    ];
    if (!d.projets.some((p) => p.onMap && p.kind === "pe")) items.pop(); // pas de projet publié sur la carte
    if (d.projets.some((p) => p.onMap && p.kind !== "pe")) items.push(["sq", C.loc, "Projet ajouté"]);
    let lx = M;
    for (const [kind, col, txt] of items) {
      const tw = doc.getTextWidth(T(txt)) + 9;
      if (lx + tw > M + W) { lx = M; y += 4.5; }
      doc.setFillColor(...col); doc.setDrawColor(...col);
      if (kind === "site") doc.circle(lx + 1.6, y - 1, 1.4, "F");
      else if (kind === "route") { doc.setLineWidth(0.9); doc.line(lx, y - 1, lx + 4, y - 1); }
      else doc.rect(lx + 0.3, y - 2.3, 2.6, 2.6, "F");
      doc.text(T(txt), lx + 5, y);
      lx += tw;
    }
    y += 7;

    const ensure = (h) => { if (y + h > pageH - bottom) { doc.addPage(); y = 20; } };
    const heading = (t, need = 30) => {
      ensure(need);
      set(11, "bold", C.accent); doc.text(T(t), M, y);
      doc.setDrawColor(...C.accent); doc.setLineWidth(0.4); doc.line(M, y + 1.6, M + W, y + 1.6);
      y += 4.5;
    };
    const table = (opts) => {
      doc.autoTable({
        startY: y, margin: { left: M, right: M, top: 20, bottom }, theme: "plain",
        styles: { font: "helvetica", fontSize: 8.5, cellPadding: { top: 1.3, bottom: 1.3, left: 1.5, right: 1.5 }, textColor: C.ink, lineColor: C.line, lineWidth: { bottom: 0.15 }, overflow: "linebreak" },
        headStyles: { fillColor: C.accent, textColor: 255, fontStyle: "bold", lineWidth: 0 },
        ...opts,
        body: opts.body.map((row) => row.map((cell) => (cell && typeof cell === "object" ? { ...cell, content: T(cell.content) } : T(cell)))),
        head: opts.head && opts.head.map((row) => row.map(T)),
      });
      y = doc.lastAutoTable.finalY + 6;
    };
    const kvStyles = { 0: { textColor: C.muted, cellWidth: 40 }, 1: { cellWidth: 50, fontStyle: "bold" }, 2: { textColor: C.muted, cellWidth: 40 }, 3: { fontStyle: "bold" } };

    // caractéristiques du projet
    heading("Caractéristiques du projet");
    const prixTxt = d.p <= d.pr.pSeuil ? `${fmt(d.pr.cMl, 0)} €/m (jusqu'à ${fmt(d.pr.pSeuil)} MW)` : `${fmt(d.pr.cMl2, 0)} €/m (au-delà de ${fmt(d.pr.pSeuil)} MW)`;
    table({
      body: [
        ["Nom du projet", nom, "Commune", ville || "—"],
        ["Puissance d'injection", `${fmt(d.p)} MW`, "Coordonnées (WGS84)", `${d.site.lat.toFixed(5)}, ${d.site.lon.toFixed(5)}`],
        ["Départs HTA", `${c.dep} (${fmt(d.pr.pDep)} MW max par départ)`, "Prix liaison HTA", prixTxt],
        ["Cellule départ poste source", `${fmt(d.pr.cCell / 1e3, 0)} k€`, "Poste de livraison", `${fmt(d.pr.cPdl / 1e3, 0)} k€`],
      ],
      columnStyles: kvStyles,
    });
    if (d.p > 17) { set(8, "normal", C.part); doc.text(T("Au-delà de 17 MW, un raccordement en HTB est à étudier."), M, y - 3); y += 2; }

    // estimation du coût
    heading(`Estimation du coût de raccordement — ${P.nom}`, 60);
    const src = P.route !== null ? `trajet piéton ${P.routeSrc === "OSM" ? "OSM" : "IGN"}` : `vol d'oiseau × ${fmt(d.pr.kDet, 2)}, itinéraire indisponible`;
    set(8.5, "normal", C.ink); y += 1;
    doc.text(T(`Distance à vol d'oiseau : ${kmTxt(P.d)}   ·   Trajet piéton : ${P.route !== null ? kmTxt(P.route) : "indisponible"}   ·   Longueur retenue : ${kmTxt(c.L_m)}`), M, y);
    y += 3;
    const sub = { fontStyle: "bold", fillColor: C.band };
    table({
      head: [["Poste de coût", "Base de calcul", "Montant"]],
      body: [
        ["Quote-part S3REnR", c.qp !== null ? `${fmt(c.qp, 2)} k€/MW × ${fmt(d.p)} MW` : "quote-part non publiée", kE(c.qpart)],
        ["Liaison HTA souterraine", `${c.dep > 1 ? c.dep + " départs × " : ""}${kmTxt(c.L_m)} × ${fmt(c.prixMl, 0)} €/m (${src})`, kE(c.liaison)],
        [`Cellule${c.dep > 1 ? "s" : ""} départ au poste source`, `${c.dep} × ${fmt(d.pr.cCell / 1e3, 0)} k€`, kE(c.cell)],
        [{ content: "Raccordement", styles: sub }, { content: "", styles: sub }, { content: kE(c.raccord), styles: sub }],
        ["Poste de livraison", "", kE(c.pdl)],
        [{ content: "Total avec poste de livraison", styles: { ...sub, textColor: C.accent } }, { content: "", styles: sub }, { content: kE(c.total), styles: { ...sub, textColor: C.accent } }],
      ],
      columnStyles: { 0: { cellWidth: 55 }, 2: { halign: "right", cellWidth: 28 } },
      headStyles: { fillColor: C.accent, textColor: 255, fontStyle: "bold", lineWidth: 0 },
      didParseCell: (h) => { if (h.section === "head" && h.column.index === 2) h.cell.styles.halign = "right"; },
    });
    const warn = [];
    if (P.cls !== "ok") warn.push(`Capacité réservée restante du poste (${fmt(P.cap)} MW) inférieure à la puissance du projet (${fmt(d.p)} MW).`);
    if (P.route === null) warn.push("Itinéraire indisponible : longueur estimée à partir de la distance à vol d'oiseau.");
    if (P.moved) warn.push("Position du poste corrigée à la main (Capareseau donne une position approximative).");
    if (warn.length) { set(8, "normal", C.part); const t = doc.splitTextToSize(T(warn.join(" ")), W); doc.text(t, M, y - 2); y += t.length * 3.6 + 1; }

    // informations du poste source
    heading(`Poste source ${P.nom}`, 55);
    const v = P.v, num = (x) => { const n = parseFloat(String(x ?? "").replace(",", ".").replace(/[^\d.\-]/g, "")); return Number.isFinite(n) ? n : null; };
    const mw = (x) => (num(x) === null ? "—" : `${fmt(num(x))} MW`);
    const body = [
      ["Code Capareseau", P.code, "Région", d.regionNom(P.r)],
      ["Gestionnaire", P.grd, "Tension", P.ht || "—"],
      ["Reste à affecter S3REnR", mw(v.INFO_NA), "Capacité réservée S3REnR", mw(v.INFO_CR)],
      ["Taux de remplissage", v.INFO_TX || "—", "File d'attente S3REnR", mw(v.INFO_FAS3R)],
      ["En service S3REnR", mw(v.INFO_ESS3R), "Quote-part actualisée", num(v.INFO_QP) === null ? "—" : `${fmt(num(v.INFO_QP), 2)} k€/MW`],
      ["Dispo. sans travaux (RTE)", mw(v.RTE_CDR), "Dispo. sans travaux (GRD)", mw(v.GRD1_CDR)],
      ["Position", `${P.lat.toFixed(5)}, ${P.lon.toFixed(5)}`, "Origine de la position", P.moved ? "corrigée à la main" : "Capareseau"],
      ["Mise à jour Capareseau", P.up || "—", "Poste en projet S3REnR", P.pj === "1" ? "oui" : "non"],
    ];
    if (v.RTE_TVX && !/sans objet/i.test(v.RTE_TVX)) body.push(["Travaux S3REnR", { content: v.RTE_TVX, colSpan: 3 }]);
    if (v.GRD1_TVX) body.push(["Travaux GRD", { content: v.GRD1_TVX, colSpan: 3 }]);
    table({ body, columnStyles: kvStyles });

    // récapitulatif
    heading("Tableau récapitulatif des postes affichés", 45);
    table({
      head: [["#", "Poste", "GRD", "Reste à affecter", "Rempl.", "Vol d'oiseau", "Trajet", "Quote-part", "Raccordement", "Avec PDL"]],
      body: d.postes.map((p, i) => [String(i + 1), p.nom + (p.moved ? " *" : ""), p.grd, `${fmt(p.cap)} MW`, p.v.INFO_TX || "—", kmTxt(p.d), p.route !== null ? kmTxt(p.route) : "—",
        p.cost.qp !== null ? `${fmt(p.cost.qp, 2)} k€/MW` : "—", kE(p.cost.raccord), kE(p.cost.total)]),
      styles: { font: "helvetica", fontSize: 7.6, cellPadding: { top: 1.3, bottom: 1.3, left: 1.2, right: 1.2 }, textColor: C.ink, lineColor: C.line, lineWidth: { bottom: 0.15 }, overflow: "linebreak" },
      columnStyles: { 0: { cellWidth: 6 }, 1: { cellWidth: 40 }, 2: { cellWidth: 15 }, 3: { halign: "right" }, 4: { halign: "right" }, 5: { halign: "right" }, 6: { halign: "right" }, 7: { halign: "right" }, 8: { halign: "right" }, 9: { halign: "right" } },
      didParseCell: (h) => {
        if (h.section === "head" && h.column.index >= 3) h.cell.styles.halign = "right";
        if (h.section === "body") {
          if (h.row.index === d.sel) { h.cell.styles.fillColor = C.selRow; h.cell.styles.fontStyle = "bold"; }
          if (h.column.index === 3) h.cell.styles.textColor = clsColor(d.postes[h.row.index].cls);
        }
      },
    });
    set(7.5, "normal", C.muted);
    const nt = doc.splitTextToSize(T(`Ligne surlignée : poste étudié.${d.postes.some((p) => p.moved) ? " * position corrigée à la main." : ""} Montants calculés avec les mêmes hypothèses pour chaque poste ; trajet « — » : longueur estimée.`), W);
    doc.text(nt, M, y - 3); y += nt.length * 3.3;

    // projets
    if (!d.projets.length) {
      heading(`Projets PV dans un rayon de ${fmt(d.pr.radius, 0)} km`, 16);
      set(8.5, "normal", C.ink);
      doc.text(T(`Aucun projet PV publié sur projets-environnement.gouv.fr${d.projYears ? " depuis moins de 5 ans" : ""} dans ce rayon.`), M, y + 1); y += 8;
    } else {
      heading(`Projets PV dans un rayon de ${fmt(d.pr.radius, 0)} km`, 35);
      const list = d.projets.slice(0, 20);
      table({
        head: [["Repère", "Projet", "Statut", "Date", "Puissance", "Distance"]],
        body: list.map((p) => [p.label + (p.onMap ? "" : " (hors carte)"), p.title, p.statut || "—", p.date || "—", p.puissance || "—", kmTxt(p.d)]),
        styles: { font: "helvetica", fontSize: 7.6, cellPadding: { top: 1.2, bottom: 1.2, left: 1.2, right: 1.2 }, textColor: C.ink, lineColor: C.line, lineWidth: { bottom: 0.15 }, overflow: "linebreak" },
        headStyles: { fillColor: C.proj, textColor: 255, fontStyle: "bold", lineWidth: 0 },
        columnStyles: { 0: { cellWidth: 16 }, 1: { cellWidth: 70 }, 3: { cellWidth: 18 }, 4: { cellWidth: 18 }, 5: { cellWidth: 17, halign: "right" } },
      });
      if (d.projets.length > list.length) { set(7.5, "normal", C.muted); doc.text(T(`… et ${d.projets.length - list.length} autre(s) projet(s), visibles dans l'outil.`), M, y - 3); y += 2; }
    }

    // hypothèses, sources, limites
    heading("Hypothèses, sources et limites", 40);
    set(7.6, "normal", C.muted);
    const notes = [
      `Capacités d'accueil, quote-part et travaux : Capareseau (RTE et gestionnaires de distribution), extraction du ${d.extraction || "—"}, mise à jour du poste étudié le ${P.up || "—"}. Les capacités évoluent en continu : seule une demande de raccordement (proposition technique et financière) engage le gestionnaire de réseau.`,
      `Coût : quote-part S3REnR × puissance d'injection, plus liaison HTA souterraine sur la longueur du trajet piéton (${fmt(d.pr.cMl, 0)} €/m jusqu'à ${fmt(d.pr.pSeuil)} MW d'injection, ${fmt(d.pr.cMl2, 0)} €/m au-delà ; ${fmt(d.pr.pDep)} MW max par départ), cellule(s) départ à ${fmt(d.pr.cCell / 1e3, 0)} k€ et poste de livraison à ${fmt(d.pr.cPdl / 1e3, 0)} k€. Ordres de grandeur pour une pré-étude, hors renforcements, études et frais de gestion.`,
      "Trajet : itinéraire piéton IGN Géoplateforme (BD TOPO), à défaut OSRM (OpenStreetMap). Il approxime le tracé sous voirie et ne tient pas compte des traversées (voies ferrées, autoroutes, cours d'eau) ni des contraintes de pose.",
      `Projets : projets-environnement.gouv.fr (dossiers soumis à évaluation environnementale)${d.projets.some((p) => p.kind !== "pe") ? " et projets ajoutés par l'utilisateur" : ""}. Fond de carte : ${map ? map.attr : "—"}.`,
    ];
    for (const t of notes) { const L = doc.splitTextToSize(T(t), W); ensure(L.length * 3.4 + 2); doc.text(L, M, y); y += L.length * 3.4 + 1.6; }
    ensure(10);
    set(7.6, "bold", C.accent); doc.textWithLink(T("Ouvrir cette analyse dans Raccord PV"), M, y + 1, { url: d.url });
    set(6.5, "normal", C.muted); const ul = doc.splitTextToSize(d.url, W); doc.text(ul.slice(0, 3), M, y + 4.5);

    // pieds de page
    const nP = doc.getNumberOfPages();
    for (let i = 1; i <= nP; i++) {
      doc.setPage(i);
      doc.setDrawColor(...C.line); doc.setLineWidth(0.2); doc.line(M, pageH - 12, M + W, pageH - 12);
      set(7, "normal", C.muted);
      doc.text(T(`Raccord PV · ${nom} · pré-étude indicative, ne remplace pas l'étude du gestionnaire de réseau`), M, pageH - 8, { maxWidth: W - 20 });
      doc.text(`${i} / ${nP}`, M + W, pageH - 8, { align: "right" });
    }

    const slug = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
    const file = `Raccord-PV_${slug(d.nom || "projet")}_${slug(P.nom)}_${new Date().toISOString().slice(0, 10)}.pdf`;
    if (d.output === "blob") return { blob: doc.output("blob"), file, pages: nP };
    doc.save(file);
    return { file, pages: nP };
  }

  window.RaccordReport = { generate, loadLibs };
})();
