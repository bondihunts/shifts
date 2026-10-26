-- Tests automatiques de la base (exécutés par tests/run.sh)
\set ON_ERROR_STOP on
set client_min_messages = warning;

create schema if not exists t;
create or replace function t.ok(cond boolean, label text) returns void language plpgsql as $$
begin
  if cond is distinct from true then raise exception 'ÉCHEC : %', label; end if;
  raise notice 'ok - %', label;
end $$;
grant usage on schema t to anon, authenticated;
grant execute on function t.ok(boolean, text) to anon, authenticated;
create table if not exists t.v (k text primary key, v text);
grant all on t.v to anon, authenticated;
create or replace function t.set(k text, v text) returns void language sql as $$
  insert into t.v values (k, v) on conflict (k) do update set v = excluded.v $$;
create or replace function t.get(k text) returns text language sql as $$ select v from t.v where t.v.k = $1 $$;
grant execute on all functions in schema t to anon, authenticated;
set client_min_messages = notice;

-- ---------------------------------------------------------------------
-- Données de départ et comptes
-- ---------------------------------------------------------------------
insert into auth.users values
  ('11111111-1111-1111-1111-111111111111', 'admin@exemple.fr', now()),
  ('22222222-2222-2222-2222-222222222222', 'intrus@exemple.fr', now()),
  ('33333333-3333-3333-3333-333333333333', 'claire@exemple.fr', null);   -- email non confirmé
-- Rattachement des admins, comme indiqué dans le GUIDE (comptes confirmés seulement)
insert into public.admins (email, user_id)
select lower(email), id from auth.users
 where lower(email) in ('admin@exemple.fr', 'claire@exemple.fr') and email_confirmed_at is not null
on conflict (email) do update set user_id = excluded.user_id;
insert into public.admins (email) values ('claire@exemple.fr') on conflict do nothing;

\set ADMIN '{"sub":"11111111-1111-1111-1111-111111111111","email":"admin@exemple.fr","role":"authenticated"}'
\set INTRUS '{"sub":"22222222-2222-2222-2222-222222222222","email":"intrus@exemple.fr","role":"authenticated"}'
\set NONCONF '{"sub":"33333333-3333-3333-3333-333333333333","email":"claire@exemple.fr","role":"authenticated"}'
\set FAUX '{"sub":"44444444-4444-4444-4444-444444444444","email":"admin@exemple.fr","role":"authenticated"}'

-- La migration a conservé les données de la version 1
select t.ok((select count(*) from public.assistantes) = 2, 'migration : assistantes conservées');
select t.ok((select count(*) from public.pointages) = 4, 'migration : pointages conservés');
select t.ok((select count(*) from public.pointages where precision_m < 0 or length(note) > 300) = 0, 'migration : données hors règles nettoyées');
select t.ok((select count(*) from public.assistantes where length(prenom) > 40) = 0, 'migration : prénom trop long raccourci');
select t.ok((select lat is null from public.pointages where horodatage < now() - interval '65 days'), 'migration : positions de plus de 60 jours effacées');
select t.ok((select lat from public.reglages) = 48.9380, 'migration : réglages conservés');
select t.ok((select duree_max_h from public.reglages) = 26, 'migration : nouvelle colonne avec valeur par défaut');
select t.ok((select count(*) from public.tentatives_refusees where lat is not null) = 0, 'RGPD : anciennes positions des refus effacées');

select t.set('fatou', (select jeton from public.assistantes where prenom = 'Fatou'));
select t.set('ines',  (select jeton from public.assistantes where prenom like 'Inès%'));
update public.assistantes set active = false where prenom like 'Inès%';

