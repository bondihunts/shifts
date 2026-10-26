// Tests des fonctions de dates, jours fériés et CSV : node tests/commun.test.js
const assert = require("assert");
const C = require("../site/commun.js");
let n = 0;
const ok = (cond, label) => { assert.ok(cond, "ÉCHEC : " + label); n++; console.log("ok - " + label); };
const iso = d => d.toISOString();

ok(iso(C.depuisParis(2026, 10, 10, 9, 0)) === "2026-10-10T07:00:00.000Z", "heure d'été : Paris = UTC+2");
ok(iso(C.depuisParis(2026, 1, 15, 9, 0)) === "2026-01-15T08:00:00.000Z", "heure d'hiver : Paris = UTC+1");
ok(iso(C.debutMois(2026, 11)) === "2026-10-31T23:00:00.000Z", "début de mois en heure de Paris");
ok(C.depuisParisInfo(2026, 3, 29, 2, 30).inexistante, "29/03 02:30 n'existe pas (passage à l'heure d'été)");
ok(C.depuisParisInfo(2026, 10, 25, 2, 30).ambigue, "25/10 02:30 existe deux fois (passage à l'heure d'hiver)");
ok(!C.depuisParisInfo(2026, 10, 25, 9, 0).ambigue && !C.depuisParisInfo(2026, 10, 25, 9, 0).inexistante, "heure normale ni ambiguë ni inexistante");
ok(iso(C.paques(2026)) === "2026-04-05T00:00:00.000Z", "Pâques 2026 = 5 avril");
ok(iso(C.paques(2027)) === "2027-03-28T00:00:00.000Z", "Pâques 2027 = 28 mars");
ok(C.estFerie(2026, 5, 14), "Ascension 2026 = 14 mai");
ok(C.estFerie(2026, 5, 25), "Lundi de Pentecôte 2026 = 25 mai");
ok(C.estFerie(2026, 11, 11) && !C.estFerie(2026, 11, 12), "11 novembre férié, 12 non");
// dimanche 25/10/2026 (changement d'heure) de 08:00 à 20:00 = 12 h
ok(C.minutesDimancheFerie(C.depuisParis(2026, 10, 25, 8, 0), C.depuisParis(2026, 10, 25, 20, 0)) === 720, "dimanche entier compté");
// samedi 24/10 20:00 -> dimanche 25/10 08:00 : 8 h le dimanche (car 1 h de plus cette nuit-là)
ok(C.minutesDimancheFerie(C.depuisParis(2026, 10, 24, 20, 0), C.depuisParis(2026, 10, 25, 8, 0)) === 540, "nuit samedi-dimanche : seule la part du dimanche (9 h réelles, nuit du changement d'heure)");
ok(C.minutesDimancheFerie(C.depuisParis(2026, 10, 13, 8, 0), C.depuisParis(2026, 10, 13, 18, 0)) === 0, "mardi ordinaire : 0");
ok(C.minutesDimancheFerie(C.depuisParis(2026, 10, 31, 20, 0), C.depuisParis(2026, 11, 1, 8, 0)) === 480, "nuit vers la Toussaint (dimanche + férié) : 8 h");
ok(C.celluleCsv("=HYPERLINK(1)") === `"'=HYPERLINK(1)"`, "CSV : formule neutralisée");
ok(C.celluleCsv('Ana "la"') === `"Ana ""la"""`, "CSV : guillemets échappés");
ok(C.numeroWhatsApp("06 12 34 56 78") === "33612345678", "WhatsApp : 06 -> 33");
ok(C.numeroWhatsApp("+33 6 12 34 56 78") === "33612345678", "WhatsApp : +33 conservé");
ok(C.duree(125) === "2\u00a0h\u00a005", "durée affichée (insécable)");
ok(C.esc('<img src=x onerror="a">') === "&lt;img src=x onerror=&quot;a&quot;&gt;", "échappement HTML");
ok(C.typoTexte("Astuce : ok ? « oui »") === "Astuce\u00a0: ok\u00a0? «\u00a0oui\u00a0»", "typographie française");
ok(C.nombreCsv(1860) === "1860,00" && C.nombreCsv(2.005, 2).length === 4, "nombre CSV sans espace insécable");
ok(C.semaineIso(C.depuisParis(2026, 10, 13, 12, 0)) === "2026-S42", "semaine ISO du 13/10/2026");
ok(C.semaineIso(C.depuisParis(2027, 1, 1, 12, 0)) === "2026-S53", "1er janvier 2027 = semaine 53 de 2026");
ok(C.semaineIso(C.depuisParis(2026, 10, 19, 0, 30)) === "2026-S43", "lundi 00:30 heure de Paris = nouvelle semaine");
ok(C.lundi(C.depuisParis(2026, 11, 1, 10, 0)).toISOString() === C.depuisParis(2026, 10, 26, 0, 0).toISOString(), "dimanche 1er novembre : semaine du lundi 26 octobre");
console.log(`Tous les tests JS sont passés (${n}).`);
