# Pointage des assistantes de vie — guide (version 3)

## Contenu du dossier `site` (à mettre en ligne sur Netlify)

| Fichier | Rôle |
|---|---|
| `index.html` + `app.js` | Page des assistantes : un gros bouton « Je suis arrivée » / « Je pars » |
| `admin.html` + `admin.js` | Espace famille : heures, corrections, assistantes, réglages |
| `commun.js`, `style.css` | Fonctions et mise en forme partagées |
| `config.js` | Adresse et clé publique du projet Supabase (déjà remplies) |
| `manifest.webmanifest`, `icones/` | Icône et nom de l'app sur l'écran d'accueil |
| `_headers` | Protections de sécurité appliquées par Netlify |
| `sw.js` | Permet d'ouvrir la page des assistantes sans réseau |

À côté du dossier `site` : `supabase.sql` (la base de données, création ou mise à jour), ce guide, et le dossier `tests`.

Le dossier `tests` sert seulement à vérifier l'app. **Ne mets en ligne que le dossier `site`.**

---

## Passer à la version 3 (environ 15 minutes)

Toutes les données actuelles sont conservées : assistantes, liens déjà envoyés, pointages.

1. **Base de données.** Dans Supabase, ouvre **SQL Editor** puis **New query**. Colle tout le fichier `supabase.sql` et clique **Run**. Le message doit être « Success ».
2. **Admins (ta mère, ta tante).** Si tu les avais déjà ajoutées avec la version 1 (email dans la table `admins` et compte confirmé), l'étape 1 les a rattachées automatiquement : vérifie seulement qu'elles arrivent à se connecter. Sinon :
   1. D'abord, crée leur compte : **Authentication → Users → Add user → Create new user**. Indique leur email et un mot de passe provisoire, et coche **Auto Confirm User**.
   2. Ensuite, dans le **SQL Editor**, remplace les deux emails puis clique **Run** :
      ```sql
      insert into public.admins (email, user_id)
      select lower(email), id from auth.users
       where lower(email) in ('email.maman@exemple.fr', 'email.tante@exemple.fr')
         and email_confirmed_at is not null
      on conflict (email) do update set user_id = excluded.user_id;
      ```
      Le message doit indiquer « 2 rows ». Si tu vois « 0 rows », le compte n'existe pas encore ou l'email est mal écrit.

   Si Supabase te répond que le compte existe déjà alors que tu ne l'as pas créé, ne lance pas la requête : quelqu'un d'autre l'a peut-être créé.

   L'accès est rattaché à **ce compte précis**. Même quelqu'un qui créerait un compte avec le même email n'y aurait pas accès.
3. **Réglages de connexion.** Dans **Authentication → URL Configuration** :
   - **Site URL** : `https://ton-site.netlify.app/admin.html`
   - **Redirect URLs** : ajoute `https://ton-site.netlify.app/admin.html`

   Ce réglage fait fonctionner « Recevoir un lien de connexion par email » et « Mot de passe oublié ».

   **Envoi des emails (à faire, sinon ta mère et ta tante dépendront de toi).** Le service d'email intégré à Supabase est très limité : quelques emails par heure, et il peut n'envoyer qu'aux membres de ton équipe Supabase. Pour que ta mère et ta tante reçoivent bien leurs liens de connexion, branche un service d'envoi gratuit, par exemple Brevo ou Resend : **Authentication → Emails → SMTP Settings**. Ensuite, fais le test : ta mère demande un lien de connexion depuis son téléphone et vérifie qu'elle le reçoit.
   Sans ce réglage, tout fonctionne quand même avec le mot de passe. En cas d'oubli, c'est toi qui le changes dans **Authentication → Users**.
4. **Sécurité.** Vérifie deux réglages dans **Authentication → Sign In / Providers** :
   - **Allow new users to sign up** doit être **désactivé** ;
   - **Confirm email** doit être **activé**.
5. **Mise en ligne.** Dans Netlify, ouvre ton site, puis l'onglet **Deploys**, et glisse le dossier **`site`** (et lui seul).
   **Vérification indispensable juste après :**
   - ouvre `https://ton-site.netlify.app/admin.html` : l'écran de connexion doit s'afficher ;
   - ouvre aussi le lien d'une assistante : son prénom et le gros bouton doivent s'afficher.

   Si l'une des pages affiche « Chargement impossible » ou « Pas de connexion » alors qu'Internet fonctionne, préviens-moi : la bibliothèque externe n'a pas été acceptée par le navigateur.

