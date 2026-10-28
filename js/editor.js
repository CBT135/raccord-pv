/* Raccord PV — enregistrement des positions corrigées des postes dans le dépôt GitHub.
 *
 * Même principe que carte-pv-bess : écriture de data/postes-corrections.json par l'API GitHub
 * avec un jeton fine-grained (« Contents : Read and write » sur ce seul dépôt). Le jeton n'est
 * jamais publié en clair : il est chiffré (AES-GCM, clé dérivée du mot de passe par PBKDF2-SHA256)
 * dans data/editor.json. Sans le bon mot de passe, la page ne peut pas le déchiffrer, donc pas écrire.
 *
 * API : RaccordEditor.save(changes) où changes = { "84:SSQUE": {lat, lon, n} | null (retour Capareseau) }
 *       → Promise<objet complet enregistré>.  RaccordEditor.open(changes, onSaved) ouvre la fenêtre.
 */
(() => {
  "use strict";
  const host = location.hostname;
  const OWNER = host.endsWith(".github.io") ? host.split(".")[0] : "cbt135";
  const REPO = host.endsWith(".github.io") ? (location.pathname.split("/")[1] || "raccord-pv") : "raccord-pv";
  const API = `https://api.github.com/repos/${OWNER}/${REPO}/contents/`;
  const FILE = "data/postes-corrections.json";
  const ITER = 250000;
  const $ = (s) => document.querySelector(s);

  const b64e = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const b64d = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const utf8b64 = (s) => btoa(unescape(encodeURIComponent(s)));
  const b64utf8 = (s) => decodeURIComponent(escape(atob(s.replace(/\n/g, ""))));
  async function deriveKey(pw, salt) {
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: ITER, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }
  async function encryptToken(token, pw) {
    const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await deriveKey(pw, salt), new TextEncoder().encode(token));
    return { v: 1, kdf: "PBKDF2-SHA256", iter: ITER, salt: b64e(salt), iv: b64e(iv), ct: b64e(ct) };
  }
  async function decryptToken(blob, pw) {
    try {
      const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64d(blob.iv) }, await deriveKey(pw, b64d(blob.salt)), b64d(blob.ct));
      return new TextDecoder().decode(pt);
    } catch (e) { throw new Error("Mot de passe incorrect."); }
  }
  async function gh(path, token, opts = {}) {
    const r = await fetch(API + path + (opts.method ? "" : `?ref=main&t=${Date.now()}`), {
      ...opts, headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28", ...(opts.headers || {}) },
    });
    if (r.status === 404 && !opts.method) return null;
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      if (r.status === 401) throw new Error("Jeton GitHub refusé (expiré ou révoqué) : supprimez data/editor.json du dépôt pour refaire la configuration.");
      if (r.status === 403 || r.status === 404) throw new Error(`Jeton GitHub sans droit d'écriture sur ${OWNER}/${REPO} (permission « Contents : Read and write » requise).`);
      if (r.status === 409) throw new Error("Le fichier a changé pendant l'enregistrement : réessayez.");
      throw new Error(`GitHub ${r.status} : ${j.message || r.statusText}`);
    }
    return r.json();
  }
  const putFile = (path, text, sha, token, message) =>
    gh(path, token, { method: "PUT", body: JSON.stringify({ message, content: utf8b64(text), sha: sha || undefined, branch: "main" }) });

  // fenêtre
  document.body.insertAdjacentHTML("beforeend", `
    <div id="edModal" class="ed-modal" hidden role="dialog" aria-modal="true" aria-labelledby="edTitle"><div class="ed-box">
      <h2 id="edTitle">Enregistrer les positions des postes</h2>
      <p id="edSummary" class="ed-help"></p>
      <div id="edSetup" hidden>
        <p class="ed-help">Première utilisation : collez un jeton GitHub <i>fine-grained</i> limité au dépôt <b>${OWNER}/${REPO}</b>
          avec la permission <b>Contents : Read and write</b>, puis choisissez un mot de passe. Le jeton est chiffré avec ce mot de passe
          et stocké dans <code>data/editor.json</code> ; seul le mot de passe sera demandé ensuite.</p>
        <label for="edTok">Jeton GitHub</label><input id="edTok" type="password" autocomplete="off" placeholder="github_pat_…">
      </div>
      <label for="edPw">Mot de passe</label><input id="edPw" type="password" autocomplete="current-password">
      <div id="edMsg" class="ed-msg" aria-live="polite"></div>
      <div class="ed-row"><button type="button" id="edCopy" class="ghost">Copier le JSON</button><span class="ed-sp"></span>
        <button type="button" id="edCancel" class="ghost">Fermer</button><button type="button" id="edGo" class="ed-primary">Enregistrer</button></div>
    </div></div>`);

  let editorBlob = null, pending = {}, onSaved = null;
  const say = (t, cls = "") => { const m = $("#edMsg"); m.textContent = t; m.className = "ed-msg " + cls; };

  async function open(changes, cb) {
    pending = changes; onSaved = cb;
    const n = Object.keys(changes).length, back = Object.values(changes).filter((v) => v === null).length;
    $("#edSummary").textContent = `${n} poste(s) à enregistrer dans ${FILE}${back ? `, dont ${back} retour(s) à la position Capareseau` : ""}. Les corrections seront visibles par tous, sur tous les appareils, environ une minute après l'enregistrement.`;
    say(""); $("#edPw").value = ""; $("#edTok").value = "";
    try { const r = await fetch(`data/editor.json?t=${Date.now()}`, { cache: "no-store" }); editorBlob = r.ok ? await r.json() : null; } catch (e) { editorBlob = null; }
    $("#edSetup").hidden = !!editorBlob;
    $("#edModal").hidden = false;
    setTimeout(() => (editorBlob ? $("#edPw") : $("#edTok")).focus(), 50);
  }
  const close = () => { $("#edModal").hidden = true; };
  $("#edCancel").addEventListener("click", close);
  $("#edModal").addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  $("#edPw").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#edGo").click(); });
  $("#edCopy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(JSON.stringify(pending, null, 1)); say("Modifications copiées (null = retour à la position Capareseau).", "ok"); }
    catch (e) { say("Copie refusée par le navigateur.", "err"); }
  });
  $("#edGo").addEventListener("click", async () => {
    const pw = $("#edPw").value;
    if (!pw) return say("Saisissez le mot de passe.", "err");
    $("#edGo").disabled = true;
    try {
      let token;
      if (editorBlob) {
        say("Vérification du mot de passe…");
        token = await decryptToken(editorBlob, pw);
      } else {
        token = $("#edTok").value.trim();
        if (!token) throw new Error("Collez le jeton GitHub.");
        if (pw.length < 8) throw new Error("Choisissez un mot de passe d'au moins 8 caractères.");
        say("Configuration de l'enregistrement…");
        const blob = await encryptToken(token, pw);
        const cur = await gh("data/editor.json", token);
        await putFile("data/editor.json", JSON.stringify(blob, null, 1) + "\n", cur && cur.sha, token, "Raccord PV : configuration de l'enregistrement depuis la page");
        editorBlob = blob;
      }
      say("Enregistrement…");
      const cur = await gh(FILE, token);
      let remote = {};
      if (cur) { try { remote = JSON.parse(b64utf8(cur.content) || "{}"); } catch (e) { remote = {}; } }
      const today = new Date().toISOString().slice(0, 10);
      for (const [k, v] of Object.entries(pending)) {
        if (v === null) delete remote[k];
        else remote[k] = { lat: v.lat, lon: v.lon, n: v.n, date: today };
      }
      const sorted = Object.fromEntries(Object.keys(remote).sort().map((k) => [k, remote[k]]));
      const n = Object.keys(pending).length;
      await putFile(FILE, JSON.stringify(sorted, null, 1) + "\n", cur && cur.sha, token, `Positions des postes : ${n} correction(s) depuis la page`);
      say("Enregistré. Visible par tous après la mise à jour de GitHub Pages (environ une minute).", "ok");
      if (onSaved) onSaved(sorted);
      setTimeout(close, 2200);
    } catch (e) {
      say(e.message || String(e), "err");
    } finally {
      $("#edGo").disabled = false; $("#edPw").value = "";
    }
  });

  window.RaccordEditor = { open };
})();
