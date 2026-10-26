// Fonctions partagées par la page des assistantes et l'espace famille.
// Chargé aussi par les tests (node), d'où l'export en bas de fichier.
(function (racine) {
  "use strict";
  const TZ = "Europe/Paris";

  const esc = s => String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const fmt = {
    heure: new Intl.DateTimeFormat("fr-FR", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }),
    jour: new Intl.DateTimeFormat("fr-FR", { timeZone: TZ, weekday: "short", day: "2-digit", month: "2-digit" }),
    jourLong: new Intl.DateTimeFormat("fr-FR", { timeZone: TZ, weekday: "long", day: "numeric", month: "long" }),
    date: new Intl.DateTimeFormat("fr-FR", { timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric" }),
    mois: new Intl.DateTimeFormat("fr-FR", { timeZone: "UTC", month: "long", year: "numeric" })
  };
  const _parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", weekday: "short"
  });
  const JOURS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  // Décompose une date en heure de Paris
  function parts(d) {
    const p = {};
    _parts.formatToParts(d).forEach(x => {
      if (x.type === "weekday") p.jourSemaine = JOURS[x.value];
      else if (x.type !== "literal") p[x.type] = +x.value;
    });
    return p;
  }

  // Heure de Paris -> Date. Renvoie aussi si l'heure est ambiguë ou inexistante
  // (changements d'heure).
  function depuisParisInfo(y, m, d, h, mi) {
    const cible = Date.UTC(y, m - 1, d, h, mi);
    let t = cible;
    for (let i = 0; i < 3; i++) {
      const p = parts(new Date(t));
      t -= Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - cible;
    }
    const p = parts(new Date(t));
    const inexistante = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) !== cible;
    const memeHeure = dt => { const q = parts(new Date(dt)); return Date.UTC(q.year, q.month - 1, q.day, q.hour, q.minute) === cible; };
    const ambigue = !inexistante && (memeHeure(t + 3600000) || memeHeure(t - 3600000));
    return { date: new Date(t), inexistante, ambigue };
  }
  const depuisParis = (y, m, d, h, mi) => depuisParisInfo(y, m, d, h, mi).date;

  const debutMois = (y, m) => depuisParis(y, m, 1, 0, 0);
  const moisSuivant = ({ y, m }) => (m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 });
  const moisPrecedent = ({ y, m }) => (m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 });

  function duree(min) {
    min = Math.round(min || 0);
    return `${Math.floor(min / 60)}\u00a0h\u00a0${String(min % 60).padStart(2, "0")}`;
  }
  const heuresDecimales = min => (Math.round((min || 0) / 60 * 100) / 100);
  const nombre = (n, dec = 2) => n.toLocaleString("fr-FR", { minimumFractionDigits: dec, maximumFractionDigits: dec });
  const euros = n => n.toLocaleString("fr-FR", { style: "currency", currency: "EUR" });
  const pluriel = (n, un, plusieurs) => `${n} ${n > 1 ? plusieurs : un}`;

  // Jours fériés français (métropole)
  function paques(y) {
    const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
    const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
    const mois = Math.floor((h + l - 7 * m + 114) / 31), jour = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(Date.UTC(y, mois - 1, jour));
  }
  const _feries = {};
  function feries(y) {
    if (_feries[y]) return _feries[y];
    const cle = d => d.toISOString().slice(0, 10);
    const p = paques(y);
    const plus = n => cle(new Date(p.getTime() + n * 86400000));
    const s = new Set([`${y}-01-01`, plus(1), `${y}-05-01`, `${y}-05-08`, plus(39), plus(50),
      `${y}-07-14`, `${y}-08-15`, `${y}-11-01`, `${y}-11-11`, `${y}-12-25`]);
    return (_feries[y] = s);
  }
  function estFerie(y, m, d) {
    return feries(y).has(`${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
  }

  // Minutes d'une intervention tombant un dimanche ou un jour férié (heure de Paris)
  function minutesDimancheFerie(debut, fin) {
    let total = 0;
    let t = debut.getTime();
    const f = fin.getTime();
    while (t < f) {
      const p = parts(new Date(t));
      const lendemain = new Date(Date.UTC(p.year, p.month - 1, p.day) + 86400000);
      const minuit = depuisParis(lendemain.getUTCFullYear(), lendemain.getUTCMonth() + 1, lendemain.getUTCDate(), 0, 0).getTime();
      const bout = Math.min(minuit, f);
      if (p.jourSemaine === 0 || estFerie(p.year, p.month, p.day)) total += (bout - t) / 60000;
      t = bout;
    }
    return Math.round(total);
  }

  // Cellule CSV sûre pour Excel (pas d'injection de formule)
  function celluleCsv(v) {
    let s = String(v ?? "");
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return `"${s.replace(/"/g, '""')}"`;
  }

  // Nombre pour Excel français : 1234,50 (sans espace insécable)
  const nombreCsv = (n, dec = 2) => (Math.round(n * 10 ** dec) / 10 ** dec).toFixed(dec).replace(".", ",");

  // Semaine ISO (lundi-dimanche) d'une date, en heure de Paris : "2026-S42"
  function semaineIso(d) {
    const p = parts(d);
    const t = new Date(Date.UTC(p.year, p.month - 1, p.day));
    const j = (t.getUTCDay() + 6) % 7;
    t.setUTCDate(t.getUTCDate() - j + 3);
    const an = t.getUTCFullYear();
    const premier = new Date(Date.UTC(an, 0, 4));
    const n = 1 + Math.round(((t - premier) / 86400000 - 3 + ((premier.getUTCDay() + 6) % 7)) / 7);
    return `${an}-S${String(n).padStart(2, "0")}`;
  }

  // Lundi 00:00 (heure de Paris) de la semaine d'une date
  function lundi(d) {
    const p = parts(d);
    const t = new Date(Date.UTC(p.year, p.month - 1, p.day));
    t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
    return depuisParis(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate(), 0, 0);
  }

  // Numéro pour WhatsApp (format international sans +), France par défaut
  function numeroWhatsApp(tel) {
    let n = String(tel || "").replace(/[^\d+]/g, "");
    if (n.startsWith("+")) return n.slice(1);
    if (n.startsWith("00")) return n.slice(2);
    if (n.startsWith("0")) return "33" + n.slice(1);
    return n;
  }

  // Typographie française : espaces insécables avant : ; ! ? » et après «
  function typoTexte(t) {
    return t.replace(/ ([:;!?»])/g, "\u00a0$1").replace(/« /g, "«\u00a0");
  }
  function typographie(racineDom) {
    if (!racineDom || typeof document === "undefined") return;
    const w = document.createTreeWalker(racineDom, NodeFilter.SHOW_TEXT, {
      acceptNode: n => (n.parentNode && /^(SCRIPT|STYLE|TEXTAREA)$/.test(n.parentNode.nodeName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)
    });
    const noeuds = [];
    while (w.nextNode()) noeuds.push(w.currentNode);
    noeuds.forEach(n => { const v = typoTexte(n.nodeValue); if (v !== n.nodeValue) n.nodeValue = v; });
  }

  const Commun = {
    TZ, esc, fmt, parts, depuisParis, depuisParisInfo, debutMois, moisSuivant, moisPrecedent,
    duree, heuresDecimales, nombre, euros, pluriel, paques, feries, estFerie,
    minutesDimancheFerie, celluleCsv, numeroWhatsApp, typoTexte, typographie, nombreCsv, semaineIso, lundi
  };
  racine.Commun = Commun;
  if (typeof module !== "undefined" && module.exports) module.exports = Commun;
})(typeof window !== "undefined" ? window : globalThis);
