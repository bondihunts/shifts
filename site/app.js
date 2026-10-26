// Page des assistantes de vie : pointer son arrivée et son départ.
(() => {
  "use strict";
  const C = window.Commun;
  const CFG = window.POINTAGE_CONFIG || {};
  const { esc, fmt } = C;
  const ecran = document.getElementById("ecran");
  const DELAI_RESEAU_MS = 15000;

  document.getElementById("foyer").textContent = CFG.NOM_FOYER || "Pointage";
  const tic = () => { document.getElementById("horloge").textContent = fmt.heure.format(new Date()); };
  tic(); setInterval(tic, 15000);

  // ---------- Stockage local, toujours protégé ----------
  const local = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} }
  };
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
    : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, c =>
      (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)));

  // ---------- Lien personnel (?a=...) ----------
  // Gardé sur le téléphone et dans l'adresse, pour que l'icône
  // « écran d'accueil » rouvre directement la bonne page.
  const CLE_LIEN = "pointage_lien";
  let jeton = null;
  (function lireJeton() {
    const url = new URL(location.href);
    const a = (url.searchParams.get("a") || "").trim().toLowerCase();
    if (/^[0-9a-f]{32}$/.test(a)) { local.set(CLE_LIEN, a); jeton = a; }
    else jeton = local.get(CLE_LIEN);
    if (jeton && url.searchParams.get("a") !== jeton) {
      url.searchParams.set("a", jeton);
      history.replaceState(null, "", url.pathname + url.search);
    }
  })();
  // Identifiant de ce téléphone, tiré au hasard une fois (aide la famille à repérer un pointage fait ailleurs)
  let appareil = local.get("pointage_appareil");
  if (!appareil) { appareil = uuid(); local.set("pointage_appareil", appareil); }

  let sb = null;
  try {
    sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    });
  } catch (e) { sb = null; }

  // Appel au serveur avec délai maximal. Distingue panne réseau et erreur du serveur.
  class ErreurServeur extends Error {}
  async function rpc(nom, args) {
    if (!sb) throw new Error("hors_ligne");
    const ctrl = new AbortController();
    const minuteur = setTimeout(() => ctrl.abort(), DELAI_RESEAU_MS);
    try {
      const { data, error } = await sb.rpc(nom, args).abortSignal(ctrl.signal);
      if (error) {
        if (error.code && /^(PGRST|[0-9A-Z]{5}$)/.test(error.code)) throw new ErreurServeur(error.message);
        throw new Error(error.message || "reseau");
      }
      return data;
    } finally { clearTimeout(minuteur); }
  }

  let etat = null;          // dernier état connu
  let retourAuto = null;    // minuteur de retour à l'accueil
  // Prénom et téléphone de la famille gardés sur le téléphone : utiles sans réseau
  const memo = { prenom: local.get("pointage_prenom") || "", tel: local.get("pointage_tel") || "" };

  function afficher(html) {
    clearTimeout(retourAuto);
    ecran.innerHTML = html;
    C.typographie(ecran);
    window.scrollTo(0, 0);
  }
  function chargement(texte) {
    afficher(`<div class="chargement" role="status" aria-label="Chargement"></div>
      <p class="doux centre">${esc(texte || "Chargement…")}</p>`);
  }
  function bouton(id, texte, classe = "btn btn-plein btn-large") {
    return `<button class="${classe}" id="${id}" type="button">${texte}</button>`;
  }
  function brancher(id, action) {
    const el = document.getElementById(id);
    if (el) el.addEventListener("click", action);
  }
  function vibrer() { try { navigator.vibrate && navigator.vibrate(30); } catch (e) {} }
  const ilYa = d => {
    const j = fmt.date.format(d), auj = fmt.date.format(new Date()), hier = fmt.date.format(new Date(Date.now() - 86400000));
    return j === auj ? "aujourd'hui" : j === hier ? "hier" : fmt.jourLong.format(d);
  };

  // ---------- Prévenir la famille (fonctionne aussi sans réseau) ----------
  function lienPrevenir(texte) {
    const tel = (etat && etat.telephone_famille) || memo.tel;
    if (!tel) return "";
    const msg = `${(etat && etat.prenom) || memo.prenom || "Assistante"} : ${texte}`;
    const brut = tel.replace(/[^\d+]/g, "");
    const wa = `https://wa.me/${C.numeroWhatsApp(tel)}?text=${encodeURIComponent(msg)}`;
    const sms = `sms:${brut}?&body=${encodeURIComponent(msg)}`;
    return `<div class="carte"><p><strong>Ça ne marche pas ?</strong> Prévenez la famille :</p>
      <div class="trio">
        <a class="btn" href="tel:${esc(brut)}">Appeler</a>
        <a class="btn" href="${esc(sms)}">SMS</a>
        <a class="btn" href="${esc(wa)}" target="_blank" rel="noopener noreferrer">WhatsApp</a>
      </div></div>`;
  }

  function erreur(titre, texte, opts = {}) {
    afficher(`<div class="message erreur" role="alert"><div class="icone" aria-hidden="true">⚠️</div>
        <strong>${esc(titre)}</strong><div>${esc(texte)}</div></div>
      ${opts.bouton ? bouton("e-action", esc(opts.bouton)) : ""}
      ${opts.declarer ? bouton("e-declarer", "Indiquer mon heure à la famille", "btn btn-large") : ""}
      ${opts.retour !== false && etat ? bouton("e-retour", "Retour à l'accueil", "btn btn-large") : ""}
      ${opts.prevenir ? lienPrevenir(opts.prevenir) : ""}`);
    if (opts.bouton) brancher("e-action", opts.action);
    if (opts.declarer) brancher("e-declarer", () => declarer({ type: opts.declarer, maintenant: true }));
    brancher("e-retour", () => accueil());
  }
  const libelle = type => (type === "arrivee" ? "arrivée" : "départ");
  function erreurAppel(e, type, reessai) {
    if (e instanceof ErreurServeur) {
      return erreur("Le serveur a rencontré un problème", "Votre pointage n'a pas été enregistré. Prévenez la famille avec l'heure exacte.",
        { bouton: "Réessayer", action: reessai, declarer: type,
          prevenir: `${type ? libelle(type) + " à " + fmt.heure.format(new Date()) + ", " : ""}l'application affiche une erreur.` });
    }
    return erreur(type ? "Connexion coupée" : "Pas de connexion",
      type ? "Votre pointage a peut-être été enregistré. Appuyez sur « Réessayer » : il ne sera jamais compté deux fois."
           : "Vérifiez que le téléphone est connecté à Internet (Wi-Fi ou données mobiles).",
      { bouton: "Réessayer", action: reessai, retour: !!type,
        prevenir: `${type ? libelle(type) : "arrivée ou départ"} à ${fmt.heure.format(new Date())}, pas de réseau pour pointer.` });
  }

  function lienInvalide() {
    local.del(CLE_LIEN);
    etat = null;
    afficher(`<div class="message info"><div class="icone" aria-hidden="true">🔗</div>
      <strong>Lien personnel nécessaire</strong>
      <div>Ouvrez le lien personnel que la famille vous a envoyé par SMS ou WhatsApp.
      Si vous l'avez déjà fait, demandez-leur de vous le renvoyer.</div></div>
      ${lienPrevenir("mon lien de pointage ne fonctionne plus, pouvez-vous me le renvoyer ?")}`);
  }

  // ---------- Accueil ----------
  async function chargerEtat() {
    const data = await rpc("etat_assistante", { p_jeton: jeton });
    if (!data || !data.ok) { lienInvalide(); return null; }
    etat = data;
    memo.prenom = data.prenom; local.set("pointage_prenom", data.prenom);
    memo.tel = data.telephone_famille || ""; local.set("pointage_tel", memo.tel);
    return data;
  }

  async function accueil(silencieux) {
    if (!jeton) return lienInvalide();
    if (!silencieux) chargement();
    try {
      if (!(await chargerEtat())) return;
    } catch (e) { return erreurAppel(e, null, () => accueil()); }
    if (!etat.configure) {
      return erreur("Application pas encore prête", "La famille doit encore régler la position du domicile.",
        { bouton: "Actualiser", action: () => accueil(), retour: false });
    }
    const arrivee = etat.arrivee ? new Date(etat.arrivee) : null;

    // Arrivée ancienne non clôturée : on demande ce qui s'est passé
    if (etat.presente && etat.longue) return ecranOubli(arrivee);

    const type = etat.presente ? "depart" : "arrivee";
    let statut;
    if (etat.presente) {
      const min = (Date.now() - arrivee.getTime()) / 60000;
      const quand = ilYa(arrivee);
      statut = `Arrivée ${quand === "aujourd'hui" ? "" : esc(quand) + " "}à <strong>${fmt.heure.format(arrivee)}</strong><br><span class="doux">Sur place depuis ${C.duree(Math.max(0, min))}</span>`;
    } else if (etat.dernier_type === "depart") {
      const d = new Date(etat.dernier_horodatage);
      statut = `Dernier départ : ${esc(ilYa(d))} à ${fmt.heure.format(d)}`;
    } else {
      statut = "Vous n'êtes pas encore arrivée.";
    }

    afficher(`<h1>Bonjour ${esc(etat.prenom)}</h1>
      <div class="statut">${statut}</div>
      <button class="grand-bouton ${type}" id="pointer" type="button">
        <span class="icone" aria-hidden="true">${type === "arrivee" ? "🏠" : "👋"}</span>
        ${type === "arrivee" ? "Je suis arrivée" : "Je pars"}
        <small>${type === "arrivee" ? "Pointer mon arrivée" : "Pointer mon départ"}</small>
      </button>
      <nav class="liens-bas" aria-label="Autres actions">
        <button class="lien" id="l-heures" type="button">Mes heures</button>
        <button class="lien" id="l-oubli" type="button">J'ai oublié de pointer</button>
        <button class="lien" id="l-donnees" type="button">Vos données</button>
      </nav>`);
    brancher("pointer", e => { e.currentTarget.disabled = true; vibrer(); pointer(type); });
    brancher("l-heures", () => mesHeures(0));
    brancher("l-oubli", () => declarer());
    brancher("l-donnees", vosDonnees);
  }

  function ecranOubli(arrivee) {
    afficher(`<h1>Bonjour ${esc(etat.prenom)}</h1>
      <div class="statut attention">Vous êtes arrivée <strong>${esc(ilYa(arrivee))} à ${fmt.heure.format(arrivee)}</strong>.
        Votre départ n'a pas encore été pointé.</div>
      <p><strong>Où en êtes-vous ?</strong></p>
      ${bouton("o-pars", "Je suis toujours là, je pars maintenant", "btn btn-large")}
      ${bouton("o-oubli", "J'étais partie, j'avais oublié de pointer", "btn btn-plein btn-large")}
      <nav class="liens-bas"><button class="lien" id="l-heures" type="button">Mes heures</button></nav>`);
    brancher("o-pars", () => pointer("depart"));
    brancher("o-oubli", () => declarer({ type: "depart", depuis: arrivee, ensuite: "arrivee" }));
    brancher("l-heures", () => mesHeures(0));
  }

  // ---------- Pointer ----------
  function position() {
    return new Promise((ok, ko) => {
      if (!navigator.geolocation) return ko({ code: 0 });
      navigator.geolocation.getCurrentPosition(ok, ko, { enableHighAccuracy: true, timeout: 25000, maximumAge: 0 });
    });
  }
  // Une clé unique par tentative : si le réseau coupe, « Réessayer » renvoie la même
  let cles = {};
  function cleTentative(type, nouvelle) {
    const k = "pointage_cle_" + type;
    let v = nouvelle ? null : (local.get(k) || cles[type]);
    if (!v) { v = uuid(); local.set(k, v); cles[type] = v; }
    return v;
  }

  async function pointer(type, opts = {}) {
    const cle = cleTentative(type, !opts.reessai);
    let annule = false;
    afficher(`<div class="chargement" role="status" aria-label="Chargement"></div>
      <p class="centre" id="msg-pos"><strong>Vérification de votre position…</strong><br><span class="doux">Quelques secondes</span></p>
      ${bouton("p-annuler", "Annuler", "btn btn-large")}`);
    brancher("p-annuler", () => { annule = true; accueil(); });
    const lent = setTimeout(() => {
      const m = document.getElementById("msg-pos");
      if (m) { m.innerHTML = "<strong>Le GPS met du temps…</strong><br><span class='doux'>Restez près d'une fenêtre, ça arrive.</span>"; C.typographie(m); }
    }, 8000);

    let pos;
    try { pos = await position(); }
    catch (e) {
      clearTimeout(lent);
      if (annule) return;
      const refus = e && e.code === 1;
      return erreur("Position introuvable",
        refus ? "La localisation est bloquée pour cette page. Ouvrez les réglages du téléphone, autorisez la localisation pour le navigateur, puis réessayez."
              : "Le téléphone n'a pas trouvé votre position. Vérifiez que la localisation est activée, approchez-vous d'une fenêtre et réessayez.",
        { bouton: "Réessayer", action: () => pointer(type, opts), declarer: type,
          prevenir: `${libelle(type)} à ${fmt.heure.format(new Date())}, le pointage ne marche pas (position).` });
    }
    clearTimeout(lent);
    if (annule) return;
    const m = document.getElementById("msg-pos");
    if (m) m.innerHTML = "<strong>Enregistrement…</strong>";
    const b = document.getElementById("p-annuler"); if (b) b.remove();

    let data;
    try {
      data = await rpc("pointer", {
        p_jeton: jeton, p_type: type,
        p_lat: pos.coords.latitude, p_lng: pos.coords.longitude, p_precision: pos.coords.accuracy,
        p_cle: cle, p_forcer: !!opts.forcer, p_appareil: appareil
      });
    } catch (e) {
      return erreurAppel(e, type, () => pointer(type, { ...opts, reessai: true }));
    }
    local.del("pointage_cle_" + type); delete cles[type];
    if (!data || !data.ok) return gererRefus(type, data || {}, opts);
    reussite(data.type || type, new Date(data.horodatage));
  }

  function gererRefus(type, data, opts) {
    switch (data.erreur) {
      case "hors_zone": {
        const d = data.distance_m;
        const dist = d >= 1000 ? `${C.nombre(d / 1000, 1)} km` : `${d} m`;
        return erreur("Vous n'êtes pas au domicile",
          d < 600 ? `Le téléphone vous situe à environ ${dist}. Si vous êtes à l'intérieur, approchez-vous d'une fenêtre et réessayez.`
                  : `Le téléphone vous situe à environ ${dist}. Le pointage se fait uniquement sur place, au domicile.`,
          { bouton: "Réessayer", action: () => pointer(type, opts), declarer: type,
            prevenir: `${libelle(type)} à ${fmt.heure.format(new Date())}, l'app dit que je ne suis pas au domicile.` });
      }
      case "deja_arrivee": {
        const a = new Date(data.arrivee);
        afficher(`<div class="message info"><div class="icone" aria-hidden="true">❓</div>
            <strong>Vous êtes déjà arrivée ${esc(ilYa(a))} à ${fmt.heure.format(a)}</strong>
            <div>Votre départ n'a pas été pointé depuis.</div></div>
          ${bouton("d-pars", "Pointer mon départ", "btn btn-plein btn-large")}
          ${bouton("d-oubli", "J'avais oublié de pointer mon départ", "btn btn-large")}
          ${bouton("d-retour", "Retour", "btn btn-large")}`);
        brancher("d-pars", () => pointer("depart"));
        brancher("d-oubli", () => declarer({ type: "depart", depuis: a, ensuite: "arrivee" }));
        brancher("d-retour", () => accueil());
        return;
      }
      case "pas_arrivee":
        afficher(`<div class="message info"><div class="icone" aria-hidden="true">❓</div>
            <strong>Votre arrivée n'a pas été pointée</strong>
            <div>Indiquez votre heure d'arrivée à la famille, puis pointez votre départ.</div></div>
          ${bouton("p-declarer", "Indiquer mon heure d'arrivée", "btn btn-plein btn-large")}
          ${bouton("p-forcer", "Pointer mon départ quand même", "btn btn-large")}
          ${bouton("p-retour", "Retour", "btn btn-large")}`);
        brancher("p-declarer", () => declarer({ type: "arrivee", ensuite: "depart" }));
        brancher("p-forcer", () => pointer("depart", { forcer: true }));
        brancher("p-retour", () => accueil());
        return;
      case "trop":
        return erreur("Trop de pointages aujourd'hui", "Pour éviter les erreurs, l'application est bloquée pour 24 h. Indiquez votre heure à la famille.",
          { declarer: type, prevenir: `${libelle(type)} à ${fmt.heure.format(new Date())}, l'app me bloque (trop de pointages).` });
      case "position":
        return erreur("Position introuvable", "Activez la localisation et réessayez.", { bouton: "Réessayer", action: () => pointer(type, opts), declarer: type });
      case "lien_invalide":
        return lienInvalide();
      case "non_configure":
        return erreur("Application pas encore prête", "La famille doit régler la position du domicile.");
      default:
        return erreur("Pointage non enregistré", "Une erreur est survenue. Réessayez dans un instant.",
          { bouton: "Réessayer", action: () => pointer(type, opts), declarer: type });
    }
  }

  function reussite(type, quand) {
    vibrer();
    afficher(`<div class="message ok" role="status">
        <div class="icone" aria-hidden="true">✅</div>
        <strong>${type === "arrivee" ? "Arrivée enregistrée" : "Départ enregistré"}</strong>
        <div class="grosse-heure">${fmt.heure.format(quand)}</div>
        <div>${type === "arrivee" ? "Bonne journée ! Pensez à appuyer sur « Je pars » avant de partir." : "Merci et à bientôt !"}</div>
      </div>
      ${bouton("ok", "Terminé")}
      ${aideInstallation()}`);
    brancher("ok", () => accueil());
    brancherInstallation();
    etat = null;
    if (!document.getElementById("aide-install")) retourAuto = setTimeout(() => accueil(), 12000);
  }

  // ---------- Signaler un oubli ----------
  function declarer(opts = {}) {
    const p = C.parts(new Date());
    const iso = q => `${q.year}-${String(q.month).padStart(2, "0")}-${String(q.day).padStart(2, "0")}`;
    const aujourdHui = iso(p);
    const jourDefaut = opts.depuis ? iso(C.parts(opts.depuis)) : aujourdHui;
    const heureDefaut = opts.maintenant ? `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}` : "";
    const type = opts.type || "depart";
    afficher(`<h1>Signaler un oubli</h1>
      <p class="doux">La famille recevra votre message et corrigera vos heures.</p>
      <form id="f-decl" class="pile" novalidate>
        <fieldset class="question">
          <legend>J'ai oublié de pointer mon…</legend>
          <div class="choix">
            <label><input type="radio" name="type" value="arrivee" ${type === "arrivee" ? "checked" : ""}><span>Arrivée</span></label>
            <label><input type="radio" name="type" value="depart" ${type === "depart" ? "checked" : ""}><span>Départ</span></label>
          </div>
        </fieldset>
        <label class="champ">Quel jour ? <input type="date" id="d-jour" value="${jourDefaut}" max="${aujourdHui}" required></label>
        <label class="champ">À quelle heure ? <input type="time" id="d-heure" value="${heureDefaut}" required></label>
        <label class="champ">Message pour la famille (facultatif)
          <textarea id="d-msg" maxlength="300" placeholder="ex. téléphone sans batterie"></textarea></label>
        <p id="d-err" class="message erreur cache" role="alert" style="padding:12px"></p>
        <button class="btn btn-plein btn-large" type="submit">Envoyer à la famille</button>
        <button class="btn btn-large" type="button" id="d-annuler">Retour</button>
      </form>`);
    brancher("d-annuler", () => accueil());
    document.getElementById("f-decl").addEventListener("submit", async e => {
      e.preventDefault();
      const err = document.getElementById("d-err");
      const montrer = t => { err.textContent = t; err.classList.remove("cache"); C.typographie(err); };
      const t = document.querySelector("input[name=type]:checked").value;
      const j = document.getElementById("d-jour").value, h = document.getElementById("d-heure").value;
      if (!j || !h) return montrer("Indiquez le jour et l'heure.");
      const [y, m, d] = j.split("-").map(Number); const [hh, mm] = h.split(":").map(Number);
      const info = C.depuisParisInfo(y, m, d, hh, mm);
      if (info.inexistante) return montrer("Cette heure n'existe pas ce jour-là (changement d'heure). Choisissez une autre heure.");
      const quand = info.date;
      if (quand.getTime() > Date.now() + 5 * 60000) return montrer("Cette heure est dans le futur.");
      if (quand.getTime() < Date.now() - 14 * 86400000) return montrer("L'oubli doit dater de moins de 14 jours. Au-delà, voyez directement avec la famille.");
      if (opts.depuis && t === "depart" && quand < opts.depuis) return montrer(`Le départ ne peut pas être avant l'arrivée (${fmt.heure.format(opts.depuis)}).`);
      const message = document.getElementById("d-msg").value.trim() || null;
      chargement("Envoi…");
      let data;
      try {
        data = await rpc("declarer", { p_jeton: jeton, p_type: t, p_horodatage: quand.toISOString(), p_message: message });
      } catch (x) {
        return erreur("Message non envoyé", "La connexion a été coupée. Réessayez.",
          { bouton: "Réessayer", action: () => declarer(opts), prevenir: `j'ai oublié de pointer mon ${libelle(t)} : ${fmt.jour.format(quand)} à ${fmt.heure.format(quand)}.` });
      }
      if (!data.ok) {
        const msgs = { date: "La date doit être dans les 14 derniers jours.", trop_de_demandes: "Vous avez déjà 10 messages en attente. Contactez la famille." };
        return erreur("Message non envoyé", msgs[data.erreur] || "Une erreur est survenue.", { bouton: "Retour", action: () => declarer(opts) });
      }
      if (opts.ensuite) {
        afficher(`<div class="message ok"><div class="icone" aria-hidden="true">✅</div>
            <strong>Message envoyé à la famille</strong></div>
          <p class="centre">Pointez maintenant votre ${opts.ensuite === "arrivee" ? "arrivée d'aujourd'hui" : "départ"} :</p>
          <button class="grand-bouton ${opts.ensuite}" id="ensuite" type="button">
            <span class="icone" aria-hidden="true">${opts.ensuite === "arrivee" ? "🏠" : "👋"}</span>
            ${opts.ensuite === "arrivee" ? "Je suis arrivée" : "Je pars"}</button>`);
        brancher("ensuite", ev => { ev.currentTarget.disabled = true; vibrer(); pointer(opts.ensuite, { forcer: true }); });
      } else {
        afficher(`<div class="message ok"><div class="icone" aria-hidden="true">✅</div>
            <strong>Message envoyé à la famille</strong><div>Elle corrigera vos heures.</div></div>${bouton("ok", "Terminé")}`);
        brancher("ok", () => accueil());
      }
    });
  }

  // ---------- Mes heures ----------
  async function mesHeures(decalage) {
    chargement();
    let data;
    try { data = await rpc("mes_heures", { p_jeton: jeton, p_decalage: decalage }); }
    catch (e) { return erreurAppel(e, null, () => mesHeures(decalage)); }
    if (!data.ok) return lienInvalide();
    const pd = C.parts(new Date(new Date(data.debut).getTime() + 86400000 * 10));
    let mois = fmt.mois.format(new Date(Date.UTC(pd.year, pd.month - 1, 15)));
    mois = mois.charAt(0).toUpperCase() + mois.slice(1);
    const ok = data.sessions.filter(s => s.statut === "ok");
    const total = ok.reduce((t, s) => t + s.duree_min, 0);
    const autres = data.sessions.filter(s => !["ok", "en_cours"].includes(s.statut));
    const libStatut = { en_cours: ["en cours", "vert"], longue: ["durée à confirmer par la famille", ""], courte: ["durée à confirmer par la famille", ""],
      depart_manquant: ["départ non pointé", "rouge"], arrivee_manquante: ["arrivée non pointée", "rouge"] };
    const ligne = s => {
      const a = s.arrivee ? new Date(s.arrivee) : null, d = s.depart ? new Date(s.depart) : null;
      const [l, c] = libStatut[s.statut] || ["", ""];
      return `<div class="ligne-session"><div><strong>${esc(fmt.jour.format(a || d))}</strong><br>
        <span class="doux">${a ? fmt.heure.format(a) : "—"} → ${d ? fmt.heure.format(d) : "—"}</span>
        ${l ? `<br><span class="badge ${c}">${esc(l)}</span>` : ""}</div>
        <div class="num"><strong>${s.duree_min != null ? C.duree(s.duree_min) : ""}</strong></div></div>`;
    };
    const libDem = { en_attente: ["en attente", ""], acceptee: ["acceptée", "vert"], refusee: ["refusée", "rouge"] };
    afficher(`<h1>Mes heures</h1>
      <div class="barre-mois">
        ${decalage === 0 ? `<button class="btn" id="m-prec" type="button">← Mois précédent</button>` : `<button class="btn" id="m-suiv" type="button">Mois en cours →</button>`}
      </div>
      <div class="message neutre"><div><strong>${esc(mois)}</strong></div><div class="doux">Total compté</div>
        <div class="grosse-heure">${C.duree(total)}</div>
        <div class="doux">${C.pluriel(ok.length, "intervention", "interventions")}</div></div>
      ${autres.length ? `<p class="doux petit">${autres.length > 1 ? `${autres.length} interventions ne sont pas encore comptées` : "1 intervention n'est pas encore comptée"} : la famille doit vérifier.</p>` : ""}
      <div class="carte">${data.sessions.length ? [...data.sessions].reverse().map(ligne).join("") : "<p class='doux'>Aucune intervention ce mois-ci.</p>"}</div>
      ${data.demandes.length ? `<div class="carte"><h2>Mes messages à la famille</h2>${data.demandes.map(d => {
        const [l, c] = libDem[d.statut] || [d.statut, ""];
        const t = new Date(d.horodatage);
        return `<div class="ligne-session"><div>${d.type === "arrivee" ? "Arrivée" : "Départ"} du ${esc(fmt.jour.format(t))} à ${fmt.heure.format(t)}</div><span class="badge ${c}">${esc(l)}</span></div>`;
      }).join("")}</div>` : ""}
      ${bouton("retour", "Retour", "btn btn-large")}`);
    brancher("retour", () => accueil());
    brancher("m-prec", () => mesHeures(-1));
    brancher("m-suiv", () => mesHeures(0));
  }

  // ---------- Vos données (information RGPD) ----------
  function vosDonnees() {
    const jours = (etat && etat.conservation_gps_j) || 60;
    afficher(`<h1>Vos données</h1>
      <div class="carte">
        <p><strong>Pourquoi ?</strong> Pour connaître vos heures de travail au domicile et vous payer.</p>
        <p><strong>Quand ?</strong> Votre position est lue <strong>uniquement</strong> au moment où vous appuyez sur le bouton. Jamais en dehors, jamais en continu.</p>
        <p><strong>Ce qui est gardé :</strong> l'heure de chaque pointage, la distance au domicile, et un code tiré au hasard qui distingue ce téléphone.
          Votre position exacte est effacée au bout de ${jours} jours. Si vous pointez hors du domicile, seule la distance est gardée. Tout est effacé au bout de 3 ans.</p>
        <p><strong>Qui la voit ?</strong> Uniquement la famille qui vous emploie.</p>
        <p><strong>Vos droits :</strong> vous pouvez demander à la famille de voir ou de corriger vos données.</p>
      </div>
      ${bouton("retour", "Retour", "btn btn-large")}`);
    brancher("retour", () => accueil());
  }

  // ---------- Aide « écran d'accueil » (proposée une fois, après un pointage réussi) ----------
  let invitationInstall = null;
  window.addEventListener("beforeinstallprompt", e => {
    e.preventDefault(); invitationInstall = e;
    const zone = document.getElementById("aide-install-actions");
    if (zone && !document.getElementById("installer")) {
      zone.insertAdjacentHTML("afterbegin", `<button class="btn btn-vert" id="installer" type="button">Ajouter maintenant</button>`);
      brancherInstallation();
    }
  });
  const estInstallee = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  function aideInstallation() {
    if (estInstallee() || local.get("pointage_aide_vue")) return "";
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    return `<div class="carte" id="aide-install">
      <p><strong>Astuce :</strong> ajoutez cette page à votre écran d'accueil pour la retrouver en un geste.</p>
      <p class="doux petit">${ios ? "Sur iPhone : bouton Partager ⬆️ puis « Sur l'écran d'accueil »."
        : "Sur Android : menu ⋮ du navigateur puis « Ajouter à l'écran d'accueil »."}</p>
      <div class="actions" id="aide-install-actions">${!ios && invitationInstall ? `<button class="btn btn-vert" id="installer" type="button">Ajouter maintenant</button>` : ""}
        <button class="lien" id="aide-ok" type="button">J'ai compris</button></div></div>`;
  }
  function fermerAide() { local.set("pointage_aide_vue", "1"); const a = document.getElementById("aide-install"); if (a) a.remove(); }
  function brancherInstallation() {
    const ok = document.getElementById("aide-ok");
    if (ok && !ok.dataset.branche) { ok.dataset.branche = "1"; ok.addEventListener("click", fermerAide); }
    const b = document.getElementById("installer");
    if (b && !b.dataset.branche) {
      b.dataset.branche = "1";
      b.addEventListener("click", async () => {
        if (!invitationInstall) return fermerAide();
        invitationInstall.prompt();
        try { await invitationInstall.userChoice; } catch (e) {}
        invitationInstall = null; fermerAide();
      });
    }
  }

  // Rafraîchit l'accueil quand on revient sur l'app
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && document.getElementById("pointer")) accueil(true);
  });

  // Ouverture hors ligne (page gardée sur le téléphone)
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => { navigator.serviceWorker.register("sw.js").catch(() => {}); });
  }

  accueil();
})();
