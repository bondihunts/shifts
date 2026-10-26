// Faux Supabase pour visualiser les écrans sans serveur (tests et captures).
// Scénario choisi par ?scenario=... dans l'adresse.
(function () {
  const sc = new URLSearchParams(location.search).get("scenario") || "arrivee";
  const H = h => new Date(Date.now() - h * 3600000).toISOString();
  const P = (y, m, d, h, mi) => window.Commun ? window.Commun.depuisParis(y, m, d, h, mi).toISOString() : new Date().toISOString();
  const etats = {
    arrivee: { ok: true, prenom: "Fatoumata", configure: true, presente: false, longue: false, dernier_type: "depart", dernier_horodatage: H(20), telephone_famille: "06 12 34 56 78" },
    depart: { ok: true, prenom: "Fatoumata", configure: true, presente: true, arrivee: H(3.2), longue: false, dernier_type: "arrivee", dernier_horodatage: H(3.2), telephone_famille: "06 12 34 56 78" },
    oubli: { ok: true, prenom: "Fatoumata", configure: true, presente: true, arrivee: H(25), longue: true, dernier_type: "arrivee", dernier_horodatage: H(25), telephone_famille: "06 12 34 56 78" },
    lien: { ok: false, erreur: "lien_invalide" }
  };
  const reponsesPointer = {
    hors_zone: { ok: false, erreur: "hors_zone", distance_m: 2400 },
    proche: { ok: false, erreur: "hors_zone", distance_m: 320 },
    deja: { ok: false, erreur: "deja_arrivee", arrivee: H(5) },
    reseau: "reseau"
  };
  const now = new Date();
  const p = window.Commun ? window.Commun.parts(now) : { year: 2026, month: 10 };
  const y = p.year, m = p.month;
  const A = [
    { id: "a1", prenom: "Fatoumata", jeton: "0123456789abcdef0123456789abcdef", taux_horaire: 15.5, active: true },
    { id: "a2", prenom: "Inès", jeton: "fedcba9876543210fedcba9876543210", taux_horaire: 14, active: true },
    { id: "a3", prenom: "Maria", jeton: "aaaabbbbccccddddeeeeffff00001111", taux_horaire: null, active: false }
  ];
  const sessions = [
    { assistante_id: "a1", arrivee_id: 1, arrivee: P(y, m, 2, 8, 0), arrivee_source: "app", depart_id: 2, depart: P(y, m, 2, 12, 30), depart_source: "app", duree_min: 270, statut: "ok", suspect: false },
    { assistante_id: "a2", arrivee_id: 3, arrivee: P(y, m, 3, 20, 0), arrivee_source: "app", depart_id: 4, depart: P(y, m, 4, 8, 0), depart_source: "app", duree_min: 720, statut: "ok", suspect: false },
    { assistante_id: "a1", arrivee_id: 5, arrivee: P(y, m, 5, 8, 0), arrivee_source: "app", depart_id: null, depart: null, depart_source: null, duree_min: null, statut: "depart_manquant", suspect: false },
    { assistante_id: "a1", arrivee_id: 6, arrivee: P(y, m, 6, 9, 0), arrivee_source: "admin", depart_id: 7, depart: P(y, m, 6, 12, 0), depart_source: "app", duree_min: 180, statut: "ok", suspect: true },
    { assistante_id: "a2", arrivee_id: 8, arrivee: P(y, m, 7, 8, 0), arrivee_source: "app", depart_id: 9, depart: P(y, m, 8, 8, 0), depart_source: "app", duree_min: 1440, statut: "longue", suspect: false },
    { assistante_id: "a2", arrivee_id: 10, arrivee: H(2), arrivee_source: "app", depart_id: null, depart: null, depart_source: null, duree_min: null, statut: "en_cours", suspect: false }
  ];
  const pointages = [
    { id: 7, assistante_id: "a1", type: "depart", horodatage: P(y, m, 6, 12, 0), distance_m: 12, precision_m: 1, source: "app", appareil: "b2c3d4" },
    { id: 6, assistante_id: "a1", type: "arrivee", horodatage: P(y, m, 6, 9, 0), source: "admin", cree_par: "claire@exemple.fr", note: "Correction : oubli" },
    { id: 11, assistante_id: "a1", type: "arrivee", horodatage: P(y, m, 6, 9, 20), distance_m: 30, precision_m: 18, source: "app", appareil: "a1b2c3", annule_le: H(1), annule_par: "claire@exemple.fr" },
    { id: 2, assistante_id: "a1", type: "depart", horodatage: P(y, m, 2, 12, 30), distance_m: 9, precision_m: 14, source: "app", appareil: "a1b2c3" },
    { id: 1, assistante_id: "a1", type: "arrivee", horodatage: P(y, m, 2, 8, 0), distance_m: 15, precision_m: 20, source: "app", appareil: "a1b2c3" }
  ];
  const tables = {
    assistantes: A,
    reglages: [{ id: 1, adresse: "12 rue des Lilas, 75011 Paris", lat: 48.938, lng: 2.527, rayon_m: 150, duree_max_h: 26, alerte_h: 13, telephone_famille: "06 12 34 56 78", conservation_gps_j: 60 }],
    demandes: [{ id: 1, assistante_id: "a2", type: "depart", horodatage_declare: P(y, m, 9, 17, 30), message: "Téléphone sans batterie", statut: "en_attente", cree_le: H(30) }],
    pointages, tentatives_refusees: [{ id: 1, assistante_id: "a1", type: "arrivee", horodatage: H(30), distance_m: 2450, motif: "Hors zone" }],
    journal: [{ id: 1, quand: H(1), qui: "claire@exemple.fr", table_nom: "pointages", operation: "UPDATE", avant: { type: "arrivee", assistante_id: "a1", horodatage: P(y, m, 6, 9, 20) }, apres: { type: "arrivee", assistante_id: "a1", horodatage: P(y, m, 6, 9, 20), annule_le: H(1) } }]
  };
  const reponse = data => {
    const pr = new Promise(r => setTimeout(() => r({ data, error: null }), 150));
    const b = { then: (a, c) => pr.then(a, c), abortSignal: () => b };
    return b;
  };
  function constructeur(table) {
    let single = false;
    const b = {
      select: () => b, eq: () => b, gte: () => b, lt: () => b, order: () => b, limit: () => b,
      insert: () => b, update: () => b, single: () => { single = true; return b; },
      then: (a, c) => new Promise(r => setTimeout(() => r({ data: single ? tables[table][0] : tables[table], error: null }), 120)).then(a, c)
    };
    return b;
  }
  window.supabase = {
    createClient: () => ({
      rpc: (nom, args) => {
        if (nom === "etat_assistante") return reponse(etats[sc] || etats.arrivee);
        if (nom === "pointer") {
          const r = reponsesPointer[sc];
          if (r === "reseau") { const pr = Promise.resolve({ data: null, error: { message: "Failed to fetch" } }); const b = { then: (a, c) => pr.then(a, c), abortSignal: () => b }; return b; }
          return reponse(r || { ok: true, type: args.p_type, horodatage: new Date().toISOString(), distance_m: 12 });
        }
        if (nom === "mes_heures") return reponse({ ok: true, debut: P(y, m, 1, 0, 0), sessions: sessions.filter(s => s.assistante_id === "a1"), demandes: [{ type: "depart", horodatage: P(y, m, 5, 17, 0), statut: "en_attente" }] });
        if (nom === "declarer") return reponse({ ok: true });
        if (nom === "is_admin") return reponse(true);
        if (nom === "admin_sessions") return reponse(args && new Date(args.p_debut) > new Date(Date.now() - 51 * 3600000) ? sessions.filter(s => s.statut === "en_cours") : sessions);
        if (nom === "admin_traiter_demande") return reponse({ ok: true });
        return reponse(null);
      },
      from: constructeur,
      auth: {
        getSession: async () => ({ data: { session: sc === "connexion" ? null : { user: { email: "admin@exemple.fr" } } } }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
        signInWithPassword: async () => ({ error: null }), signOut: async () => ({}),
        signInWithOtp: async () => ({}), resetPasswordForEmail: async () => ({}), updateUser: async () => ({})
      }
    })
  };
  // Géolocalisation simulée (sur place)
  try {
    Object.defineProperty(navigator, "geolocation", { value: { getCurrentPosition: ok => setTimeout(() => ok({ coords: { latitude: 48.9381, longitude: 2.5271, accuracy: 15 } }), 200) } });
  } catch (e) {}
})();