6. **Réglages de l'app.** Ouvre `admin.html`, onglet **Réglages** :
   - vérifie que le repère sur la carte est bien sur la maison ;
   - indique le **téléphone de la famille**. Il s'affichera sur l'app des assistantes quand le pointage ne marche pas ;
   - pour chaque assistante qui fait des **gardes de 24 h** : onglet **Assistantes**, bouton **Plus…**, type de travail **« Gardes de 24 h »**. Les autres restent en « Journée » : une intervention de plus de 13 h y est signalée, ce qui repère un départ oublié.

Les liens déjà envoyés aux assistantes continuent de fonctionner.

---

## Test sur place, avant la mise en service (15 minutes au domicile, avec chaque assistante)

Coche chaque étape :

- [ ] L'assistante ouvre son lien sur **son** téléphone et autorise la localisation.
- [ ] Elle ajoute l'app à l'écran d'accueil (**obligatoire sur iPhone** : sinon Safari peut oublier son lien au bout de quelques jours), puis la rouvre depuis l'icône. Son prénom doit s'afficher.
- [ ] Elle pointe une arrivée **à l'intérieur** de la maison. Côté famille, note la distance affichée (onglet Pointages).
- [ ] Elle pointe un départ.
- [ ] Mode avion activé, elle ouvre l'icône : « Pas de connexion » s'affiche avec Appeler / SMS / WhatsApp, et le SMS arrive bien.
- [ ] Elle signale un oubli (« J'ai oublié de pointer »). Ta mère l'accepte depuis **son** téléphone.
- [ ] Ta mère se connecte seule, sans aide, et télécharge le fichier Excel.

**Première semaine :** surveille le nombre de pointages refusés « hors zone » alors qu'elles étaient sur place. S'il y en a plus d'un ou deux, augmente la distance autorisée. **Premier mois :** la clôture (cadre « À traiter » vide, total relevé) doit se faire sans t'appeler.

## Comment ça marche

**Côté assistante**
- **Le bouton s'adapte à la situation.** Si elle n'est pas encore arrivée, il affiche « Je suis arrivée ». Si elle est sur place, il affiche « Je pars », et ce jusqu'à 26 h après l'arrivée, ce qui couvre les gardes de nuit et de 24 h. Au-delà du seuil de son type de travail, l'app lui demande si elle est toujours là ou si elle avait oublié de pointer son départ.
- **La position est vérifiée par le serveur.** Il compare la position du téléphone à celle du domicile, avec 150 m de rayon par défaut. L'heure enregistrée est celle du serveur, pas celle du téléphone.
- **Un oubli ?** L'assistante l'indique dans l'app (« J'avais oublié de pointer mon départ… », avec l'heure réelle). La famille accepte ou refuse.
- **Mes heures** : elle voit ses heures comptées du mois en cours et du mois précédent, et l'état de ses messages.
- **Sans réseau ni GPS :** un message clair, un bouton « Réessayer » qui ne compte jamais deux fois, et des boutons pour prévenir la famille (WhatsApp, SMS, appel).

**Côté famille (onglet Heures)**
- **À traiter** regroupe ce qui demande une action :
  - les messages des assistantes ;
  - les départs ou arrivées non pointés ;
  - les durées inhabituelles.
  Chaque point se règle en un geste.
- **Les totaux ne comptent que des heures sûres.** Tant qu'un point n'est pas réglé, ses heures ne sont pas payées par erreur.
- Chaque intervention peut être **modifiée**. Les pointages d'origine sont gardés (annulés, barrés) et l'**historique** indique qui a fait quoi.
- **Télécharger pour Excel** : le détail jour par jour, avec :
  - les heures du dimanche et des jours fériés ;
  - les heures par semaine, avec un repère au-delà de 40 h ;
  - le total à payer par assistante.

  Une intervention est comptée dans le mois et la semaine de son **arrivée** : une garde du 31 au 1er compte pour le 31, une garde du dimanche au lundi compte pour la semaine du dimanche. Une semaine à cheval sur deux mois est comptée en entier dans le mois de son lundi.
- Pour une assistante en **« Gardes de 24 h »**, l'app n'affiche pas de montant : une garde se paie selon le contrat (forfait, présence de nuit), pas forcément « heures × taux ».

## Chaque mois

1. Onglet **Heures** : traite le cadre **À traiter** jusqu'à ce qu'il disparaisse.
2. Lis le total de chaque assistante (heures et montant net si le taux est renseigné), ou clique **Télécharger pour Excel**.
3. Déclare au CESU. Les majorations du dimanche, des jours fériés et des heures supplémentaires dépendent de la convention collective des particuliers employeurs. L'export donne les heures concernées, mais ne calcule pas les majorations.

## En cas de problème

| Situation | Que faire |
|---|---|
| « Vous n'êtes pas au domicile » alors qu'elle y est | Le GPS est moins précis en intérieur : s'approcher d'une fenêtre et réessayer. Si ça se répète, regarde les distances dans **Pointages → Pointages refusés** et augmente la distance autorisée dans **Réglages**. |
| Localisation bloquée | iPhone : Réglages → Confidentialité → Service de localisation → Safari → « Lorsque l'app est active ». Android : autoriser la position pour Chrome et pour le site. |
| Lien perdu, nouveau téléphone | **Assistantes → Envoyer le lien**. |
| Lien qui circule, ou fin de contrat | **Nouveau lien** (l'ancien cesse de marcher) ou **Désactiver** (l'historique est gardé). |
| Une admin a oublié son mot de passe | Sur la page de connexion : « Mot de passe oublié » ou « Recevoir un lien de connexion par email » (voir l'envoi des emails ci-dessus). Sinon, change-le toi-même dans **Authentication → Users**. |
| On modifie la durée maximale d'une garde dans les Réglages | Les mois passés sont recalculés avec la nouvelle valeur : mieux vaut ne la changer qu'en début de mois. |

## Ce que l'app ne peut pas garantir (à savoir)

Une personne qui connaît le lien d'une assistante et qui a des compétences techniques peut envoyer de fausses coordonnées GPS. Aucune app web ne peut l'empêcher complètement. L'app aide à **repérer** ces cas, sans les prouver :
- un badge **« position à vérifier »** apparaît quand la précision annoncée est anormalement parfaite (cela peut aussi arriver normalement en extérieur) ;
- un badge **« autre appareil »** apparaît quand le pointage vient d'un téléphone ou d'un navigateur inhabituel. C'est aussi le cas après un changement de téléphone, ou si l'app est ouverte tantôt depuis l'icône, tantôt depuis le navigateur.

En cas de doute, en parler avec l'assistante. Le lien de chaque assistante est personnel : en créer un nouveau si nécessaire.

## Information des assistantes (RGPD) : modèle à leur remettre

> **Information sur le pointage des heures**
>
> Pour connaître vos heures de travail au domicile de [Nom], nous utilisons une application de pointage sur votre téléphone. Ce que vous pouvez savoir sur ce dispositif :
>
> - **Ce qui est enregistré :** au moment où vous appuyez sur « Je suis arrivée » ou « Je pars », votre position est lue **une seule fois** pour vérifier que vous êtes au domicile. Elle n'est jamais suivie en continu.
> - **Ce qui est gardé :** l'heure du pointage, la distance au domicile et un code tiré au hasard qui distingue votre téléphone. Votre position exacte est effacée au bout de 60 jours. Si vous pointez en dehors du domicile, seule la distance est gardée.
> - **Pourquoi :** calculer vos heures et votre salaire.
> - **Qui y a accès :** uniquement les membres de la famille qui vous emploient.
> - **Combien de temps :** les heures, vos messages et l'historique des corrections sont effacés automatiquement au bout de 3 ans.
> - **Vos droits :** vous pouvez à tout moment voir vos heures dans l'application (« Mes heures du mois »), et nous demander l'accès à vos données ou leur correction : [contact]. Vous pouvez aussi vous adresser à la CNIL.
>
> Date et signature :

---

## Vérifier l'app (dossier `tests`, pour les curieux)

- Après chaque nouvelle mise en ligne d'une version modifiée, change `pointage-v3` en `pointage-v4` (puis v5…) en haut de `site/sw.js`, pour que les téléphones prennent bien la nouvelle version.
- `bash run.sh` : près de 100 vérifications de la base. Elles couvrent la sécurité, les calculs, le passage de la v1 à la v3 avec des données imparfaites, et une installation neuve.
- `node commun.test.js` : dates, changements d'heure, jours fériés, export.
- `python3 apercu.py` : captures de tous les écrans, sans serveur.
