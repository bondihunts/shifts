"""Captures d'écran de tous les états, avec un faux Supabase.
Usage : python3 tests/apercu.py [dossier_sortie]
Ne nécessite pas Internet. Signale toute erreur JavaScript."""
import asyncio, os, re, shutil, sys, tempfile, http.server, threading, functools
from playwright.async_api import async_playwright

ICI = os.path.dirname(os.path.abspath(__file__))
RACINE = os.path.join(os.path.dirname(ICI), "site")
SORTIE = sys.argv[1] if len(sys.argv) > 1 else os.path.join(tempfile.gettempdir(), "apercu-pointage")
os.makedirs(SORTIE, exist_ok=True)

site = tempfile.mkdtemp(prefix="site-")
for f in os.listdir(RACINE):
    src = os.path.join(RACINE, f)
    if f in ("tests",): continue
    (shutil.copytree if os.path.isdir(src) else shutil.copy)(src, os.path.join(site, f))
shutil.copy(os.path.join(ICI, "mock-supabase.js"), site)
for page in ("index.html", "admin.html"):
    p = os.path.join(site, page)
    s = open(p, encoding="utf-8").read()
    s = re.sub(r'<script src="https://cdn\.jsdelivr\.net[^>]*></script>',
               '<script src="commun.js"></script><script src="mock-supabase.js"></script>', s)
    open(p, "w", encoding="utf-8").write(s)

class Silencieux(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
Handler = functools.partial(Silencieux, directory=site)
serveur = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=serveur.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{serveur.server_address[1]}"
J = "0123456789abcdef0123456789abcdef"

async def main():
    erreurs = []
    async with async_playwright() as p:
        nav = await p.chromium.launch()
        async def capture(nom, url, largeur=360, hauteur=760, action=None):
            ctx = await nav.new_context(viewport={"width": largeur, "height": hauteur}, device_scale_factor=2,
                                        locale="fr-FR", timezone_id="Europe/Paris", permissions=["geolocation", "clipboard-read", "clipboard-write"])
            pg = await ctx.new_page()
            pg.on("pageerror", lambda e: erreurs.append(f"{nom}: {e}"))
            pg.on("console", lambda m: m.type == "error" and "fonts" not in m.text and erreurs.append(f"{nom}: {m.text}"))
            await pg.route(re.compile(r"https://(fonts|www\.openstreetmap|api-adresse).*"), lambda r: r.abort())
            await pg.goto(BASE + url); await pg.wait_for_timeout(700)
            if action: await action(pg)
            # Contrôles de mise en page : pas de défilement horizontal, pas de chevauchement dans les listes
            larg = await pg.evaluate("document.documentElement.scrollWidth")
            if larg > largeur + 1: erreurs.append(f"{nom}: page trop large ({larg}px pour {largeur}px)")
            chev = await pg.evaluate('''() => [...document.querySelectorAll('.liste-mobile li')].filter(li => li.offsetParent).filter(li => {
                const d = li.querySelector('.droite'); if (!d) return false; const rd = d.getBoundingClientRect();
                return [...li.querySelectorAll('.l1, .l2')].some(t => { const r = t.getBoundingClientRect();
                  return r.right > rd.left + 1 && r.left < rd.right - 1 && r.bottom > rd.top + 1 && r.top < rd.bottom - 1; });
              }).length''')
            if chev: erreurs.append(f"{nom}: {chev} ligne(s) de liste où le texte passe sous le bouton")
            await pg.screenshot(path=os.path.join(SORTIE, nom + ".png"), full_page=True)
            await ctx.close()
        async def clic(sel, attente=900):
            async def f(pg):
                for s in sel if isinstance(sel, list) else [sel]:
                    await pg.click(s); await pg.wait_for_timeout(attente)
            return f
        await capture("a01-arrivee", f"/index.html?a={J}&scenario=arrivee")
        await capture("a02-depart", f"/index.html?a={J}&scenario=depart")
        await capture("a03-oubli-24h", f"/index.html?a={J}&scenario=oubli")
        await capture("a04-sans-lien", "/index.html?scenario=lien")
        await capture("a05-succes", f"/index.html?a={J}&scenario=arrivee", action=await clic("#pointer"))
        await capture("a06-hors-zone", f"/index.html?a={J}&scenario=hors_zone", action=await clic("#pointer"))
        await capture("a07-hors-zone-proche", f"/index.html?a={J}&scenario=proche", action=await clic("#pointer"))
        await capture("a08-deja-arrivee", f"/index.html?a={J}&scenario=deja", action=await clic("#pointer"))
        await capture("a09-reseau", f"/index.html?a={J}&scenario=reseau", action=await clic("#pointer"))
        await capture("a10-mes-heures", f"/index.html?a={J}&scenario=depart", action=await clic("#l-heures"))
        await capture("a11-declarer", f"/index.html?a={J}&scenario=depart", action=await clic("#l-oubli"))
        await capture("a12-vos-donnees", f"/index.html?a={J}&scenario=depart", action=await clic("#l-donnees"))
        await capture("a13-oubli-declarer", f"/index.html?a={J}&scenario=oubli", action=await clic("#o-oubli"))
        await capture("a14-320px", f"/index.html?a={J}&scenario=depart", largeur=320, hauteur=568)
        await capture("b01-connexion", "/admin.html?scenario=connexion", largeur=375)
        await capture("b02-heures-mobile", "/admin.html", largeur=375, hauteur=812)
        await capture("b03-heures-ordi", "/admin.html", largeur=1280, hauteur=900)
        await capture("b04-pointages-mobile", "/admin.html", largeur=375, action=await clic("#t-pointages"))
        await capture("b05-assistantes-mobile", "/admin.html", largeur=375, action=await clic("#t-assistantes"))
        await capture("b06-reglages-mobile", "/admin.html", largeur=375, action=await clic("#t-reglages"))
        await capture("b07-modale-depart", "/admin.html", largeur=375, action=await clic("[data-ajout]"))
        await capture("b08-modale-modifier", "/admin.html", largeur=1280, action=await clic("#table-sessions [data-modif]"))
        await capture("b09-pointages-ordi", "/admin.html", largeur=1280, action=await clic("#t-pointages"))
        await capture("b10-heures-320", "/admin.html", largeur=320, hauteur=640)
        await capture("b11-pointages-320", "/admin.html", largeur=320, hauteur=640, action=await clic("#t-pointages"))
        await nav.close()
    serveur.shutdown()
    print("Captures dans", SORTIE)
    if erreurs:
        print("ERREURS JS :"); [print(" -", e) for e in erreurs]; sys.exit(1)
    print("Aucune erreur JavaScript.")

asyncio.run(main())
