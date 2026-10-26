// Espace famille : heures par assistante, corrections, assistantes, réglages.
(() => {
  "use strict";
  const C = window.Commun;
  const CFG = window.POINTAGE_CONFIG || {};
  const { esc, fmt } = C;
  const $ = id => document.getElementById(id);
  if (!window.supabase) {
    document.body.innerHTML = '<main class="connexion"><div class="message erreur" role="alert"><strong>Chargement impossible</strong><div>Vérifiez la connexion Internet puis rechargez la page.</div></div></main>';
    return;
  }
  const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
  const typo = () => C.typographie(document.body);

  // ---------- État ----------
  const auj = C.parts(new Date());
  let mois = { y: auj.year, m: auj.month };
  let assistantes = [];
  let sessions = [];        // mois affiché
  let sessionsSemaines = []; // semaines complètes autour du mois (pour les 40 h)
  let recents = [];         // 62 derniers jours (pour « À traiter »)
  let pointages = [];
  let refus = [];
  let demandes = [];
  let reglages = null;
  let numeroChargement = 0; // évite d'afficher un mois en retard si on clique vite
  const A_TRAITER = ["longue", "courte", "depart_manquant", "arrivee_manquante"];

  // ---------- Messages (toasts) ----------
  function toast(texte, type = "ok") {
    const z = $("toasts");
    z.innerHTML = "";
    const t = document.createElement("div");
    t.className = "toast " + type;
    t.setAttribute("role", type === "erreur" ? "alert" : "status");
    const s = document.createElement("span"); s.textContent = C.typoTexte(texte); t.appendChild(s);
    const b = document.createElement("button"); b.type = "button"; b.setAttribute("aria-label", "Fermer"); b.textContent = "×";
    b.addEventListener("click", () => t.remove()); t.appendChild(b);
    z.appendChild(t);
    if (type !== "erreur") setTimeout(() => t.remove(), 5000);
  }

  // ---------- Fenêtre modale ----------
  let dernierFocus = null;
  function fermerModale() {
    $("modale-zone").innerHTML = "";
    document.removeEventListener("keydown", toucheModale);
    if (dernierFocus && document.body.contains(dernierFocus)) dernierFocus.focus();
  }
  function toucheModale(e) { if (e.key === "Escape") fermerModale(); }
  // boutons : [{ texte, classe, action: async (form) => (false pour garder ouverte) }] ; le dernier est le principal
  function modale(titre, corps, boutons, opts = {}) {
    dernierFocus = document.activeElement;
    $("modale-zone").innerHTML = `<div class="voile" id="voile"><div class="modale" role="dialog" aria-modal="true" aria-labelledby="m-titre">
      <h2 id="m-titre" tabindex="-1">${esc(titre)}</h2>
      <form id="m-form" novalidate>${corps}
        <p id="m-err" class="message erreur cache" role="alert" style="padding:10px;margin-top:12px"></p>
        <div class="actions">${boutons.map((b, i) =>
          `<button type="${i === boutons.length - 1 ? "submit" : "button"}" class="btn ${b.classe || ""}" data-i="${i}">${esc(b.texte)}</button>`).join("")}</div>
      </form></div></div>`;
    C.typographie($("modale-zone"));
    const form = $("m-form");
    const lancer = async i => {
      const b = boutons[i];
      if (!b.action) return fermerModale();
      $("m-err").classList.add("cache");
      form.querySelectorAll("button").forEach(x => x.disabled = true);
      try {
        const res = await b.action(form);
        if (res !== false) fermerModale();
      } catch (e) {
        $("m-err").textContent = C.typoTexte(e.message || "Une erreur est survenue.");
        $("m-err").classList.remove("cache");
      } finally { form.querySelectorAll("button").forEach(x => x.disabled = false); }
    };
    form.querySelectorAll("button[data-i]").forEach(b => {
      if (b.type === "button") b.addEventListener("click", () => lancer(+b.dataset.i));
    });
    form.addEventListener("submit", e => { e.preventDefault(); lancer(boutons.length - 1); });
    $("voile").addEventListener("click", e => { if (e.target.id === "voile") fermerModale(); });
    document.addEventListener("keydown", toucheModale);
    const tactile = window.matchMedia("(pointer: coarse)").matches;
    if (!tactile && opts.focus && $(opts.focus)) $(opts.focus).focus();
    else if (!tactile && form.querySelector("input, select, textarea")) form.querySelector("input, select, textarea").focus();
    else $("m-titre").focus();
  }
  // titre : texte brut ; texte : HTML déjà échappé
  const confirmer = (titre, texte, ok, action, danger, retour = "Retour") =>
    modale(titre, `<p>${texte}</p>`, [{ texte: retour }, { texte: ok, classe: danger ? "btn-danger" : "btn-plein", action }]);

  // ---------- Accès aux données ----------
  async function q(promesse, doitModifier) {
    const { data, error } = await promesse;
    if (error) {
      if (/JWT|jwt/.test(error.message) || /^PGRST30/.test(error.code || "")) { await sb.auth.signOut(); location.reload(); }
      throw new Error(traduire(error.message));
    }
    if (doitModifier && Array.isArray(data) && !data.length) throw new Error("Aucune modification enregistrée : actualisez la page et réessayez.");
    return data;
  }
  function traduire(m) {
    if (/annulez-le/.test(m)) return "Un pointage ne se modifie pas : il faut le remplacer (bouton « Modifier »).";
    if (/futur/.test(m)) return "Impossible de saisir une heure dans le futur.";
    if (/changé entre-temps/.test(m)) return "Cette intervention a changé entre-temps : la page a été actualisée, recommencez.";
    if (/Failed to fetch|NetworkError|network/i.test(m)) return "Pas de connexion Internet.";
    if (/check constraint|violates/.test(m)) return "Une valeur saisie n'est pas valide.";
    if (/^(Le départ|Durée|Indiquez)/.test(m)) return m;
    return "Opération impossible (" + m + ").";
  }
  const nom = id => (assistantes.find(a => a.id === id) || {}).prenom || "?";
  const qui = e => (e || "la famille").split("@")[0];
  const isoJour = d => { const p = C.parts(d); return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`; };
  const isoHeure = d => { const p = C.parts(d); return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`; };
  function lireDateHeure(jour, heure) {
    if (!jour || !heure) throw new Error("Indiquez le jour et l'heure.");
    const [y, m, d] = jour.split("-").map(Number), [h, mi] = heure.split(":").map(Number);
    const info = C.depuisParisInfo(y, m, d, h, mi);
    if (info.inexistante) throw new Error("Cette heure n'existe pas ce jour-là (passage à l'heure d'été). Choisissez une autre heure.");
    if (info.date.getTime() > Date.now() + 5 * 60000) throw new Error("Impossible de saisir une heure dans le futur.");
    return info;
  }
  const dureeMax = () => ((reglages && reglages.duree_max_h) || 26) * 3600000;

  // ---------- Connexion ----------
  function montrer(vue) {
    ["vue-connexion", "vue-nouveau-mdp", "vue-admin"].forEach(v => $(v).classList.toggle("cache", v !== vue));
  }
  function msgConnexion(texte, ok) {
    const m = $("connexion-msg");
    m.textContent = C.typoTexte(texte); m.className = "message " + (ok ? "ok" : "erreur");
    m.style.cssText = "padding:12px;margin-bottom:12px";
  }
  let recuperation = false;
  sb.auth.onAuthStateChange(evt => {
    if (evt === "PASSWORD_RECOVERY") { recuperation = true; montrer("vue-nouveau-mdp"); }
  });

  async function verifierSession() {
    let session = null;
    try { ({ data: { session } } = await sb.auth.getSession()); } catch (e) {}
    if (recuperation) return;
    if (!session) { montrer("vue-connexion"); return typo(); }
    let admin = false;
    try { admin = await q(sb.rpc("is_admin")); } catch (e) { msgConnexion(e.message); return montrer("vue-connexion"); }
    if (!admin) {
      await sb.auth.signOut();
      msgConnexion("Ce compte n'a pas accès à l'espace famille. Demandez à la personne qui gère l'application de vous ajouter.");
      return montrer("vue-connexion");
    }
    $("qui").textContent = session.user.email;
    montrer("vue-admin");
    await toutCharger();
  }
  $("form-connexion").addEventListener("submit", async e => {
    e.preventDefault();
    const email = $("email").value.trim(), mdp = $("mdp").value;
    if (!email) return msgConnexion("Indiquez votre email.");
    if (!mdp) return msgConnexion("Indiquez votre mot de passe, ou recevez un lien de connexion par email.");
    const { error } = await sb.auth.signInWithPassword({ email, password: mdp });
    if (error) return msgConnexion(/confirm/i.test(error.message) ? "Votre email n'est pas encore confirmé." : "Email ou mot de passe incorrect.");
    verifierSession();
  });
  const retour = () => location.origin + location.pathname;
  $("lien-magique").addEventListener("click", async () => {
    const email = $("email").value.trim();
    if (!email) return msgConnexion("Indiquez d'abord votre email ci-dessus.");
    const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: retour() } });
    if (error && /rate|limit/i.test(error.message)) return msgConnexion("Trop de demandes : réessayez dans une heure.");
    msgConnexion("Si cet email a accès à l'espace famille, un lien de connexion vient de lui être envoyé. Ouvrez-le sur cet appareil.", true);
  });
  $("mdp-oublie").addEventListener("click", async () => {
    const email = $("email").value.trim();
    if (!email) return msgConnexion("Indiquez d'abord votre email ci-dessus.");
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: retour() });
    if (error && /rate|limit/i.test(error.message)) return msgConnexion("Trop de demandes : réessayez dans une heure.");
    msgConnexion("Si cet email a accès à l'espace famille, un lien pour changer le mot de passe vient de lui être envoyé.", true);
  });
  $("form-nouveau-mdp").addEventListener("submit", async e => {
    e.preventDefault();
    const { error } = await sb.auth.updateUser({ password: $("nouveau-mdp").value });
    if (error) return toast("Mot de passe refusé : 8 caractères minimum.", "erreur");
    recuperation = false; toast("Mot de passe enregistré.");
    history.replaceState(null, "", location.pathname);
    verifierSession();
  });
  $("deconnexion").addEventListener("click", async () => { await sb.auth.signOut(); location.replace(location.pathname); });

  // ---------- Onglets ----------
  const onglets = [...document.querySelectorAll("[role=tab]")];
  function ouvrirOnglet(b) {
    if (b.id !== "t-reglages" && reglagesModifies()) {
      return confirmer("Réglages non enregistrés", "Vous avez modifié des réglages sans les enregistrer.", "Quitter sans enregistrer",
        async () => { remplirReglages(); ouvrirOnglet(b); }, true, "Rester");
    }
    onglets.forEach(x => {
      const actif = x === b;
      x.setAttribute("aria-selected", actif); x.tabIndex = actif ? 0 : -1;
      $(x.getAttribute("aria-controls")).classList.toggle("cache", !actif);
    });
    window.scrollTo(0, 0);
  }
  onglets.forEach((b, i) => {
    b.addEventListener("click", () => ouvrirOnglet(b));
    b.addEventListener("keydown", e => {
      const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (d) { const n = onglets[(i + d + onglets.length) % onglets.length]; n.focus(); ouvrirOnglet(n); }
    });
  });

  // ---------- Chargement ----------
  async function toutCharger() {
    try {
      await Promise.all([chargerAssistantes(), chargerReglages()]);
      await Promise.all([chargerMois(), chargerATraiter()]);
      sb.rpc("admin_purger").then(() => {}, () => {}); // effacements RGPD, en arrière-plan
    } catch (e) { toast(e.message, "erreur"); }
  }
  async function chargerAssistantes() {
    assistantes = await q(sb.from("assistantes").select("id, prenom, jeton, taux_horaire, active, alerte_h").order("prenom"));
    rendreAssistantes(); typo();
  }
  async function chargerATraiter() {
    const [d, r] = await Promise.all([
      q(sb.from("demandes").select("*").eq("statut", "en_attente").order("cree_le")),
      q(sb.rpc("admin_sessions", { p_debut: new Date(Date.now() - 62 * 86400000).toISOString(), p_fin: new Date(Date.now() + 60000).toISOString() }))
    ]);
    demandes = d; recents = r;
    rendreTraiter(); rendreSurPlace();
  }
  async function chargerMois() {
    const n = ++numeroChargement;
    const debut = C.debutMois(mois.y, mois.m), suiv = C.moisSuivant(mois), fin = C.debutMois(suiv.y, suiv.m);
    let libelle = fmt.mois.format(new Date(Date.UTC(mois.y, mois.m - 1, 15)));
    libelle = libelle.charAt(0).toUpperCase() + libelle.slice(1);
    $("mois-libelle").textContent = libelle; $("mois-libelle-2").textContent = libelle;
    $("totaux").setAttribute("aria-busy", "true"); $("totaux").style.opacity = ".5";
    const debutSem = C.lundi(debut), finSem = new Date(C.lundi(new Date(fin.getTime() - 1)).getTime() + 7 * 86400000);
    const [s, p, r, sw] = await Promise.all([
      q(sb.rpc("admin_sessions", { p_debut: debut.toISOString(), p_fin: fin.toISOString() })),
      q(sb.from("pointages").select("*").gte("horodatage", debut.toISOString()).lt("horodatage", fin.toISOString())
        .order("horodatage", { ascending: false }).order("id", { ascending: false }).limit(2000)),
      q(sb.from("tentatives_refusees").select("*").gte("horodatage", debut.toISOString()).lt("horodatage", fin.toISOString())
        .order("horodatage", { ascending: false }).limit(500)),
      q(sb.rpc("admin_sessions", { p_debut: debutSem.toISOString(), p_fin: finSem.toISOString() }))
    ]);
    if (n !== numeroChargement) return;
    sessions = s; pointages = p; refus = r; sessionsSemaines = sw;
    $("totaux").removeAttribute("aria-busy"); $("totaux").style.opacity = "";
    rendreHeures(); rendrePointages(); typo();
  }
  async function rafraichir() {
    try { await Promise.all([chargerMois(), chargerATraiter()]); }
    catch (e) { toast(e.message, "erreur"); }
  }
  const changerMois = nouveau => { mois = nouveau; chargerMois().catch(e => toast(e.message, "erreur")); };
  $("mois-prec").addEventListener("click", () => changerMois(C.moisPrecedent(mois)));
  $("mois-suiv").addEventListener("click", () => changerMois(C.moisSuivant(mois)));

  // ---------- Calculs ----------
  const STATUT = {
    ok: ["", ""], en_cours: ["sur place", "vert"], longue: ["durée longue à confirmer", ""], courte: ["durée très courte à confirmer", ""],
    depart_manquant: ["départ non pointé", "rouge"], arrivee_manquante: ["arrivée non pointée", "rouge"]
  };
  const debutSession = s => new Date(s.arrivee || s.depart);
  function bilan(id) {
    const ses = sessions.filter(s => s.assistante_id === id);
    const ok = ses.filter(s => s.statut === "ok");
    const min = ok.reduce((t, s) => t + s.duree_min, 0);
    const dimFer = ok.reduce((t, s) => t + C.minutesDimancheFerie(new Date(s.arrivee), new Date(s.depart)), 0);
    const aVerifier = ses.filter(s => A_TRAITER.includes(s.statut));
    const minAVerifier = aVerifier.reduce((t, s) => t + (s.duree_min || 0), 0);
    // Heures par semaine complète (lundi-dimanche) ; une semaine compte dans le mois de son lundi
    const semaines = {};
    sessionsSemaines.filter(s => s.assistante_id === id && s.statut === "ok").forEach(s => {
      const a = new Date(s.arrivee), lu = C.parts(C.lundi(a));
      if (lu.year !== mois.y || lu.month !== mois.m) return;
      const k = C.semaineIso(a); semaines[k] = (semaines[k] || 0) + s.duree_min;
    });
    const sup40 = Object.values(semaines).reduce((t, m) => t + Math.max(0, m - 40 * 60), 0);
    return { ses, ok, min, dimFer, aVerifier, minAVerifier, semaines, sup40 };
  }

  // ---------- Rendu : sur place et heures ----------
  function rendreSurPlace() {
    const ici = recents.filter(s => s.statut === "en_cours");
    const z = $("sur-place");
    z.classList.toggle("cache", !ici.length);
    z.innerHTML = ici.map(s => {
      const a = new Date(s.arrivee);
      return `🏠 <strong>${esc(nom(s.assistante_id))}</strong> est sur place depuis ${fmt.heure.format(a)}${isoJour(a) !== isoJour(new Date()) ? " (" + esc(fmt.jour.format(a)) + ")" : ""}`;
    }).join("<br>");
  }
  function rendreHeures() {
    const ids = [...new Set([...assistantes.filter(a => a.active).map(a => a.id), ...sessions.map(s => s.assistante_id)])];
    $("totaux").innerHTML = ids.length ? ids.map(id => {
      const a = assistantes.find(x => x.id === id) || {};
      const b = bilan(id);
      const gardes = a.alerte_h >= 24;
      const montant = a.taux_horaire && !gardes ? C.euros(b.min / 60 * a.taux_horaire) : null;
      return `<div class="total">
        <div class="nom">${esc(a.prenom || "?")}</div>
        <div class="heures">${C.duree(b.min)}</div>
        <div class="details">${C.pluriel(b.ok.length, gardes ? "garde ou intervention" : "intervention", gardes ? "gardes ou interventions" : "interventions")}${montant ? ` · <strong>${montant}</strong> net` : gardes ? " · montant selon le contrat" : ""}</div>
        ${b.dimFer ? `<div class="details">dont ${C.duree(b.dimFer)} un dimanche ou jour férié</div>` : ""}
        ${b.sup40 ? `<div class="details sup40">dont ${C.duree(b.sup40)} au-delà de 40 h par semaine</div>` : ""}
        ${b.aVerifier.length ? `<div class="a-verifier"><span class="badge rouge">${C.pluriel(b.aVerifier.length, "point à vérifier", "points à vérifier")}</span>${b.minAVerifier ? `<span class="badge">${C.duree(b.minAVerifier)} pas encore comptées</span>` : ""}</div>` : ""}
      </div>`;
    }).join("") : `<div class="carte"><p>Ajoutez d'abord une assistante dans l'onglet « Assistantes ».</p></div>`;

    const badges = s => {
      const [lib, cl] = STATUT[s.statut] || [s.statut, ""];
      const corrige = s.arrivee_source === "admin" || s.depart_source === "admin";
      return `${lib ? `<span class="badge ${cl}">${esc(lib)}</span> ` : ""}${s.valide ? `<span class="badge gris">durée confirmée</span> ` : ""}${corrige ? `<span class="badge gris">corrigé par la famille</span> ` : ""}${s.suspect ? `<span class="badge" title="Précision GPS anormalement parfaite">position à vérifier</span>` : ""}`;
    };
    const heures = s => `${s.arrivee ? fmt.heure.format(new Date(s.arrivee)) : "—"} → ${s.depart ? fmt.heure.format(new Date(s.depart)) : "—"}${s.depart && isoJour(new Date(s.depart)) !== isoJour(debutSession(s)) ? ` (${esc(fmt.jour.format(new Date(s.depart)))})` : ""}`;
    $("table-sessions").innerHTML = sessions.length ? `
      <thead><tr><th>Date</th><th>Assistante</th><th>Arrivée → départ</th><th>Durée</th><th>État</th><th></th></tr></thead>
      <tbody>${sessions.map((s, i) => `<tr>
          <td>${esc(fmt.jour.format(debutSession(s)))}</td>
          <td>${esc(nom(s.assistante_id))}</td>
          <td class="num">${heures(s)}</td>
          <td class="num">${s.duree_min != null ? C.duree(s.duree_min) : "—"}</td>
          <td>${badges(s)}</td>
          <td>${s.statut !== "en_cours" ? `<button class="btn" type="button" data-modif="${i}">Modifier</button>` : ""}</td>
        </tr>`).join("")}</tbody>` : `<tbody><tr><td class="doux">Aucune intervention ce mois-ci.</td></tr></tbody>`;
    $("liste-sessions").innerHTML = sessions.length ? sessions.map((s, i) => `<li>
        <div class="l1">${esc(fmt.jour.format(debutSession(s))).replace(" ", "\u00a0")}\u00a0· ${esc(nom(s.assistante_id))}</div>
        <div class="droite"><strong>${s.duree_min != null ? C.duree(s.duree_min) : "—"}</strong>
          ${s.statut !== "en_cours" ? `<button class="btn" type="button" data-modif="${i}">Modifier</button>` : ""}</div>
        <div class="l2">${heures(s)} ${badges(s)}</div></li>`).join("") : `<li class="doux">Aucune intervention ce mois-ci.</li>`;
  }
  const clicSessions = e => { const b = e.target.closest("[data-modif]"); if (b) modifierSession(sessions[+b.dataset.modif]); };
  $("table-sessions").addEventListener("click", clicSessions);
  $("liste-sessions").addEventListener("click", clicSessions);

  // ---------- À traiter (62 derniers jours, quel que soit le mois affiché) ----------
  // Une demande d'assistante qui explique une anomalie lui est rattachée
  function demandeLiee(s) {
    const max = dureeMax();
    return demandes.find(d => {
      if (d.assistante_id !== s.assistante_id) return false;
      const t = new Date(d.horodatage_declare).getTime();
      if (s.statut === "depart_manquant" && d.type === "depart") { const a = new Date(s.arrivee).getTime(); return t > a && t - a <= max; }
      if (s.statut === "arrivee_manquante" && d.type === "arrivee") { const dp = new Date(s.depart).getTime(); return t < dp && dp - t <= max; }
      return false;
    });
  }
  let anomaliesAffichees = [];
  function rendreTraiter() {
    anomaliesAffichees = recents.filter(s => A_TRAITER.includes(s.statut));
    const liees = new Set();
    const lignesAno = anomaliesAffichees.map((s, i) => {
      const a = s.arrivee ? new Date(s.arrivee) : null, d = s.depart ? new Date(s.depart) : null;
      const quand = esc(fmt.jourLong.format(a || d));
      const dem = (s.statut === "depart_manquant" || s.statut === "arrivee_manquante") ? demandeLiee(s) : null;
      if (dem) liees.add(dem.id);
      let texte, actions;
      if (s.statut === "depart_manquant") {
        texte = `<strong>${esc(nom(s.assistante_id))}</strong> — ${quand} : arrivée à ${fmt.heure.format(a)}, <strong>départ non pointé</strong>.`;
        actions = `<button class="btn btn-plein" type="button" data-ajout="${i}" data-type="depart">Ajouter l'heure de départ</button>
          <button class="btn" type="button" data-annul="${s.arrivee_id}">Ne pas compter cette arrivée</button>`;
      } else if (s.statut === "arrivee_manquante") {
        texte = `<strong>${esc(nom(s.assistante_id))}</strong> — ${quand} : départ à ${fmt.heure.format(d)}, <strong>arrivée non pointée</strong>.`;
        actions = `<button class="btn btn-plein" type="button" data-ajout="${i}" data-type="arrivee">Ajouter l'heure d'arrivée</button>
          <button class="btn" type="button" data-annul="${s.depart_id}">Ne pas compter ce départ</button>`;
      } else {
        texte = `<strong>${esc(nom(s.assistante_id))}</strong> — ${quand} : ${fmt.heure.format(a)} → ${fmt.heure.format(d)}, soit <strong>${C.duree(s.duree_min)}</strong>. ${s.statut === "longue" ? "Durée inhabituellement longue" : "Durée très courte"} : elle n'est comptée qu'une fois confirmée.`;
        actions = `<button class="btn btn-vert" type="button" data-valider="${s.depart_id}" data-duree="${s.duree_min}">Confirmer ${C.duree(s.duree_min)}</button>
          <button class="btn" type="button" data-modif-recent="${i}">Corriger les heures</button>`;
      }
      if (dem) {
        const t = new Date(dem.horodatage_declare);
        texte += `<br>✉️ ${esc(nom(s.assistante_id))} indique être ${dem.type === "depart" ? "partie" : "arrivée"} à <strong>${fmt.heure.format(t)}</strong>${isoJour(t) !== isoJour(a || d) ? " (" + esc(fmt.jour.format(t)) + ")" : ""}${dem.message ? ` : « ${esc(dem.message)} »` : ""}.`;
        actions = `<button class="btn btn-vert" type="button" data-dem="${dem.id}" data-ok="1">Accepter ${fmt.heure.format(t)}</button>
          <button class="btn" type="button" data-dem="${dem.id}" data-ok="0">Refuser</button>`;
      }
      return `<div class="item-traiter"><div>⚠️ ${texte}</div><div class="actions">${actions}</div></div>`;
    });
    const lignesDem = demandes.filter(d => !liees.has(d.id)).map(d => {
      const t = new Date(d.horodatage_declare);
      return `<div class="item-traiter">
        <div>✉️ <strong>${esc(nom(d.assistante_id))}</strong> signale avoir oublié de pointer son <strong>${d.type === "arrivee" ? "arrivée" : "départ"}</strong> :
          ${esc(fmt.jourLong.format(t))} à <strong>${fmt.heure.format(t)}</strong>${d.message ? `<br><span class="doux">« ${esc(d.message)} »</span>` : ""}</div>
        <div class="actions"><button class="btn btn-vert" type="button" data-dem="${d.id}" data-ok="1">Accepter</button>
          <button class="btn" type="button" data-dem="${d.id}" data-ok="0">Refuser</button></div></div>`;
    });
    const n = lignesAno.length + lignesDem.length;
    $("carte-traiter").classList.toggle("cache", !n);
    $("nb-traiter").textContent = n ? `(${n})` : "";
    const p = $("pastille"); p.textContent = n; p.classList.toggle("cache", !n);
    $("liste-traiter").innerHTML = lignesDem.join("") + lignesAno.join("");
    C.typographie($("carte-traiter"));
  }
  $("liste-traiter").addEventListener("click", async e => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.dem) {
      const d = demandes.find(x => x.id === +b.dataset.dem);
      const accepter = b.dataset.ok === "1";
      const t = new Date(d.horodatage_declare);
      return confirmer(accepter ? "Accepter la demande ?" : "Refuser la demande ?",
        `${esc(nom(d.assistante_id))} : ${d.type === "arrivee" ? "arrivée" : "départ"} le ${esc(fmt.jourLong.format(t))} à ${fmt.heure.format(t)}.
         ${accepter ? "Un pointage sera ajouté à cette heure." : "Aucun pointage ne sera ajouté."}`,
        accepter ? "Accepter" : "Refuser",
        async () => {
          const r = await q(sb.rpc("admin_traiter_demande", { p_id: d.id, p_accepter: accepter }));
          if (!r.ok) throw new Error("Cette demande a déjà été traitée.");
          toast(accepter ? "Demande acceptée, pointage ajouté." : "Demande refusée."); rafraichir();
        }, !accepter);
    }
    if (b.dataset.ajout) return ajouterManquant(anomaliesAffichees[+b.dataset.ajout], b.dataset.type);
    if (b.dataset.annul) return annulerPointage(+b.dataset.annul);
    if (b.dataset.valider) {
      return confirmer("Confirmer la durée ?", `Cette intervention de ${C.duree(+b.dataset.duree)} sera comptée dans le total du mois.`, "Confirmer", async () => {
        await q(sb.from("pointages").update({ valide_le: new Date().toISOString() }).eq("id", +b.dataset.valider).select("id"), true);
        toast("Durée confirmée."); rafraichir();
      });
    }
    if (b.dataset.modifRecent) return modifierSession(anomaliesAffichees[+b.dataset.modifRecent]);
  });

  function champsDateHeure(prefixe, d, libelle, jourSeulement) {
    return `<div class="formulaire" style="margin-top:10px">
      <label class="champ">${libelle ? esc(libelle) + " — jour" : "Jour"} <input type="date" id="${prefixe}-j" value="${d ? isoJour(d) : ""}" max="${isoJour(new Date())}" required></label>
      <label class="champ">Heure <input type="time" id="${prefixe}-h" value="${d && !jourSeulement ? isoHeure(d) : ""}" required></label></div>`;
  }
  async function insererPointage(assistante_id, type, info, note) {
    await q(sb.from("pointages").insert({ assistante_id, type, horodatage: info.date.toISOString(), note: note || null }).select("id"), true);
    if (info.ambigue) toast("Heure du changement d'heure : la première des deux (heure d'été) a été retenue.");
  }
  function ajouterManquant(s, type) {
    const ref = new Date(type === "depart" ? s.arrivee : s.depart);
    modale(type === "depart" ? "Ajouter l'heure de départ" : "Ajouter l'heure d'arrivée",
      `<p>${esc(nom(s.assistante_id))} — ${type === "depart" ? "arrivée" : "départ"} le ${esc(fmt.jourLong.format(ref))} à ${fmt.heure.format(ref)}.</p>
       ${champsDateHeure("x", ref, type === "depart" ? "Départ" : "Arrivée", true)}
       <label class="champ" style="margin-top:10px">Note (facultatif) <input type="text" id="x-note" maxlength="300"></label>`,
      [{ texte: "Retour" }, { texte: "Ajouter", classe: "btn-plein", action: async () => {
        const info = lireDateHeure($("x-j").value, $("x-h").value);
        const ecart = type === "depart" ? info.date - ref : ref - info.date;
        if (ecart <= 0) throw new Error(type === "depart" ? "Le départ doit être après l'arrivée." : "L'arrivée doit être avant le départ.");
        if (ecart > dureeMax()) throw new Error(`L'écart dépasse la durée maximale d'une garde (${dureeMax() / 3600000} h, voir Réglages).`);
        await insererPointage(s.assistante_id, type, info, $("x-note").value.trim());
        toast("Pointage ajouté."); rafraichir();
      } }], { focus: "x-h" });
  }
  function modifierSession(s) {
    const a = s.arrivee ? new Date(s.arrivee) : null, d = s.depart ? new Date(s.depart) : null;
    modale(`Modifier — ${nom(s.assistante_id)}`,
      `<p class="aide">Les pointages d'origine restent visibles (barrés) et sont remplacés par vos corrections.</p>
       ${champsDateHeure("ma", a || d, "Arrivée", !a)}${champsDateHeure("md", d || a, "Départ", !d)}
       <label class="champ" style="margin-top:10px">Motif de la correction <input type="text" id="m-motif" maxlength="250" placeholder="ex. oubli, erreur de bouton"></label>`,
      [{ texte: "Retour" }, { texte: "Enregistrer", classe: "btn-plein", action: async () => {
        const na = lireDateHeure($("ma-j").value, $("ma-h").value);
        const nd = lireDateHeure($("md-j").value, $("md-h").value);
        if (nd.date <= na.date) throw new Error("Le départ doit être après l'arrivée.");
        if (nd.date - na.date > dureeMax()) throw new Error(`Durée supérieure au maximum d'une garde (${dureeMax() / 3600000} h, voir Réglages).`);
        const minute = t => Math.floor(t / 60000);
        if (a && d && minute(na.date) === minute(a) && minute(nd.date) === minute(d)) { toast("Aucun changement."); return true; }
        try {
          await q(sb.rpc("admin_corriger_session", {
            p_assistante: s.assistante_id, p_arrivee_id: s.arrivee_id, p_depart_id: s.depart_id,
            p_arrivee: na.date.toISOString(), p_depart: nd.date.toISOString(), p_motif: $("m-motif").value.trim() || null
          }));
        } catch (e) { if (/changé entre-temps/.test(e.message)) rafraichir(); throw e; }
        toast("Intervention corrigée."); rafraichir();
      } }]);
  }
  function annulerPointage(id) {
    const p = pointages.find(x => x.id === id);
    const desc = p ? `${p.type === "arrivee" ? "L'arrivée" : "Le départ"} de ${esc(nom(p.assistante_id))} du ${esc(fmt.jourLong.format(new Date(p.horodatage)))} à ${fmt.heure.format(new Date(p.horodatage))}` : "Ce pointage";
    confirmer("Ne plus compter ce pointage ?", `${desc} restera visible, barré, mais ne sera plus compté dans les heures.`, "Ne plus compter", async () => {
      await q(sb.from("pointages").update({ annule_le: new Date().toISOString() }).eq("id", id).select("id"), true);
      toast("Pointage retiré du décompte."); rafraichir();
    }, true, "Garder");
  }

  // ---------- Export pour Excel ----------
  $("export").addEventListener("click", () => {
    const n = sessions.filter(s => A_TRAITER.includes(s.statut)).length;
    if (n) {
      return confirmer("Il reste des points à vérifier", `Ce mois-ci, ${n > 1 ? `${n} interventions ne sont pas encore comptées` : "1 intervention n'est pas encore comptée"} (cadre « À traiter »). Télécharger quand même ?`,
        "Télécharger quand même", async () => { telecharger(); });
    }
    telecharger();
  });
  function telecharger() {
    const N = C.nombreCsv;
    const L = [["Assistante", "Date", "Semaine", "Arrivée", "Départ", "Durée (heures)", "Durée (h:min)", "Dont dimanche/férié (heures)", "État", "Corrigé par la famille"]];
    sessions.forEach(s => {
      const a = s.arrivee ? new Date(s.arrivee) : null, d = s.depart ? new Date(s.depart) : null;
      const df = s.statut === "ok" ? C.minutesDimancheFerie(a, d) : 0;
      L.push([nom(s.assistante_id), fmt.date.format(a || d), C.semaineIso(a || d), a ? fmt.heure.format(a) : "",
        d ? fmt.heure.format(d) + (isoJour(d) !== isoJour(a || d) ? " (" + fmt.date.format(d) + ")" : "") : "",
        s.duree_min != null ? N(s.duree_min / 60) : "", s.duree_min != null ? C.duree(s.duree_min) : "",
        df ? N(df / 60) : "",
        s.statut === "ok" ? (s.valide ? "Compté (durée confirmée)" : "Compté") : s.statut === "en_cours" ? "En cours" : "Non compté : " + (STATUT[s.statut] || [s.statut])[0],
        (s.arrivee_source === "admin" || s.depart_source === "admin") ? "oui" : ""]);
    });
    const ids = [...new Set(sessions.map(s => s.assistante_id))];
    L.push([]);
    L.push(["TOTAL DU MOIS", "Heures comptées", "Durée (h:min)", "Dont dimanche/férié", "Dont au-delà de 40 h/semaine", "Taux horaire net", "Montant net (heures × taux)", "Interventions non comptées"]);
    ids.forEach(id => {
      const a = assistantes.find(x => x.id === id) || {}, b = bilan(id);
      L.push([a.prenom || "?", N(b.min / 60), C.duree(b.min), b.dimFer ? N(b.dimFer / 60) : "", b.sup40 ? N(b.sup40 / 60) : "",
        a.taux_horaire ? N(+a.taux_horaire) : "", a.alerte_h >= 24 ? "selon le contrat (gardes)" : a.taux_horaire ? N(b.min / 60 * a.taux_horaire) : "", b.aVerifier.length || ""]);
    });
    L.push([]);
    L.push(["HEURES PAR SEMAINE COMPLÈTE (lundi-dimanche, semaines commençant ce mois-ci)", "Semaine", "Heures comptées", "Au-delà de 40 h"]);
    ids.forEach(id => {
      Object.entries(bilan(id).semaines).sort().forEach(([sem, m]) => L.push([nom(id), sem, N(m / 60), m > 2400 ? N((m - 2400) / 60) : ""]));
    });
    L.push([]);
    L.push(["Une intervention est comptée dans le mois et la semaine de son arrivée. Une semaine à cheval sur deux mois est comptée en entier dans le mois de son lundi."]);
    L.push(["Les majorations (dimanche, jours fériés, heures supplémentaires, présence de nuit) dépendent de la convention collective : à vérifier avant la déclaration CESU."]);
    const csv = "﻿" + L.map(l => l.map(C.celluleCsv).join(";")).join("\r\n");
    const lien = document.createElement("a");
    lien.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    lien.download = `heures-${mois.y}-${String(mois.m).padStart(2, "0")}.csv`;
    document.body.appendChild(lien); lien.click(); lien.remove();
    setTimeout(() => URL.revokeObjectURL(lien.href), 5000);
  }

  // ---------- Rendu : pointages ----------
  function rendrePointages() {
    // Appareil habituel de chaque assistante (le plus fréquent du mois)
    const habituel = {}, compte = {};
    pointages.filter(p => p.appareil && !p.annule_le).forEach(p => {
      const k = p.assistante_id; compte[k] = compte[k] || {};
      compte[k][p.appareil] = (compte[k][p.appareil] || 0) + 1;
    });
    Object.entries(compte).forEach(([k, c]) => { habituel[k] = Object.entries(c).sort((a, b) => b[1] - a[1])[0][0]; });
    const origine = p => {
      const autre = p.appareil && habituel[p.assistante_id] && p.appareil !== habituel[p.assistante_id];
      return (p.source === "admin"
        ? `<span class="badge gris">ajouté par ${esc(qui(p.cree_par))}</span>${p.note ? " " + esc(p.note) : ""}`
        : `${autre ? `<span class="badge gris" title="Pointé depuis un autre téléphone ou navigateur que d'habitude">autre appareil</span> ` : ""}${!p.appareil && new Date(p.cree_le) > new Date("2026-10-14") ? `<span class="badge gris" title="Pointage reçu sans identifiant d'appareil">appareil inconnu</span> ` : ""}${p.precision_m != null && p.precision_m < 2 ? `<span class="badge" title="Précision GPS anormalement parfaite">position à vérifier</span>` : ""}`)
        + (p.annule_le ? ` <span class="badge gris">retiré par ${esc(qui(p.annule_par))}</span>` : "");
    };
    const action = p => p.annule_le
      ? `<button class="btn" type="button" data-retablir="${p.id}" aria-label="Compter à nouveau ce pointage">Recompter</button>`
      : `<button class="btn" type="button" data-annuler="${p.id}" aria-label="Ne plus compter ce pointage">Retirer</button>`;
    const dist = p => (p.distance_m != null ? Math.round(p.distance_m) + " m" : "");
    $("table-pointages").innerHTML = pointages.length ? `
      <thead><tr><th>Date</th><th>Heure</th><th>Assistante</th><th>Type</th><th>Distance</th><th>Origine</th><th></th></tr></thead>
      <tbody>${pointages.map(p => {
        const d = new Date(p.horodatage);
        return `<tr class="${p.annule_le ? "annule" : ""}">
          <td>${esc(fmt.jour.format(d))}</td><td class="num">${fmt.heure.format(d)}</td>
          <td>${esc(nom(p.assistante_id))}</td><td>${p.type === "arrivee" ? "Arrivée" : "Départ"}</td>
          <td class="num">${dist(p) || "—"}</td><td>${origine(p)}</td><td>${action(p)}</td></tr>`;
      }).join("")}</tbody>` : `<tbody><tr><td class="doux">Aucun pointage ce mois-ci.</td></tr></tbody>`;
    $("liste-pointages").innerHTML = pointages.length ? pointages.map(p => {
      const d = new Date(p.horodatage);
      return `<li class="${p.annule_le ? "annule" : ""}">
        <div class="l1">${esc(fmt.jour.format(d)).replace(" ", "\u00a0")}\u00a0· ${fmt.heure.format(d)}</div>
        <div class="droite">${action(p)}</div>
        <div class="l2">${p.type === "arrivee" ? "Arrivée" : "Départ"} · ${esc(nom(p.assistante_id))}${dist(p) ? " · " + dist(p) : ""} ${origine(p)}</div></li>`;
    }).join("") : `<li class="doux">Aucun pointage ce mois-ci.</li>`;

    $("table-refus").innerHTML = refus.length ? `
      <thead><tr><th>Date</th><th>Heure</th><th>Assistante</th><th>Motif</th><th>Distance</th></tr></thead>
      <tbody>${refus.map(r => {
        const d = new Date(r.horodatage);
        const di = r.distance_m == null ? "—" : r.distance_m >= 1000 ? C.nombre(r.distance_m / 1000, 1) + " km" : Math.round(r.distance_m) + " m";
        return `<tr><td class="titre">${esc(fmt.jour.format(d))}</td><td data-l="Heure" class="num">${fmt.heure.format(d)}</td>
          <td data-l="Assistante">${esc(nom(r.assistante_id))}</td><td data-l="Motif">${esc(r.motif)}</td><td data-l="Distance" class="num">${di}</td></tr>`;
      }).join("")}</tbody>` : `<tbody><tr><td class="doux">Aucun pointage refusé ce mois-ci.</td></tr></tbody>`;
  }
  const clicPointages = e => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.annuler) annulerPointage(+b.dataset.annuler);
    if (b.dataset.retablir) confirmer("Compter à nouveau ce pointage ?", "Il sera de nouveau pris en compte dans les heures.", "Compter à nouveau", async () => {
      await q(sb.from("pointages").update({ annule_le: null }).eq("id", +b.dataset.retablir).select("id"), true);
      toast("Pointage rétabli."); rafraichir();
    });
  };
  $("table-pointages").addEventListener("click", clicPointages);
  $("liste-pointages").addEventListener("click", clicPointages);

  $("ajouter-pointage").addEventListener("click", () => {
    const actives = assistantes.filter(a => a.active);
    if (!actives.length) return toast("Ajoutez d'abord une assistante.", "erreur");
    modale("Ajouter un pointage oublié",
      `<div class="pile">
        <label class="champ">Assistante <select id="n-assistante">${actives.map(a => `<option value="${a.id}">${esc(a.prenom)}</option>`).join("")}</select></label>
        <label class="champ">Type <select id="n-type"><option value="arrivee">Arrivée</option><option value="depart">Départ</option></select></label></div>
       ${champsDateHeure("n", new Date(), "", true)}
       <label class="champ" style="margin-top:10px">Note (facultatif) <input type="text" id="n-note" maxlength="300" placeholder="ex. oubli de départ"></label>`,
      [{ texte: "Retour" }, { texte: "Ajouter", classe: "btn-plein", action: async () => {
        const info = lireDateHeure($("n-j").value, $("n-h").value);
        await insererPointage($("n-assistante").value, $("n-type").value, info, $("n-note").value.trim());
        toast("Pointage ajouté.");
        const p = C.parts(info.date); mois = { y: p.year, m: p.month };
        rafraichir();
      } }]);
  });

  // ---------- Journal ----------
  async function chargerJournal() {
    try {
      const j = await q(sb.from("journal").select("*").order("quand", { ascending: false }).limit(60));
      const h = v => (v ? esc(fmt.jour.format(new Date(v)) + " " + fmt.heure.format(new Date(v))) : "—");
      const decrire = l => {
        const v = l.apres || l.avant || {};
        if (l.table_nom === "pointages") {
          if (l.operation === "CORRECTION") return `Intervention de ${esc(nom(v.assistante_id))} corrigée : ${h(l.avant && l.avant.arrivee)} → ${h(l.avant && l.avant.depart)} devient ${h(v.arrivee)} → ${h(v.depart)}`;
          const quoi = `${v.type === "arrivee" ? "arrivée" : "départ"} de ${esc(nom(v.assistante_id))} (${h(v.horodatage)})`;
          if (l.operation === "INSERT") return "Ajout : " + quoi;
          if (l.avant && !l.avant.annule_le && l.apres && l.apres.annule_le) return "Retiré du décompte : " + quoi;
          if (l.avant && l.avant.annule_le && l.apres && !l.apres.annule_le) return "Compté à nouveau : " + quoi;
          if (l.avant && !l.avant.valide_le && l.apres && l.apres.valide_le) return "Durée confirmée : " + quoi;
          return "Modification : " + quoi;
        }
        if (l.table_nom === "demandes") return `Demande de ${esc(nom(v.assistante_id))} ${l.operation === "ACCEPTEE" ? "acceptée" : "refusée"} (${v.type === "arrivee" ? "arrivée" : "départ"} ${h(v.horodatage)})`;
        if (l.table_nom === "assistantes") {
          if (l.operation === "INSERT") return `Assistante ajoutée : ${esc(v.prenom)}`;
          if (l.avant && l.apres && l.avant.active !== l.apres.active) return `${esc(v.prenom)} ${l.apres.active ? "réactivée" : "désactivée"}`;
          return `Fiche de ${esc(v.prenom)} modifiée (prénom, taux, type de travail ou nouveau lien)`;
        }
        if (l.table_nom === "reglages") return "Réglages modifiés";
        return esc(l.table_nom + " " + l.operation);
      };
      $("table-journal").innerHTML = j.length ? `<thead><tr><th>Quand</th><th>Qui</th><th>Quoi</th></tr></thead><tbody>${j.map(l =>
        `<tr><td class="titre">${h(l.quand)}</td><td data-l="Qui">${esc(qui(l.qui))}</td><td data-l="Quoi">${decrire(l)}</td></tr>`).join("")}</tbody>`
        : `<tbody><tr><td class="doux">Aucune modification pour l'instant.</td></tr></tbody>`;
      typo();
    } catch (e) { toast(e.message, "erreur"); }
  }
  $("det-journal").addEventListener("toggle", () => { if ($("det-journal").open) chargerJournal(); });

  // ---------- Assistantes ----------
  const lienPerso = a => { const u = new URL("./", location.href); u.search = "?a=" + a.jeton; u.hash = ""; return u.toString(); };
  async function copierLien(url, libelle) {
    const html = `<a href="${esc(url)}">${esc(libelle)}</a>`;
    try {
      if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
        await navigator.clipboard.write([new ClipboardItem({
          "text/plain": new Blob([url], { type: "text/plain" }),
          "text/html": new Blob([html], { type: "text/html" })
        })]);
        return true;
      }
    } catch (err) {}
    try { await navigator.clipboard.writeText(url); return true; } catch (err) {}
    return false;
  }
  const typeTravail = a => (a.alerte_h && a.alerte_h >= 24 ? "Gardes de 24 h" : "Journée");
  function rendreAssistantes() {
    $("table-assistantes").innerHTML = assistantes.length ? assistantes.map(a => `
      <div class="item-traiter">
        <div><strong style="font-size:18px">${esc(a.prenom)}</strong>
          ${a.active ? "" : ` <span class="badge gris">désactivée</span>`}<br>
          <span class="doux petit">${a.taux_horaire ? C.euros(+a.taux_horaire) + " net de l'heure" : "taux non renseigné"} · ${typeTravail(a)}</span></div>
        <div class="actions">
          ${a.active ? `<button class="btn btn-plein" type="button" data-envoyer="${a.id}">Envoyer le lien</button>
            <button class="btn" type="button" data-copier="${a.id}">Copier le lien</button>` : ""}
          <button class="btn" type="button" data-plus="${a.id}">${a.active ? "Plus…" : "Réactiver ou modifier"}</button>
        </div></div>`).join("") : `<p class="doux">Aucune assistante pour l'instant.</p>`;
  }
  $("form-assistante").addEventListener("submit", async e => {
    e.preventDefault();
    try {
      const prenom = $("a-prenom").value.trim();
      if (!prenom) throw new Error("Indiquez un prénom.");
      const taux = $("a-taux").value ? Number($("a-taux").value) : null;
      await q(sb.from("assistantes").insert({ prenom, taux_horaire: taux }).select("id"), true);
      $("a-prenom").value = ""; $("a-taux").value = "";
      await chargerAssistantes(); rendreHeures();
      toast(`${prenom} ajoutée. Envoyez-lui maintenant son lien personnel.`);
    } catch (x) { toast(x.message, "erreur"); }
  });
  $("table-assistantes").addEventListener("click", async e => {
    const b = e.target.closest("button"); if (!b) return;
    const id = b.dataset.copier || b.dataset.envoyer || b.dataset.plus;
    const a = assistantes.find(x => x.id === id); if (!a) return;
    if (b.dataset.copier) {
      const ok = await copierLien(lienPerso(a), `Pointage ${CFG.NOM_FOYER || ""} – ${a.prenom}`.replace(/\s+/g, " "));
      if (ok) toast("Lien copié. Collez-le dans votre message : il sera cliquable.");
      else modale("Copiez ce lien", `<input type="text" readonly value="${esc(lienPerso(a))}">`, [{ texte: "Fermer" }]);
    }
    if (b.dataset.envoyer) {
      const texte = `Bonjour ${a.prenom}, voici votre lien pour pointer vos arrivées et départs chez ${CFG.NOM_FOYER || "nous"}. Ouvrez-le une fois, autorisez la localisation, puis ajoutez-le à votre écran d'accueil :\n\n${lienPerso(a)}\n`;
      if (navigator.share) { try { await navigator.share({ text: texte }); } catch (err) {} }
      else window.open("https://wa.me/?text=" + encodeURIComponent(texte), "_blank", "noopener,noreferrer");
    }
    if (b.dataset.plus) fiche(a);
  });
  function fiche(a) {
    modale(a.prenom,
      `<div class="pile">
        <label class="champ">Prénom <input type="text" id="e-prenom" maxlength="40" value="${esc(a.prenom)}" required></label>
        <label class="champ">Taux horaire net (€) <input type="number" id="e-taux" step="0.01" min="0" max="500" inputmode="decimal" value="${a.taux_horaire ?? ""}"></label>
        <label class="champ">Type de travail
          <select id="e-type"><option value="">Journée</option>
            <option value="25" ${a.alerte_h >= 24 ? "selected" : ""}>Gardes de 24 h</option></select>
          <span class="aide">Journée : une intervention de plus de ${reglages ? reglages.alerte_h : 13} h est à confirmer (départ oublié ?). Gardes de 24 h : à confirmer au-delà de 25 h ; le montant suit le contrat.</span></label>
      </div>
      <details style="margin-top:12px"><summary>▸ Nouveau lien ou désactivation</summary>
        <div class="actions" style="justify-content:flex-start;margin-top:4px">
          ${a.active ? `<button class="btn" type="button" id="e-regen">Créer un nouveau lien</button>` : ""}
          <button class="btn ${a.active ? "btn-danger" : ""}" type="button" id="e-actif">${a.active ? "Désactiver" : "Réactiver"}</button>
        </div>
        <p class="aide">Nouveau lien : l'ancien ne marche plus (lien perdu ou partagé). Désactiver : elle ne peut plus pointer, son historique est gardé.</p>
      </details>`,
      [{ texte: "Retour" }, { texte: "Enregistrer", classe: "btn-plein", action: async () => {
        const prenom = $("e-prenom").value.trim(); if (!prenom) throw new Error("Indiquez un prénom.");
        await q(sb.from("assistantes").update({
          prenom, taux_horaire: $("e-taux").value ? Number($("e-taux").value) : null,
          alerte_h: $("e-type").value ? Number($("e-type").value) : null
        }).eq("id", a.id).select("id"), true);
        await chargerAssistantes(); rafraichir(); toast("Fiche enregistrée.");
      } }]);
    const regen = $("e-regen");
    if (regen) regen.addEventListener("click", () => confirmer(`Nouveau lien pour ${a.prenom} ?`,
      "L'ancien lien ne fonctionnera plus. Il faudra lui envoyer le nouveau.", "Créer un nouveau lien", async () => {
        await q(sb.from("assistantes").update({ jeton: "nouveau" }).eq("id", a.id).select("id"), true);
        await chargerAssistantes(); toast("Nouveau lien créé. Pensez à l'envoyer (bouton « Envoyer le lien »).");
      }, true));
    $("e-actif").addEventListener("click", () => {
      const f = async () => {
        await q(sb.from("assistantes").update({ active: !a.active }).eq("id", a.id).select("id"), true);
        await chargerAssistantes(); rendreHeures(); toast(a.active ? `${a.prenom} est désactivée.` : `${a.prenom} est réactivée.`);
      };
      if (a.active) confirmer(`Désactiver ${a.prenom} ?`, "Elle ne pourra plus pointer. Son historique d'heures est conservé.", "Désactiver", f, true);
      else f().then(fermerModale, x => toast(x.message, "erreur"));
    });
  }

  // ---------- Réglages ----------
  let reglagesInitiaux = "";
  const valeursReglages = () => JSON.stringify(["r-adresse", "r-lat", "r-lng", "r-rayon", "r-alerte", "r-max", "r-tel", "r-conservation"].map(i => $(i).value));
  const reglagesModifies = () => !!reglagesInitiaux && valeursReglages() !== reglagesInitiaux;
  function majEtatReglages() {
    const m = reglagesModifies();
    $("barre-enregistrer").classList.toggle("modifie", m);
    $("etat-reglages").textContent = m ? "Modifications non enregistrées" : "Réglages à jour";
  }
  $("form-reglages").addEventListener("input", majEtatReglages);
  $("form-reglages").addEventListener("change", majEtatReglages);
  function choisir(sel, v, unite) {
    const s = $(sel);
    if (![...s.options].some(o => o.value === String(v))) s.add(new Option(`${v} ${unite}`, v));
    s.value = String(v);
  }
  function majCarte() {
    const lat = parseFloat($("r-lat").value), lng = parseFloat($("r-lng").value);
    const f = $("r-carte");
    if (isNaN(lat) || isNaN(lng)) { f.classList.add("cache"); $("r-position").textContent = "Position du domicile non réglée."; return; }
    const bbox = [lng - 0.004, lat - 0.0025, lng + 0.004, lat + 0.0025].map(x => x.toFixed(5)).join(",");
    f.src = `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat},${lng}`;
    f.classList.remove("cache");
    $("r-position").textContent = "Vérifiez que le repère est bien sur la maison.";
  }
  function remplirReglages() {
    $("r-adresse").value = reglages.adresse || "";
    $("r-lat").value = reglages.lat ?? ""; $("r-lng").value = reglages.lng ?? "";
    choisir("r-rayon", reglages.rayon_m, "m"); choisir("r-alerte", reglages.alerte_h, "h"); choisir("r-max", reglages.duree_max_h, "h");
    $("r-tel").value = reglages.telephone_famille || "";
    $("r-conservation").value = reglages.conservation_gps_j;
    majCarte();
    reglagesInitiaux = valeursReglages(); majEtatReglages();
  }
  async function chargerReglages() {
    reglages = await q(sb.from("reglages").select("*").eq("id", 1).single());
    remplirReglages();
    if (reglages.lat == null) toast("Première étape : réglez la position du domicile dans l'onglet « Réglages ».", "erreur");
    else if (reglages.derniere_purge && Date.now() - new Date(reglages.derniere_purge) > 8 * 86400000)
      toast("L'effacement automatique des anciennes données ne s'est pas fait depuis plus d'une semaine. Prévenez la personne qui gère l'application.", "erreur");
  }
  $("r-lat").addEventListener("change", majCarte); $("r-lng").addEventListener("change", majCarte);
  $("r-geocoder").addEventListener("click", async () => {
    try {
      const r = await fetch("https://api-adresse.data.gouv.fr/search/?limit=1&q=" + encodeURIComponent($("r-adresse").value));
      const f = (await r.json()).features?.[0];
      if (!f) return toast("Adresse introuvable.", "erreur");
      $("r-lng").value = f.geometry.coordinates[0].toFixed(6); $("r-lat").value = f.geometry.coordinates[1].toFixed(6);
      majCarte(); majEtatReglages(); toast(`Trouvé : ${f.properties.label}. Vérifiez la carte puis enregistrez.`);
    } catch (e) { toast("Recherche d'adresse impossible.", "erreur"); }
  });
  $("r-ici").addEventListener("click", () => {
    if (!navigator.geolocation) return toast("Localisation non disponible sur cet appareil.", "erreur");
    navigator.geolocation.getCurrentPosition(pos => {
      $("r-lat").value = pos.coords.latitude.toFixed(6); $("r-lng").value = pos.coords.longitude.toFixed(6);
      majCarte(); majEtatReglages(); toast(`Position récupérée (précision ± ${Math.round(pos.coords.accuracy)} m). Enregistrez pour valider.`);
    }, () => toast("Impossible d'obtenir la position.", "erreur"), { enableHighAccuracy: true, timeout: 20000 });
  });
  $("form-reglages").addEventListener("submit", async e => {
    e.preventDefault();
    try {
      const lat = parseFloat($("r-lat").value), lng = parseFloat($("r-lng").value);
      if (isNaN(lat) || isNaN(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new Error("Position du domicile invalide : utilisez « Trouver l'adresse sur la carte ».");
      const tel = $("r-tel").value.trim();
      if (tel && !/^\+?[0-9 .]{6,20}$/.test(tel)) throw new Error("Numéro de téléphone invalide.");
      const alerte = +$("r-alerte").value;
      const alerteGardes = Math.max(0, ...assistantes.filter(a => a.active && a.alerte_h).map(a => a.alerte_h));
      if (+$("r-max").value <= alerteGardes) throw new Error(`Une assistante fait des gardes de 24 h : la durée maximale d'une garde doit dépasser ${alerteGardes} h.`);
      const max = Math.max(+$("r-max").value, alerte + 1);
      if (max !== reglages.duree_max_h && !e.confirme) {
        return confirmer("Changer la durée maximale d'une garde ?", "Les mois passés seront recalculés avec cette nouvelle valeur. Il vaut mieux la changer en début de mois.",
          "Enregistrer quand même", async () => { const ev = new Event("submit", { cancelable: true }); ev.confirme = true; $("form-reglages").dispatchEvent(ev); });
      }
      await q(sb.from("reglages").update({
        adresse: $("r-adresse").value.trim(), lat, lng, rayon_m: +$("r-rayon").value,
        alerte_h: alerte, duree_max_h: max, telephone_famille: tel || null,
        conservation_gps_j: Math.min(3650, Math.max(7, parseInt($("r-conservation").value, 10) || 60))
      }).eq("id", 1).select("id"), true);
      await chargerReglages(); toast("Réglages enregistrés."); rafraichir();
    } catch (x) { toast(x.message, "erreur"); }
  });
  window.addEventListener("beforeunload", e => { if (reglagesModifies()) { e.preventDefault(); e.returnValue = ""; } });

  // Rafraîchit en revenant sur l'onglet du navigateur
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !$("vue-admin").classList.contains("cache") && !$("modale-zone").innerHTML) rafraichir();
  });

  verifierSession();
})();
