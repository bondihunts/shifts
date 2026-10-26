// Garde la page des assistantes sur le téléphone pour qu'elle s'ouvre même sans réseau
// (elle affiche alors « Pas de connexion » et les boutons pour prévenir la famille).
// À CHANGER à chaque mise en ligne d'une nouvelle version (v4, v5…)
const CACHE = "pointage-v3";
const FICHIERS = ["./", "index.html", "app.js", "commun.js", "config.js", "style.css", "manifest.webmanifest",
  "icones/icone-192.png", "icones/icone-180.png", "icones/icone-32.png"];
const BIBLIO = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js";

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(async c => {
    await c.addAll(FICHIERS);
    try { await c.add(new Request(BIBLIO, { mode: "cors", credentials: "omit" })); } catch (err) {}
  }).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Bibliothèque externe (version figée) : depuis le téléphone d'abord
  if (url.href === BIBLIO) {
    e.respondWith(caches.match(BIBLIO).then(r => r || fetch(req)));
    return;
  }
  // Seuls les fichiers du site sont gardés ; jamais les échanges avec la base, ni l'espace famille
  if (url.origin !== self.location.origin || /admin/.test(url.pathname)) return;
  // Réseau en priorité, mais pas plus de 4 s d'attente avant de prendre la copie du téléphone
  const delai = new Promise((_, ko) => setTimeout(() => ko(new Error("lent")), 4000));
  e.respondWith(
    Promise.race([fetch(req), delai]).then(rep => {
      if (rep.ok) { const copie = rep.clone(); caches.open(CACHE).then(c => c.put(req, copie)); }
      return rep;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match("index.html")))
  );
});