-- ---------------------------------------------------------------------
-- Sécurité : visiteur anonyme
-- ---------------------------------------------------------------------
set role anon; set test.jwt = '';
do $$ begin
  begin perform 1 from public.pointages; perform t.ok(false, 'anon lit pointages');
  exception when insufficient_privilege then perform t.ok(true, 'anon : lecture pointages refusée'); end;
  begin insert into public.pointages (assistante_id, type) select id, 'arrivee' from public.assistantes limit 1;
        perform t.ok(false, 'anon écrit');
  exception when insufficient_privilege then perform t.ok(true, 'anon : écriture refusée'); end;
  begin perform public.is_admin(); perform t.ok(false, 'anon appelle is_admin');
  exception when insufficient_privilege then perform t.ok(true, 'anon : fonctions internes inaccessibles'); end;
  begin perform public._sessions(now(), now(), null); perform t.ok(false, 'anon appelle _sessions');
  exception when insufficient_privilege then perform t.ok(true, 'anon : calcul interne inaccessible'); end;
  begin perform public.admin_sessions(now() - interval '1 day', now()); perform t.ok(false, 'anon admin_sessions');
  exception when insufficient_privilege then perform t.ok(true, 'anon : fonctions admin inaccessibles'); end;
end $$;
select t.ok((public.etat_assistante('nimportequoi')->>'erreur') = 'lien_invalide', 'jeton invalide refusé');
select t.ok((public.etat_assistante(t.get('ines'))->>'erreur') = 'lien_invalide', 'assistante désactivée refusée');
select t.ok((public.etat_assistante($$' or 1=1 --$$)->>'erreur') = 'lien_invalide', 'injection refusée');
reset role;

-- ---------------------------------------------------------------------
-- Sécurité : comptes connectés
-- ---------------------------------------------------------------------
set role authenticated;
set test.jwt = :'INTRUS';
select t.ok((select count(*) from public.pointages) = 0, 'compte non admin : ne voit rien');
select t.ok(not public.is_admin(), 'compte non admin : pas admin');
set test.jwt = :'NONCONF';
select t.ok(not public.is_admin(), 'email listé mais NON confirmé : pas admin');
set test.jwt = :'FAUX';
select t.ok(not public.is_admin(), 'email admin dans un jeton sans compte correspondant : pas admin');
set test.jwt = :'ADMIN';
select t.ok(public.is_admin(), 'admin confirmé reconnu');
select t.ok((select count(*) from public.pointages) = 4, 'admin voit les pointages');
do $$ begin
  begin delete from public.pointages; perform t.ok(false, 'admin supprime');
  exception when insufficient_privilege then perform t.ok(true, 'admin : suppression définitive impossible'); end;
  begin insert into public.admins values ('pirate@x.fr'); perform t.ok(false, 'admin ajoute admin');
  exception when insufficient_privilege then perform t.ok(true, 'admin : ne peut pas ajouter d''admin via l''app'); end;
  begin update public.pointages set horodatage = horodatage - interval '1 hour' where source = 'app';
        perform t.ok(false, 'admin modifie heure');
  exception when raise_exception then perform t.ok(true, 'admin : heure d''un pointage non modifiable'); end;
end $$;
-- Un admin qui tente de créer un pointage « app » obtient un pointage « admin »
insert into public.pointages (assistante_id, type, horodatage, source, lat, lng)
select id, 'arrivee', now() - interval '30 days', 'app', 48.9, 2.5 from public.assistantes where prenom = 'Fatou';
select t.ok((select source = 'admin' and cree_par = 'admin@exemple.fr' and lat is null
             from public.pointages order by id desc limit 1), 'ajout admin : forcé en source admin + auteur');
select t.ok((select count(*) from public.journal where operation = 'INSERT' and table_nom = 'pointages') = 1,
            'journal : ajout admin tracé');
update public.pointages set annule_le = now() where id = (select max(id) from public.pointages);
select t.ok((select annule_par = 'admin@exemple.fr' from public.pointages order by id desc limit 1),
            'annulation : auteur enregistré');
-- Nouveau lien : le jeton est toujours généré par le serveur
update public.assistantes set jeton = 'abc' where prenom = 'Fatou';
select t.ok((select jeton ~ '^[0-9a-f]{32}$' and jeton <> t.get('fatou') from public.assistantes where prenom = 'Fatou'),
            'nouveau lien : jeton fort généré par le serveur');
select t.ok((select count(*) from public.journal where table_nom = 'assistantes' and (apres ? 'jeton')) = 0,
            'journal : le jeton n''y figure jamais');
select t.set('fatou', (select jeton from public.assistantes where prenom = 'Fatou'));
insert into public.assistantes (prenom, jeton) values ('  Zoé ', 'faible');
select t.ok((select jeton ~ '^[0-9a-f]{32}$' and prenom = 'Zoé' from public.assistantes where prenom = 'Zoé'),
            'création : jeton imposé fort, prénom nettoyé');
select t.set('zoe', (select jeton from public.assistantes where prenom = 'Zoé'));
reset role;

-- ---------------------------------------------------------------------
-- Pointage depuis l'app
-- ---------------------------------------------------------------------
set role anon; set test.jwt = '';
select t.ok((public.pointer(t.get('zoe'), null, 48.938, 2.527, 10)->>'erreur') = 'type', 'type nul refusé proprement');
select t.ok((public.pointer(t.get('zoe'), 'arrivee', 'Infinity', 2.527, 10)->>'erreur') = 'position', 'latitude infinie refusée');
select t.ok((public.pointer(t.get('zoe'), 'arrivee', 'NaN', 2.527, 10)->>'erreur') = 'position', 'latitude NaN refusée');
select t.ok((public.pointer(t.get('zoe'), 'arrivee', 48.938 + 360, 2.527, 10)->>'erreur') = 'position', 'latitude hors bornes refusée');
select t.ok((public.pointer(t.get('zoe'), 'arrivee', 48.96, 2.527, 10)->>'erreur') = 'hors_zone', 'hors zone (2,4 km) refusé');
select t.ok((public.pointer(t.get('zoe'), 'arrivee', 48.9408, 2.527, 1e9)->>'erreur') = 'hors_zone', 'précision géante : marge plafonnée à 100 m');
select t.ok((public.pointer(t.get('zoe'), 'depart', 48.9381, 2.5271, 15)->>'erreur') = 'pas_arrivee', 'départ sans arrivée : demande confirmation');
select t.set('r1', public.pointer(t.get('zoe'), 'arrivee', 48.9381, 2.5271, 15, 'aaaaaaaa-0000-0000-0000-000000000001', false, 'appareil-de-test-1')::text);
select t.ok((t.get('r1')::json->>'ok')::boolean, 'arrivée sur place acceptée');
select t.ok((public.pointer(t.get('zoe'), 'arrivee', 48.9381, 2.5271, 15, 'aaaaaaaa-0000-0000-0000-000000000001')->>'doublon')::boolean,
            'même demande renvoyée (coupure réseau) : pas de doublon');
select t.ok((public.pointer(t.get('zoe'), 'arrivee', 48.9381, 2.5271, 15)->>'doublon')::boolean, 'double appui : pas de doublon');
select t.ok((public.etat_assistante(t.get('zoe'))->>'presente')::boolean, 'état : présente');
reset role;
-- On vieillit l'arrivée de 3 h pour tester la 2e arrivée
update public.pointages set horodatage = horodatage - interval '3 hours', cree_le = cree_le - interval '3 hours'
 where cle = 'aaaaaaaa-0000-0000-0000-000000000001';
set role anon;
select t.ok((public.pointer(t.get('zoe'), 'arrivee', 48.9381, 2.5271, 15)->>'erreur') = 'deja_arrivee', '2e arrivée : demande confirmation');
select t.ok((public.pointer(t.get('zoe'), 'depart', 48.9381, 2.5271, 15)->>'ok')::boolean, 'départ accepté');
select t.ok(not (public.etat_assistante(t.get('zoe'))->>'presente')::boolean, 'état : partie');
-- Tentatives répétées hors zone : journal limité
do $$ begin for i in 1..40 loop perform public.pointer(t.get('zoe'), 'arrivee', 49.5, 2.5, 10); end loop; end $$;
reset role;
select t.ok((select count(*) from public.tentatives_refusees r join public.assistantes a on a.id = r.assistante_id
              where a.prenom = 'Zoé' and r.horodatage > now() - interval '1 hour') <= 20, 'refus : maximum 20 par heure enregistrés');
select t.ok((select count(*) from public.tentatives_refusees where lat is not null) = 0, 'refus : position jamais stockée');
select t.ok((select appareil is not null from public.pointages where cle = 'aaaaaaaa-0000-0000-0000-000000000001'), 'empreinte d''appareil enregistrée');

-- Garde de 24 h : le départ 24 h après est bien associé
insert into public.pointages (assistante_id, type, horodatage, lat, lng, precision_m, distance_m)
select id, 'arrivee', now() - interval '24 hours', 48.938, 2.527, 12, 5 from public.assistantes where prenom = 'Fatou';
set role anon;
select t.ok((public.etat_assistante(t.get('fatou'))->>'presente')::boolean, 'garde 24 h : toujours présente après 24 h');
select t.ok((public.etat_assistante(t.get('fatou'))->>'longue')::boolean, 'garde 24 h : signalée longue (seuil 13 h)');
select t.ok((public.pointer(t.get('fatou'), 'depart', 48.938, 2.527, 12)->>'ok')::boolean, 'garde 24 h : départ accepté');
reset role;

-- ---------------------------------------------------------------------
-- Déclaration d'un oubli par l'assistante, puis validation par la famille
-- ---------------------------------------------------------------------
set role anon;
select t.ok((public.declarer(t.get('zoe'), 'depart', now() + interval '1 day', 'x')->>'erreur') = 'date', 'déclaration dans le futur refusée');
select t.ok((public.declarer(t.get('zoe'), 'depart', now() - interval '20 days', 'x')->>'erreur') = 'date', 'déclaration trop ancienne refusée');
select t.ok((public.declarer(t.get('zoe'), 'arrivee', now() - interval '26 hours', 'Batterie vide')->>'ok')::boolean, 'déclaration acceptée');
select t.ok(json_array_length(public.mes_heures(t.get('zoe'))->'demandes') = 1, 'l''assistante voit sa demande');
reset role;
set role authenticated; set test.jwt = :'ADMIN';
select t.ok((public.admin_traiter_demande((select max(id) from public.demandes), true)->>'ok')::boolean, 'famille : demande acceptée');
select t.ok((public.admin_traiter_demande((select max(id) from public.demandes), true)->>'erreur') = 'deja_traitee', 'demande non traitable deux fois');
select t.ok((select source = 'admin' and note like 'Déclaré par l''assistante%' from public.pointages order by id desc limit 1),
            'pointage créé depuis la demande');
reset role;
set role authenticated; set test.jwt = :'INTRUS';
do $$ begin
  begin perform public.admin_traiter_demande(1, true); perform t.ok(false, 'intrus traite demande');
  exception when raise_exception then perform t.ok(true, 'non admin : ne peut pas traiter une demande'); end;
end $$;
reset role;

-- ---------------------------------------------------------------------
-- Calcul des interventions
-- ---------------------------------------------------------------------
-- Jeu de données dédié : Léa
insert into public.assistantes (prenom) values ('Léa');
create temporary table lea as select id from public.assistantes where prenom = 'Léa';
-- nuit à cheval sur deux mois (heure de Paris) : 31/10 20:00 -> 01/11 08:00 (changement d'heure le 25/10)
insert into public.pointages (assistante_id, type, horodatage) select id, 'arrivee', '2026-10-31 20:00 Europe/Paris' from lea;
insert into public.pointages (assistante_id, type, horodatage) select id, 'depart',  '2026-11-01 08:00 Europe/Paris' from lea;
-- nuit du changement d'heure : 24/10 20:00 -> 25/10 08:00 = 13 h
insert into public.pointages (assistante_id, type, horodatage) select id, 'arrivee', '2026-10-24 20:00 Europe/Paris' from lea;
insert into public.pointages (assistante_id, type, horodatage) select id, 'depart',  '2026-10-25 08:00 Europe/Paris' from lea;
-- oubli de départ le 05/10, puis journée normale le 06/10
insert into public.pointages (assistante_id, type, horodatage) select id, 'arrivee', '2026-10-05 08:00 Europe/Paris' from lea;
insert into public.pointages (assistante_id, type, horodatage) select id, 'arrivee', '2026-10-06 09:00 Europe/Paris' from lea;
insert into public.pointages (assistante_id, type, horodatage) select id, 'depart',  '2026-10-06 12:30 Europe/Paris' from lea;
-- départ et arrivée à la même seconde (relève)
insert into public.pointages (assistante_id, type, horodatage) select id, 'depart',  '2026-10-10 12:00 Europe/Paris' from lea;
insert into public.pointages (assistante_id, type, horodatage) select id, 'arrivee', '2026-10-10 08:00 Europe/Paris' from lea;
-- départ très éloigné de l'arrivée (> 26 h) : 15/10 -> 17/10
insert into public.pointages (assistante_id, type, horodatage) select id, 'arrivee', '2026-10-15 08:00 Europe/Paris' from lea;
insert into public.pointages (assistante_id, type, horodatage) select id, 'depart',  '2026-10-17 09:00 Europe/Paris' from lea;
-- pointage annulé : ignoré
insert into public.pointages (assistante_id, type, horodatage, annule_le) select id, 'arrivee', '2026-10-20 08:00 Europe/Paris', now() from lea;

create temporary table oct as
  select * from public._sessions('2026-10-01 00:00 Europe/Paris', '2026-11-01 00:00 Europe/Paris', (select id from lea));
create temporary table nov as
  select * from public._sessions('2026-11-01 00:00 Europe/Paris', '2026-12-01 00:00 Europe/Paris', (select id from lea));
select t.ok((select count(*) from oct where arrivee = '2026-10-31 20:00 Europe/Paris' and duree_min = 720 and statut = 'ok') = 1,
            'nuit à cheval sur 2 mois : rattachée à octobre, 12 h');
select t.ok((select count(*) from nov) = 0, 'nuit à cheval : pas comptée en novembre (ni en anomalie)');
select t.ok((select duree_min from oct where arrivee = '2026-10-24 20:00 Europe/Paris') = 780 and
            (select statut from oct where arrivee = '2026-10-24 20:00 Europe/Paris') = 'ok',
            'nuit du changement d''heure : 13 h, pas d''alerte (seuil > 13 h)');
select t.ok((select statut from oct where arrivee = '2026-10-05 08:00 Europe/Paris') = 'depart_manquant', 'oubli de départ détecté');
select t.ok((select duree_min from oct where arrivee = '2026-10-06 09:00 Europe/Paris') = 210, 'journée suivante correcte (3 h 30)');
select t.ok((select duree_min from oct where arrivee = '2026-10-10 08:00 Europe/Paris') = 240, 'ordre arrivée/départ correct');
select t.ok((select statut from oct where arrivee = '2026-10-15 08:00 Europe/Paris') = 'depart_manquant'
        and (select statut from oct where depart = '2026-10-17 09:00 Europe/Paris') = 'arrivee_manquante',
            'écart > 26 h : deux anomalies, jamais 49 h payées');
select t.ok((select count(*) from oct where arrivee = '2026-10-20 08:00 Europe/Paris') = 0, 'pointage annulé ignoré');
-- Durée longue puis validation par la famille
insert into public.pointages (assistante_id, type, horodatage) select id, 'arrivee', '2026-10-26 08:00 Europe/Paris' from lea;
insert into public.pointages (assistante_id, type, horodatage) select id, 'depart',  '2026-10-27 08:00 Europe/Paris' from lea;
select t.ok((select statut from public._sessions('2026-10-01 00:00 Europe/Paris', '2026-11-01 00:00 Europe/Paris', (select id from lea))
              where arrivee = '2026-10-26 08:00 Europe/Paris') = 'longue', 'garde de 24 h : à valider');
set role authenticated; set test.jwt = :'ADMIN';
update public.pointages set valide_le = now() where horodatage = '2026-10-27 08:00 Europe/Paris';
select t.ok((select count(*) from public.admin_sessions('2026-10-01 00:00 Europe/Paris', '2026-11-01 00:00 Europe/Paris') s
              where (s->>'arrivee')::timestamptz = '2026-10-26 08:00 Europe/Paris' and s->>'statut' = 'ok') = 1,
            'garde validée par la famille : comptée');
reset role;


-- ---------------------------------------------------------------------
-- Version 3 : durcissements
-- ---------------------------------------------------------------------
-- Admin rattaché à un compte : un email listé sans compte rattaché ne suffit pas
insert into auth.users values ('55555555-5555-5555-5555-555555555555', 'tante@exemple.fr', now());
insert into public.admins (email) values ('tante@exemple.fr') on conflict do nothing;
set role authenticated; set test.jwt = '{"sub":"55555555-5555-5555-5555-555555555555","email":"tante@exemple.fr"}';
select t.ok(not public.is_admin(), 'email listé, compte confirmé mais non rattaché : pas admin');
reset role;

-- Journal : aucune position GPS
select t.ok((select count(*) from public.journal where avant ? 'lat' or apres ? 'lat') = 0, 'journal : aucune position GPS');

set role authenticated; set test.jwt = :'ADMIN';
-- Champs d'audit non falsifiables
update public.pointages set annule_le = now() where id = (select min(id) from public.pointages where source = 'app');
do $$ begin
  begin update public.pointages set annule_par = 'faux@x.fr' where id = (select min(id) from public.pointages where source = 'app');
        perform t.ok(false, 'annule_par falsifié');
  exception when raise_exception then perform t.ok(true, 'auteur d''une annulation non falsifiable'); end;
end $$;
do $$ begin
  begin update public.pointages set annule_le = '2020-01-01' where id = (select min(id) from public.pointages where source = 'app');
        perform t.ok(false, 'ré-annulation antidatée acceptée');
  exception when raise_exception then perform t.ok(true, 'pointage déjà annulé : date et auteur d''origine conservés'); end;
end $$;
select t.ok((select annule_le > now() - interval '1 minute' from public.pointages where id = (select min(id) from public.pointages where source = 'app')),
            'date d''annulation toujours imposée');
update public.pointages set annule_le = null where id = (select min(id) from public.pointages where source = 'app');
select t.ok((select annule_par is null from public.pointages where id = (select min(id) from public.pointages where source = 'app')), 'rétablissement : auteur effacé');
insert into public.pointages (assistante_id, type, horodatage, cree_le)
select id, 'arrivee', now() - interval '20 days', '1999-01-01' from public.assistantes where prenom = 'Fatou';
select t.ok((select cree_le > now() - interval '1 minute' from public.pointages order by id desc limit 1), 'date de création non antidatable');
update public.pointages set annule_le = now() where id = (select max(id) from public.pointages);
do $$ begin
  begin update public.demandes set statut = 'acceptee'; perform t.ok(false, 'demande modifiée directement');
  exception when insufficient_privilege then perform t.ok(true, 'demandes : modification directe impossible'); end;
  begin update public.reglages set alerte_h = 30, duree_max_h = 26; perform t.ok(false, 'seuil > durée max');
  exception when check_violation then perform t.ok(true, 'réglages : seuil d''alerte < durée max imposé'); end;
end $$;
reset role;

-- Pointage : forcer ne contourne pas l'anti-doublon ; clé propre à chaque assistante ; plafond 24 h
set role anon;
select t.ok((public.pointer(t.get('zoe'), 'arrivee', 48.9381, 2.5271, 15, null, true)->>'ok')::boolean, 'arrivée forcée acceptée');
select t.ok((public.pointer(t.get('zoe'), 'arrivee', 48.9381, 2.5271, 15, null, true)->>'doublon')::boolean, 'arrivée forcée répétée : doublon, pas de nouvelle ligne');
select t.ok((public.pointer(t.get('fatou'), 'arrivee', 48.9381, 2.5271, 15, 'aaaaaaaa-0000-0000-0000-000000000001')->>'doublon') is null,
            'clé d''une autre assistante : ne renvoie pas son pointage');
reset role;
select t.ok((select count(*) from public.pointages p join public.assistantes a on a.id = p.assistante_id
              where a.prenom = 'Zoé' and p.type = 'arrivee' and p.horodatage > now() - interval '1 minute') = 1, 'une seule arrivée enregistrée');
update public.pointages set horodatage = horodatage - interval '10 minutes'
 where assistante_id = (select id from public.assistantes where prenom = 'Zoé') and horodatage > now() - interval '1 minute';
insert into public.pointages (assistante_id, type, horodatage, source)
select a.id, case when g % 2 = 0 then 'depart' else 'arrivee' end, now() - make_interval(mins => 20 + g), 'app'
  from public.assistantes a, generate_series(1, 12) g where a.prenom = 'Zoé';
set role anon;
select t.ok((public.pointer(t.get('zoe'), 'depart', 48.9381, 2.5271, 15, null, true)->>'erreur') = 'trop', 'plafond de 12 pointages par 24 h');
select t.ok((public.etat_assistante(t.get('zoe'))->>'ok')::boolean, 'l''état reste lisible');
reset role;

-- Seuil d'alerte propre à une assistante (gardes de 24 h)
insert into public.assistantes (prenom, alerte_h) values ('Nadia', 25);
insert into public.pointages (assistante_id, type, horodatage) select id, 'arrivee', '2026-10-03 08:00 Europe/Paris' from public.assistantes where prenom = 'Nadia';
insert into public.pointages (assistante_id, type, horodatage) select id, 'depart',  '2026-10-04 08:00 Europe/Paris' from public.assistantes where prenom = 'Nadia';
select t.ok((select statut from public._sessions('2026-10-01 00:00 Europe/Paris', '2026-11-01 00:00 Europe/Paris',
              (select id from public.assistantes where prenom = 'Nadia'))) = 'ok', 'garde de 24 h d''une assistante « gardes » : comptée directement');

-- Heure égale : le départ passe avant l'arrivée (fin de nuit et début de journée à 08:00)
insert into public.assistantes (prenom) values ('Sara');
insert into public.pointages (assistante_id, type, horodatage) select id, 'arrivee', '2026-09-20 20:00 Europe/Paris' from public.assistantes where prenom = 'Sara';
insert into public.pointages (assistante_id, type, horodatage) select id, 'arrivee', '2026-09-21 08:00 Europe/Paris' from public.assistantes where prenom = 'Sara';
insert into public.pointages (assistante_id, type, horodatage) select id, 'depart',  '2026-09-21 08:00 Europe/Paris' from public.assistantes where prenom = 'Sara';
insert into public.pointages (assistante_id, type, horodatage) select id, 'depart',  '2026-09-21 12:00 Europe/Paris' from public.assistantes where prenom = 'Sara';
-- intervention très courte
insert into public.pointages (assistante_id, type, horodatage) select id, 'arrivee', '2026-09-22 12:00 Europe/Paris' from public.assistantes where prenom = 'Sara';
insert into public.pointages (assistante_id, type, horodatage) select id, 'depart',  '2026-09-22 12:01 Europe/Paris' from public.assistantes where prenom = 'Sara';
create temporary table sara as select * from public._sessions('2026-09-01 00:00 Europe/Paris', '2026-10-01 00:00 Europe/Paris',
  (select id from public.assistantes where prenom = 'Sara'));
select t.ok((select duree_min from sara where arrivee = '2026-09-20 20:00 Europe/Paris') = 720
        and (select duree_min from sara where arrivee = '2026-09-21 08:00 Europe/Paris') = 240, 'relève à la même minute : 12 h puis 4 h');
select t.ok((select statut from sara where arrivee = '2026-09-22 12:00 Europe/Paris') = 'courte', 'intervention de 1 min : à confirmer');

-- Correction d'une intervention en une seule opération (garde de 24 h validée, puis arrivée corrigée)
insert into public.pointages (assistante_id, type, horodatage) select id, 'arrivee', '2026-09-10 08:00 Europe/Paris' from lea;
insert into public.pointages (assistante_id, type, horodatage, valide_le) select id, 'depart', '2026-09-11 08:00 Europe/Paris', now() from lea;
set role authenticated; set test.jwt = :'ADMIN';
select t.set('s_ar', (select (s->>'arrivee_id') from public.admin_sessions('2026-09-01 00:00 Europe/Paris', '2026-10-01 00:00 Europe/Paris') s
                       where (s->>'arrivee')::timestamptz = '2026-09-10 08:00 Europe/Paris'));
select t.set('s_dep', (select (s->>'depart_id') from public.admin_sessions('2026-09-01 00:00 Europe/Paris', '2026-10-01 00:00 Europe/Paris') s
                       where (s->>'arrivee')::timestamptz = '2026-09-10 08:00 Europe/Paris'));
do $$ begin
  begin perform public.admin_corriger_session((select id from public.assistantes where prenom = 'Léa'), t.get('s_ar')::bigint, t.get('s_dep')::bigint,
          '2026-09-10 08:00 Europe/Paris', '2026-09-10 07:00 Europe/Paris', 'x');
        perform t.ok(false, 'correction incohérente acceptée');
  exception when raise_exception then perform t.ok(true, 'correction incohérente refusée, rien n''est modifié'); end;
end $$;
select t.ok((select annule_le is null from public.pointages where id = t.get('s_ar')::bigint), 'après refus : pointages d''origine intacts');
select t.ok((public.admin_corriger_session((select id from public.assistantes where prenom = 'Léa'), t.get('s_ar')::bigint, t.get('s_dep')::bigint,
          '2026-09-10 06:00 Europe/Paris', '2026-09-11 08:00 Europe/Paris', 'arrivée plus tôt')->>'ok')::boolean, 'correction acceptée');
select t.ok((select s->>'statut' from public.admin_sessions('2026-09-01 00:00 Europe/Paris', '2026-10-01 00:00 Europe/Paris') s
              where (s->>'arrivee')::timestamptz = '2026-09-10 06:00 Europe/Paris') = 'longue',
            'durée corrigée : la confirmation doit être redonnée');
select t.ok((select count(*) from public.journal where operation = 'CORRECTION') = 1, 'correction tracée dans le journal');
reset role;

-- Mes heures : mois précédent
set role anon;
select t.ok((public.mes_heures(t.get('zoe'), -1)->>'decalage')::int = -1, 'mes heures : mois précédent disponible');
select t.ok((public.mes_heures(t.get('zoe'), -12)->>'decalage')::int = -1, 'mes heures : pas plus loin que le mois précédent');
reset role;

-- Purge : rien de plus de 3 ans
insert into public.pointages (assistante_id, type, horodatage) select id, 'arrivee', now() - interval '4 years' from public.assistantes where prenom = 'Léa';
select public._purge();
select t.ok((select count(*) from public.pointages where horodatage < now() - interval '3 years') = 0, 'RGPD : heures de plus de 3 ans effacées');

-- Arrivée -> départ -> arrivée en moins de 2 min : 3 pointages, présente (pas de faux doublon)
insert into public.assistantes (prenom) values ('Rose');
select t.set('rose', (select jeton from public.assistantes where prenom = 'Rose'));
set role anon;
select t.ok((public.pointer(t.get('rose'), 'arrivee', 48.9381, 2.5271, 15)->>'doublon') is null, 'Rose : arrivée');
select t.ok((public.pointer(t.get('rose'), 'depart', 48.9381, 2.5271, 15)->>'doublon') is null, 'Rose : départ juste après');
select t.ok((public.pointer(t.get('rose'), 'arrivee', 48.9381, 2.5271, 15, null, true)->>'doublon') is null, 'Rose : nouvelle arrivée, pas un faux doublon');
select t.ok((public.etat_assistante(t.get('rose'))->>'presente')::boolean, 'Rose : présente');
reset role;
select t.ok((select count(*) from public.pointages p join public.assistantes a on a.id = p.assistante_id where a.prenom = 'Rose') = 3, 'Rose : 3 pointages enregistrés');
-- Modifier sans changement (à la minute près) : aucun pointage remplacé
set role authenticated; set test.jwt = :'ADMIN';
select t.ok((public.admin_corriger_session((select id from public.assistantes where prenom = 'Sara'),
  (select id from public.pointages where horodatage = '2026-09-21 08:00 Europe/Paris' and type = 'arrivee' and annule_le is null),
  (select id from public.pointages where horodatage = '2026-09-21 12:00 Europe/Paris' and annule_le is null),
  '2026-09-21 08:00:30 Europe/Paris', '2026-09-21 12:00:10 Europe/Paris', null)->>'inchange')::boolean, 'correction sans changement : rien n''est remplacé');
do $$ begin
  begin update public.pointages set note = 'falsifiée' where source = 'app' and id = (select min(id) from public.pointages where source = 'app');
        perform t.ok(false, 'note app modifiée');
  exception when raise_exception then perform t.ok(true, 'note d''un pointage de l''app non modifiable'); end;
end $$;
reset role;
select t.ok((select derniere_purge is not null from public.reglages), 'date de la dernière purge enregistrée');

-- Rejouer le script ne doit rien casser (testé par run.sh en le chargeant deux fois)
select t.ok(true, 'FIN DES TESTS');
