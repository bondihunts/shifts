-- =====================================================================
--  Application de pointage — base de données Supabase — version 3
--
--  À coller en entier dans Supabase > SQL Editor > New query > Run.
--  Le script est rejouable : il crée la base si elle est vide, ou met
--  à jour une base existante (versions 1 ou 2) sans perdre de données.
--  Fuseau horaire de référence : Europe/Paris.
-- =====================================================================

begin;

create extension if not exists pgcrypto with schema extensions;
-- Les fonctions créées à l'avenir ne seront pas exécutables par tout le monde par défaut
alter default privileges revoke execute on functions from public;

-- =====================================================================
-- 1. TABLES
-- =====================================================================

-- Réglages (une seule ligne)
create table if not exists public.reglages (
  id       int primary key default 1 check (id = 1),
  adresse  text,
  lat      double precision,
  lng      double precision,
  rayon_m  int not null default 150
);
alter table public.reglages add column if not exists duree_max_h        int  not null default 26;
alter table public.reglages add column if not exists alerte_h           int  not null default 13;
alter table public.reglages add column if not exists telephone_famille  text;
alter table public.reglages add column if not exists conservation_gps_j int  not null default 60;
alter table public.reglages add column if not exists derniere_purge     timestamptz;
insert into public.reglages (id) values (1)
on conflict (id) do nothing;

-- Assistantes de vie. Chacune a un lien personnel (jeton secret de 128 bits).
create table if not exists public.assistantes (
  id           uuid primary key default gen_random_uuid(),
  prenom       text not null,
  jeton        text not null unique default encode(extensions.gen_random_bytes(16), 'hex'),
  taux_horaire numeric(6,2),
  active       boolean not null default true,
  cree_le      timestamptz not null default now()
);
-- Seuil d'alerte propre à l'assistante (ex. 25 h pour les gardes de 24 h)
alter table public.assistantes add column if not exists alerte_h int;

-- Pointages
create table if not exists public.pointages (
  id            bigint generated always as identity primary key,
  assistante_id uuid not null references public.assistantes(id),
  type          text not null check (type in ('arrivee','depart')),
  horodatage    timestamptz not null default now(),
  lat           double precision,
  lng           double precision,
  precision_m   double precision,
  distance_m    double precision,
  source        text not null default 'app' check (source in ('app','admin')),
  note          text,
  cree_le       timestamptz not null default now()
);
alter table public.pointages add column if not exists cle        uuid;
alter table public.pointages add column if not exists appareil   text;
alter table public.pointages add column if not exists cree_par   text;
alter table public.pointages add column if not exists annule_le  timestamptz;
alter table public.pointages add column if not exists annule_par text;
alter table public.pointages add column if not exists valide_le  timestamptz;
alter table public.pointages add column if not exists valide_par text;
drop index if exists public.pointages_cle;
create unique index if not exists pointages_assistante_cle on public.pointages (assistante_id, cle) where cle is not null;
create index if not exists pointages_assistante_horo on public.pointages (assistante_id, horodatage);
create index if not exists pointages_horo on public.pointages (horodatage);

-- Tentatives refusées (on ne garde que la distance, jamais la position)
create table if not exists public.tentatives_refusees (
  id            bigint generated always as identity primary key,
  assistante_id uuid references public.assistantes(id) on delete cascade,
  type          text,
  horodatage    timestamptz not null default now(),
  lat           double precision,
  lng           double precision,
  precision_m   double precision,
  distance_m    double precision,
  motif         text not null
);
create index if not exists tentatives_horo on public.tentatives_refusees (horodatage);
create index if not exists tentatives_assistante on public.tentatives_refusees (assistante_id, horodatage);

-- Demandes envoyées par les assistantes (oubli de pointage)
create table if not exists public.demandes (
  id                 bigint generated always as identity primary key,
  assistante_id      uuid not null references public.assistantes(id),
  type               text not null check (type in ('arrivee','depart')),
  horodatage_declare timestamptz not null,
  message            text,
  statut             text not null default 'en_attente' check (statut in ('en_attente','acceptee','refusee')),
  cree_le            timestamptz not null default now(),
  traite_par         text,
  traite_le          timestamptz,
  pointage_id        bigint references public.pointages(id) on delete set null
);
create index if not exists demandes_statut on public.demandes (statut, cree_le);

-- Comptes autorisés à l'espace famille (rattachés à un compte précis)
create table if not exists public.admins (
  email text primary key
);
alter table public.admins add column if not exists user_id uuid unique;

-- Journal : qui a modifié quoi (lecture seule)
create table if not exists public.journal (
  id        bigint generated always as identity primary key,
  quand     timestamptz not null default now(),
  qui       text,
  table_nom text not null,
  operation text not null,
  avant     jsonb,
  apres     jsonb
);
create index if not exists journal_quand on public.journal (quand desc);

-- =====================================================================
-- 2. NETTOYAGE DES DONNÉES ANCIENNES, PUIS CONTRAINTES
-- =====================================================================
do $$
begin
  -- On retire d'abord les contraintes d'une version précédente, pour pouvoir nettoyer
  alter table public.pointages   drop constraint if exists pointages_coords_ok;
  alter table public.pointages   drop constraint if exists pointages_note_ok;
  alter table public.assistantes drop constraint if exists assistantes_jeton_fort;
  alter table public.assistantes drop constraint if exists assistantes_prenom_ok;
  alter table public.assistantes drop constraint if exists assistantes_taux_ok;
  alter table public.assistantes drop constraint if exists assistantes_alerte_ok;
  alter table public.reglages    drop constraint if exists reglages_valeurs_ok;
  alter table public.demandes    drop constraint if exists demandes_message_ok;

  -- Données des versions précédentes qui ne respecteraient pas les nouvelles règles
  update public.pointages set precision_m = null
   where precision_m is not null and (precision_m = 'NaN'::float8 or not (precision_m between 0 and 100000));
  update public.pointages set lat = null, lng = null
   where (lat is not null and (lat = 'NaN'::float8 or not (lat between -90 and 90)))
      or (lng is not null and (lng = 'NaN'::float8 or not (lng between -180 and 180)));
  update public.pointages set note = left(note, 300) where length(note) > 300;
  update public.assistantes set prenom = coalesce(nullif(left(btrim(prenom), 40), ''), 'Sans prénom')
   where length(btrim(prenom)) not between 1 and 40;
  update public.assistantes set taux_horaire = null where taux_horaire is not null and not (taux_horaire between 0 and 500);
  update public.assistantes set jeton = encode(extensions.gen_random_bytes(16), 'hex') where jeton !~ '^[0-9a-f]{32}$';
  update public.reglages set rayon_m = least(greatest(rayon_m, 20), 2000),
                             duree_max_h = least(greatest(duree_max_h, 4), 48),
                             conservation_gps_j = least(greatest(conservation_gps_j, 7), 3650);
  update public.reglages set alerte_h = least(greatest(alerte_h, 1), duree_max_h - 1);
  update public.reglages set telephone_famille = null
   where telephone_famille is not null and telephone_famille !~ '^\+?[0-9 .]{6,20}$';
  update public.reglages set lat = null, lng = null
   where (lat is not null and not (lat between -90 and 90)) or (lng is not null and not (lng between -180 and 180));

  -- Les pointages ne sont plus supprimés en cascade avec une assistante
  alter table public.pointages drop constraint if exists pointages_assistante_id_fkey;
  alter table public.pointages add constraint pointages_assistante_id_fkey
    foreign key (assistante_id) references public.assistantes(id) on delete restrict;
  alter table public.demandes drop constraint if exists demandes_pointage_id_fkey;
  alter table public.demandes add constraint demandes_pointage_id_fkey
    foreign key (pointage_id) references public.pointages(id) on delete set null;

  alter table public.reglages drop constraint if exists reglages_rayon_m_check;
  alter table public.reglages drop constraint if exists reglages_valeurs_ok;
  alter table public.reglages add constraint reglages_valeurs_ok check (
        rayon_m between 20 and 2000
    and duree_max_h between 4 and 48
    and alerte_h between 1 and 47
    and alerte_h < duree_max_h
    and conservation_gps_j between 7 and 3650
    and (lat is null or lat between -90 and 90)
    and (lng is null or lng between -180 and 180)
    and (telephone_famille is null or telephone_famille ~ '^\+?[0-9 .]{6,20}$'));

  alter table public.assistantes drop constraint if exists assistantes_jeton_fort;
  alter table public.assistantes add constraint assistantes_jeton_fort check (jeton ~ '^[0-9a-f]{32}$');
  alter table public.assistantes drop constraint if exists assistantes_prenom_ok;
  alter table public.assistantes add constraint assistantes_prenom_ok check (length(btrim(prenom)) between 1 and 40);
  alter table public.assistantes drop constraint if exists assistantes_taux_ok;
  alter table public.assistantes add constraint assistantes_taux_ok check (taux_horaire is null or taux_horaire between 0 and 500);
  alter table public.assistantes drop constraint if exists assistantes_alerte_ok;
  alter table public.assistantes add constraint assistantes_alerte_ok check (alerte_h is null or alerte_h between 1 and 47);

  alter table public.pointages drop constraint if exists pointages_coords_ok;
  alter table public.pointages add constraint pointages_coords_ok check (
        (lat is null or lat between -90 and 90)
    and (lng is null or lng between -180 and 180)
    and (precision_m is null or precision_m between 0 and 100000));
  alter table public.pointages drop constraint if exists pointages_note_ok;
  alter table public.pointages add constraint pointages_note_ok check (note is null or length(note) <= 300);

  alter table public.demandes drop constraint if exists demandes_message_ok;
  alter table public.demandes add constraint demandes_message_ok check (message is null or length(message) <= 300);
end $$;

-- =====================================================================
-- 3. DROITS SUR LES TABLES : le strict nécessaire (les fonctions : section 10)
-- =====================================================================
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from anon, authenticated;

-- Les admins lisent et écrivent sous les règles ci-dessous ; jamais de suppression
grant select, update            on public.reglages            to authenticated;
grant select, insert, update    on public.assistantes         to authenticated;
grant select, insert, update    on public.pointages           to authenticated;
grant select                    on public.tentatives_refusees to authenticated;
grant select                    on public.demandes            to authenticated;
grant select                    on public.admins              to authenticated;
grant select                    on public.journal             to authenticated;

-- =====================================================================
-- 4. QUI EST ADMIN : un compte précis (user_id), à l'email confirmé
-- =====================================================================
-- Rattache les emails déjà listés à leur compte existant et confirmé
update public.admins a set user_id = u.id
  from auth.users u
 where a.user_id is null and lower(u.email) = lower(a.email) and u.email_confirmed_at is not null;

create or replace function public.is_admin()
returns boolean language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.admins a
      join auth.users u on u.id = a.user_id
     where u.id = auth.uid()
       and u.email_confirmed_at is not null
  );
$$;

create or replace function public.email_admin()
returns text language sql stable
set search_path = ''
as $$ select coalesce(auth.jwt() ->> 'email', current_user::text) $$;

alter table public.reglages            enable row level security;
alter table public.assistantes         enable row level security;
alter table public.pointages           enable row level security;
alter table public.tentatives_refusees enable row level security;
alter table public.demandes            enable row level security;
alter table public.admins              enable row level security;
alter table public.journal             enable row level security;

do $$
declare t text;
begin
  foreach t in array array['reglages','assistantes','pointages','tentatives_refusees','demandes','admins','journal'] loop
    execute format('drop policy if exists admin_all on public.%I', t);
    execute format('drop policy if exists admin_read on public.%I', t);
    execute format('create policy admin_all on public.%I for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()))', t);
  end loop;
end $$;

-- =====================================================================
-- 5. JOURNAL ET PROTECTION DES DONNÉES
-- =====================================================================
create or replace function public.tg_journal()
returns trigger language plpgsql security definer
set search_path = ''
as $$
begin
  -- Ni le jeton, ni la position GPS ne sont recopiés dans le journal
  insert into public.journal (qui, table_nom, operation, avant, apres)
  values (public.email_admin(), tg_table_name, tg_op,
          case when tg_op <> 'INSERT' then to_jsonb(old) - 'jeton' - 'lat' - 'lng' - 'precision_m' end,
          case when tg_op <> 'DELETE' then to_jsonb(new) - 'jeton' - 'lat' - 'lng' - 'precision_m' end);
  return coalesce(new, old);
end;
$$;
update public.journal
   set avant = avant - 'lat' - 'lng' - 'precision_m',
       apres = apres - 'lat' - 'lng' - 'precision_m'
 where table_nom = 'pointages' and (avant ? 'lat' or apres ? 'lat');

-- Seules les actions des admins sont journalisées (pas chaque pointage de l'app)
drop trigger if exists journal on public.pointages;
create trigger journal after insert or update or delete on public.pointages
  for each row when (current_user = 'authenticated')
  execute function public.tg_journal();
drop trigger if exists journal on public.assistantes;
create trigger journal after insert or update or delete on public.assistantes
  for each row when (current_user = 'authenticated')
  execute function public.tg_journal();
drop trigger if exists journal on public.reglages;
create trigger journal after update on public.reglages
  for each row when (current_user = 'authenticated')
  execute function public.tg_journal();
drop trigger if exists journal on public.demandes;

-- Un admin ne peut ni fabriquer un pointage « app », ni modifier l'heure ou la
-- position d'un pointage, ni falsifier qui a annulé ou validé quoi.
create or replace function public.tg_pointages_admin()
returns trigger language plpgsql
set search_path = ''
as $$
begin
  if current_user = 'authenticated' then
    if tg_op = 'INSERT' then
      new.source    := 'admin';
      new.cree_par  := public.email_admin();
      new.cree_le   := now();
      new.cle       := null;
      new.appareil  := null;
      new.annule_le := null; new.annule_par := null;
      new.valide_le := null; new.valide_par := null;
      new.lat := null; new.lng := null; new.precision_m := null; new.distance_m := null;
      if new.horodatage > now() + interval '5 minutes' then
        raise exception 'Impossible d''ajouter un pointage dans le futur';
      end if;
    else
      if (new.assistante_id, new.type, new.horodatage, new.lat, new.lng, new.precision_m,
          new.distance_m, new.source, new.cree_par, new.cree_le, new.cle, new.appareil)
         is distinct from
         (old.assistante_id, old.type, old.horodatage, old.lat, old.lng, old.precision_m,
          old.distance_m, old.source, old.cree_par, old.cree_le, old.cle, old.appareil) then
        raise exception 'Un pointage ne se modifie pas : annulez-le puis ajoutez-en un nouveau';
      end if;
      -- Annulation / rétablissement : date et auteur toujours imposés
      if old.source = 'app' and new.note is distinct from old.note then
        raise exception 'Champ non modifiable';
      end if;
      if old.annule_le is not null and new.annule_le is not null and new.annule_le is distinct from old.annule_le then
        raise exception 'Déjà annulé';
      end if;
      if old.valide_le is not null and new.valide_le is not null and new.valide_le is distinct from old.valide_le then
        raise exception 'Déjà confirmé';
      end if;
      if new.annule_le is distinct from old.annule_le then
        if new.annule_le is null then new.annule_par := null;
        else new.annule_le := now(); new.annule_par := public.email_admin(); end if;
      elsif new.annule_par is distinct from old.annule_par then
        raise exception 'Champ non modifiable';
      end if;
      -- Confirmation d'une durée : idem
      if new.valide_le is distinct from old.valide_le then
        if new.valide_le is null then new.valide_par := null;
        else new.valide_le := now(); new.valide_par := public.email_admin(); end if;
      elsif new.valide_par is distinct from old.valide_par then
        raise exception 'Champ non modifiable';
      end if;
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists source_admin on public.pointages;
drop trigger if exists protection on public.pointages;
create trigger protection before insert or update on public.pointages
  for each row execute function public.tg_pointages_admin();

-- Jeton d'assistante : toujours généré par le serveur (bouton « Nouveau lien »)
create or replace function public.tg_assistantes()
returns trigger language plpgsql security definer
set search_path = ''
as $$
begin
  new.prenom := btrim(new.prenom);
  if tg_op = 'INSERT' or new.jeton is distinct from old.jeton then
    new.jeton := encode(extensions.gen_random_bytes(16), 'hex');
  end if;
  if tg_op = 'INSERT' then new.cree_le := now(); else new.cree_le := old.cree_le; end if;
  return new;
end;
$$;
drop trigger if exists protection on public.assistantes;
create trigger protection before insert or update on public.assistantes
  for each row execute function public.tg_assistantes();

-- =====================================================================
-- 6. FONCTIONS INTERNES (jamais appelables depuis l'extérieur, voir section 10)
-- =====================================================================
create or replace function public.distance_m(lat1 double precision, lng1 double precision,
                                             lat2 double precision, lng2 double precision)
returns double precision language sql immutable
set search_path = ''
as $$
  select 2 * 6371000 * asin(least(1, sqrt(
      power(sin(radians(lat2 - lat1) / 2), 2)
    + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)
  )));
$$;

-- Effacement automatique (RGPD)
--  - positions GPS des pointages : après N jours (réglable, 60 par défaut)
--  - tentatives refusées : après 6 mois
--  - heures, demandes et journal : après 3 ans
create or replace function public._purge()
returns void language plpgsql security definer
set search_path = ''
as $$
begin
  update public.pointages
     set lat = null, lng = null
   where lat is not null
     and horodatage < now() - make_interval(days => (select conservation_gps_j from public.reglages where id = 1));
  update public.tentatives_refusees set lat = null, lng = null where lat is not null;
  delete from public.tentatives_refusees where horodatage < now() - interval '6 months';
  delete from public.demandes where cree_le < now() - interval '3 years';
  delete from public.journal  where quand   < now() - interval '3 years';
  delete from public.pointages where horodatage < now() - interval '3 years';
  update public.reglages set derniere_purge = now() where id = 1;
end;
$$;

-- Version qui ne peut jamais faire échouer l'appelant (utilisée par pointer)
create or replace function public._purge_sans_risque()
returns void language plpgsql security definer
set search_path = ''
as $$
begin
  perform public._purge();
exception when others then
  raise warning 'Purge RGPD en échec : %', sqlerrm;
end;
$$;

drop function if exists public._sessions(timestamptz, timestamptz, uuid);
-- Calcul des interventions (arrivée -> départ) sur une période.
-- Une intervention est rattachée à la période de son début (l'arrivée).
create or replace function public._sessions(p_debut timestamptz, p_fin timestamptz, p_assistante uuid)
returns table (
  assistante_id uuid,
  arrivee_id bigint, arrivee timestamptz, arrivee_source text,
  depart_id  bigint, depart  timestamptz, depart_source  text,
  duree_min  int,
  statut     text,      -- ok | en_cours | longue | courte | depart_manquant | arrivee_manquante
  valide     boolean,   -- durée inhabituelle confirmée par la famille
  suspect    boolean    -- précision GPS anormalement parfaite
)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  r      public.reglages%rowtype;
  p      record;
  o      record;
  v_cur  uuid := null;
  v_open boolean := false;
  v_max  interval;
  v_al   interval;
  v_d    interval;
begin
  select * into r from public.reglages where id = 1;
  v_max := make_interval(hours => r.duree_max_h);

  for p in
    select pt.id, pt.assistante_id, pt.type, pt.horodatage, pt.source, pt.valide_le,
           (pt.source = 'app' and pt.precision_m is not null and pt.precision_m < 2) as susp,
           make_interval(hours => coalesce(a.alerte_h, r.alerte_h)) as alerte
      from public.pointages pt
      join public.assistantes a on a.id = pt.assistante_id
     where pt.annule_le is null
       and (p_assistante is null or pt.assistante_id = p_assistante)
       and pt.horodatage >= p_debut - v_max
       and pt.horodatage <  p_fin   + v_max
     -- à heure égale, le départ passe avant l'arrivée (relève, fin de nuit / début de journée)
     order by pt.assistante_id, pt.horodatage, (pt.type = 'arrivee'), pt.id
  loop
    if v_cur is distinct from p.assistante_id then
      if v_open then
        assistante_id := o.assistante_id; arrivee_id := o.id; arrivee := o.horodatage; arrivee_source := o.source;
        depart_id := null; depart := null; depart_source := null; duree_min := null; valide := false;
        statut := case when now() - o.horodatage <= v_max then 'en_cours' else 'depart_manquant' end;
        suspect := o.susp;
        if o.horodatage >= p_debut and o.horodatage < p_fin then return next; end if;
      end if;
      v_cur := p.assistante_id; v_open := false;
    end if;

    if p.type = 'arrivee' then
      if v_open then
        assistante_id := o.assistante_id; arrivee_id := o.id; arrivee := o.horodatage; arrivee_source := o.source;
        depart_id := null; depart := null; depart_source := null; duree_min := null; valide := false;
        statut := 'depart_manquant'; suspect := o.susp;
        if o.horodatage >= p_debut and o.horodatage < p_fin then return next; end if;
      end if;
      o := p; v_open := true;
    else
      if v_open and p.horodatage - o.horodatage <= v_max then
        v_d := p.horodatage - o.horodatage;
        assistante_id := o.assistante_id; arrivee_id := o.id; arrivee := o.horodatage; arrivee_source := o.source;
        depart_id := p.id; depart := p.horodatage; depart_source := p.source;
        duree_min := round(extract(epoch from v_d) / 60)::int;
        valide := p.valide_le is not null;
        statut := case
                    when v_d > o.alerte and not valide then 'longue'
                    when v_d < interval '5 minutes' and not valide then 'courte'
                    else 'ok' end;
        suspect := o.susp or p.susp;
        if o.horodatage >= p_debut and o.horodatage < p_fin then return next; end if;
        v_open := false;
      else
        if v_open then
          assistante_id := o.assistante_id; arrivee_id := o.id; arrivee := o.horodatage; arrivee_source := o.source;
          depart_id := null; depart := null; depart_source := null; duree_min := null; valide := false;
          statut := 'depart_manquant'; suspect := o.susp;
          if o.horodatage >= p_debut and o.horodatage < p_fin then return next; end if;
          v_open := false;
        end if;
        assistante_id := p.assistante_id; arrivee_id := null; arrivee := null; arrivee_source := null;
        depart_id := p.id; depart := p.horodatage; depart_source := p.source; duree_min := null; valide := false;
        statut := 'arrivee_manquante'; suspect := p.susp;
        if p.horodatage >= p_debut and p.horodatage < p_fin then return next; end if;
      end if;
    end if;
  end loop;

  if v_open then
    assistante_id := o.assistante_id; arrivee_id := o.id; arrivee := o.horodatage; arrivee_source := o.source;
    depart_id := null; depart := null; depart_source := null; duree_min := null; valide := false;
    statut := case when now() - o.horodatage <= v_max then 'en_cours' else 'depart_manquant' end;
    suspect := o.susp;
    if o.horodatage >= p_debut and o.horodatage < p_fin then return next; end if;
  end if;
end;
$$;

-- Arrivée en cours (non clôturée) d'une assistante
create or replace function public._arrivee_ouverte(p_id uuid)
returns timestamptz language sql stable security definer
set search_path = ''
as $$
  select case when d.type = 'arrivee'
               and d.horodatage > now() - make_interval(hours => (select duree_max_h from public.reglages where id = 1))
              then d.horodatage end
    from (select type, horodatage from public.pointages
           where assistante_id = p_id and annule_le is null
           order by horodatage desc, (type = 'arrivee') desc, id desc limit 1) d;
$$;

create or replace function public._assistante(p_jeton text)
returns uuid language sql stable security definer
set search_path = ''
as $$
  select id from public.assistantes
   where p_jeton ~ '^[0-9a-f]{32}$' and jeton = p_jeton and active;
$$;

-- =====================================================================
-- 7. FONCTIONS DE LA PAGE DES ASSISTANTES (lien personnel)
-- =====================================================================
drop function if exists public.etat_assistante(uuid, text);
drop function if exists public.pointer(uuid, text, text, double precision, double precision, double precision, text);
drop function if exists public.pointer(text, text, double precision, double precision, double precision);
drop function if exists public.pointer(text, text, double precision, double precision, double precision, uuid, boolean);
drop function if exists public.mes_heures(text);
drop function if exists public.config_publique();
drop function if exists public.liste_assistantes();
drop function if exists public._verifier_pin(uuid, text);
drop function if exists public.admin_creer_assistante(text, text, numeric);
drop function if exists public.admin_changer_pin(uuid, text);

create or replace function public.etat_assistante(p_jeton text)
returns json language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_id      uuid;
  a         public.assistantes%rowtype;
  r         public.reglages%rowtype;
  v_ouverte timestamptz;
  v_dernier record;
begin
  v_id := public._assistante(p_jeton);
  if v_id is null then
    return json_build_object('ok', false, 'erreur', 'lien_invalide');
  end if;
  select * into a from public.assistantes where id = v_id;
  select * into r from public.reglages where id = 1;
  v_ouverte := public._arrivee_ouverte(v_id);
  select type, horodatage into v_dernier from public.pointages
   where assistante_id = v_id and annule_le is null
   order by horodatage desc, (type = 'arrivee') desc, id desc limit 1;

  return json_build_object(
    'ok', true,
    'prenom', a.prenom,
    'configure', r.lat is not null and r.lng is not null,
    'presente', v_ouverte is not null,
    'arrivee', v_ouverte,
    'longue', v_ouverte is not null
              and now() - v_ouverte > make_interval(hours => coalesce(a.alerte_h, r.alerte_h)),
    'dernier_type', v_dernier.type,
    'dernier_horodatage', v_dernier.horodatage,
    'telephone_famille', r.telephone_famille,
    'conservation_gps_j', r.conservation_gps_j,
    'maintenant', now()
  );
end;
$$;

create or replace function public.pointer(
  p_jeton     text,
  p_type      text,
  p_lat       double precision,
  p_lng       double precision,
  p_precision double precision,
  p_cle       uuid    default null,
  p_forcer    boolean default false,
  p_appareil  text    default null
)
returns json language plpgsql security definer
set search_path = ''
as $$
declare
  r         public.reglages%rowtype;
  v_id      uuid;
  v_dist    double precision;
  v_prec    double precision;
  v_marge   double precision;
  v_ouverte timestamptz;
  v_exist   record;
  v_horo    timestamptz;
  v_log     boolean;
  v_app     text;
  v_n24     int;
begin
  if p_type is null or p_type not in ('arrivee', 'depart') then
    return json_build_object('ok', false, 'erreur', 'type');
  end if;

  v_id := public._assistante(p_jeton);
  if v_id is null then
    return json_build_object('ok', false, 'erreur', 'lien_invalide');
  end if;

  -- Un seul pointage à la fois par assistante
  perform pg_advisory_xact_lock(hashtext(v_id::text));

  -- Même demande renvoyée après une coupure réseau : on renvoie le résultat initial
  if p_cle is not null then
    select horodatage, type into v_exist from public.pointages where assistante_id = v_id and cle = p_cle;
    if found then
      return json_build_object('ok', true, 'doublon', true, 'type', v_exist.type, 'horodatage', v_exist.horodatage);
    end if;
  end if;

  select * into r from public.reglages where id = 1;
  if r.lat is null or r.lng is null then
    return json_build_object('ok', false, 'erreur', 'non_configure');
  end if;

  -- On ne garde pas plus de 20 refus par heure et par assistante
  v_log := (select count(*) from public.tentatives_refusees
             where assistante_id = v_id and horodatage > now() - interval '1 hour') < 20;

  if p_lat is null or p_lng is null
     or p_lat = 'NaN'::float8 or p_lng = 'NaN'::float8
     or not (p_lat between -90 and 90) or not (p_lng between -180 and 180) then
    if v_log then
      insert into public.tentatives_refusees (assistante_id, type, motif)
      values (v_id, p_type, 'Position absente ou invalide');
    end if;
    return json_build_object('ok', false, 'erreur', 'position');
  end if;

  v_prec  := case when p_precision is null or p_precision = 'NaN'::float8 or p_precision < 0 then null
                  else least(p_precision, 100000) end;
  v_dist  := public.distance_m(r.lat, r.lng, p_lat, p_lng);
  -- Tolérance pour l'imprécision du GPS en intérieur, plafonnée à 100 m
  v_marge := least(coalesce(v_prec, 0), 100);

  if v_dist - v_marge > r.rayon_m then
    if v_log then
      insert into public.tentatives_refusees (assistante_id, type, precision_m, distance_m, motif)
      values (v_id, p_type, v_prec, round(v_dist::numeric, -1), 'Hors zone');
    end if;
    return json_build_object('ok', false, 'erreur', 'hors_zone',
                             'distance_m', case when v_dist < 1000 then round(v_dist::numeric, -1)
                                                else round(v_dist::numeric, -2) end);
  end if;

  -- Double appui : le dernier pointage est du même type et date de moins de 2 min
  select type, horodatage into v_exist from public.pointages
   where assistante_id = v_id and annule_le is null
   order by horodatage desc, (type = 'arrivee') desc, id desc limit 1;
  if found and v_exist.type = p_type and v_exist.horodatage > now() - interval '2 minutes' then
    return json_build_object('ok', true, 'doublon', true, 'type', p_type, 'horodatage', v_exist.horodatage);
  end if;

  -- Plafond de sécurité : 12 pointages par 24 h
  select count(*) into v_n24 from public.pointages
   where assistante_id = v_id and source = 'app' and annule_le is null and horodatage > now() - interval '24 hours';
  if v_n24 >= 12 then
    return json_build_object('ok', false, 'erreur', 'trop');
  end if;

  -- Cohérence : pas de 2e arrivée sans départ, pas de départ sans arrivée (sauf confirmation)
  v_ouverte := public._arrivee_ouverte(v_id);
  if not coalesce(p_forcer, false) then
    if p_type = 'arrivee' and v_ouverte is not null then
      return json_build_object('ok', false, 'erreur', 'deja_arrivee', 'arrivee', v_ouverte);
    end if;
    if p_type = 'depart' and v_ouverte is null then
      return json_build_object('ok', false, 'erreur', 'pas_arrivee');
    end if;
  end if;

  -- Identifiant de l'appareil (tiré au hasard par l'app), conservé sous forme courte et hachée
  v_app := case when p_appareil ~ '^[0-9a-zA-Z-]{8,64}$'
                then left(encode(extensions.digest(p_appareil, 'sha256'), 'hex'), 8) end;

  insert into public.pointages (assistante_id, type, lat, lng, precision_m, distance_m, cle, appareil)
  values (v_id, p_type, p_lat, p_lng, v_prec, v_dist, p_cle, v_app)
  returning horodatage into v_horo;

  perform public._purge_sans_risque();

  return json_build_object('ok', true, 'type', p_type, 'horodatage', v_horo,
                           'distance_m', round(v_dist::numeric));
end;
$$;

-- L'assistante signale un oubli ; la famille valide ensuite
create or replace function public.declarer(p_jeton text, p_type text, p_horodatage timestamptz, p_message text)
returns json language plpgsql security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_n  int;
begin
  v_id := public._assistante(p_jeton);
  if v_id is null then
    return json_build_object('ok', false, 'erreur', 'lien_invalide');
  end if;
  if p_type is null or p_type not in ('arrivee', 'depart') then
    return json_build_object('ok', false, 'erreur', 'type');
  end if;
  if p_horodatage is null or p_horodatage > now() + interval '5 minutes'
     or p_horodatage < now() - interval '14 days' then
    return json_build_object('ok', false, 'erreur', 'date');
  end if;
  select count(*) into v_n from public.demandes where assistante_id = v_id and statut = 'en_attente';
  if v_n >= 10 then
    return json_build_object('ok', false, 'erreur', 'trop_de_demandes');
  end if;
  insert into public.demandes (assistante_id, type, horodatage_declare, message)
  values (v_id, p_type, p_horodatage, nullif(left(btrim(coalesce(p_message, '')), 300), ''));
  return json_build_object('ok', true);
end;
$$;

-- L'assistante consulte ses heures : mois en cours (0) ou précédent (-1), heure de Paris
create or replace function public.mes_heures(p_jeton text, p_decalage int default 0)
returns json language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_id    uuid;
  v_mois  timestamp;
  v_debut timestamptz;
  v_fin   timestamptz;
begin
  v_id := public._assistante(p_jeton);
  if v_id is null then
    return json_build_object('ok', false, 'erreur', 'lien_invalide');
  end if;
  v_mois  := date_trunc('month', now() at time zone 'Europe/Paris')
             + make_interval(months => greatest(-1, least(0, coalesce(p_decalage, 0))));
  v_debut := v_mois at time zone 'Europe/Paris';
  v_fin   := (v_mois + interval '1 month') at time zone 'Europe/Paris';
  return json_build_object(
    'ok', true,
    'debut', v_debut,
    'decalage', greatest(-1, least(0, coalesce(p_decalage, 0))),
    'sessions', coalesce((
      select json_agg(json_build_object('arrivee', s.arrivee, 'depart', s.depart,
                                        'duree_min', s.duree_min, 'statut', s.statut)
                      order by coalesce(s.arrivee, s.depart))
        from public._sessions(v_debut, v_fin, v_id) s), '[]'::json),
    'demandes', coalesce((
      select json_agg(json_build_object('type', d.type, 'horodatage', d.horodatage_declare, 'statut', d.statut)
                      order by d.cree_le desc)
        from public.demandes d
       where d.assistante_id = v_id and d.cree_le > now() - interval '45 days'), '[]'::json)
  );
end;
$$;

-- =====================================================================
-- 8. FONCTIONS DE L'ESPACE FAMILLE (réservées aux admins)
-- =====================================================================
create or replace function public.admin_sessions(p_debut timestamptz, p_fin timestamptz)
returns setof json language plpgsql stable security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then raise exception 'Accès refusé'; end if;
  if p_fin <= p_debut or p_fin - p_debut > interval '400 days' then raise exception 'Période invalide'; end if;
  return query
    select row_to_json(s) from public._sessions(p_debut, p_fin, null) s
     order by coalesce(s.arrivee, s.depart);
end;
$$;

create or replace function public.admin_traiter_demande(p_id bigint, p_accepter boolean)
returns json language plpgsql security definer
set search_path = ''
as $$
declare
  d    public.demandes%rowtype;
  v_pt bigint;
begin
  if not public.is_admin() then raise exception 'Accès refusé'; end if;
  select * into d from public.demandes where id = p_id for update;
  if not found or d.statut <> 'en_attente' then
    return json_build_object('ok', false, 'erreur', 'deja_traitee');
  end if;
  if p_accepter then
    insert into public.pointages (assistante_id, type, horodatage, source, note, cree_par)
    values (d.assistante_id, d.type, d.horodatage_declare, 'admin',
            left('Déclaré par l''assistante' || coalesce(' : ' || d.message, ''), 300),
            public.email_admin())
    returning id into v_pt;
  end if;
  update public.demandes
     set statut = case when p_accepter then 'acceptee' else 'refusee' end,
         traite_par = public.email_admin(), traite_le = now(), pointage_id = v_pt
   where id = p_id;
  insert into public.journal (qui, table_nom, operation, apres)
  values (public.email_admin(), 'demandes', case when p_accepter then 'ACCEPTEE' else 'REFUSEE' end,
          jsonb_build_object('demande', p_id, 'pointage', v_pt, 'assistante_id', d.assistante_id,
                             'type', d.type, 'horodatage', d.horodatage_declare));
  return json_build_object('ok', true, 'pointage_id', v_pt);
end;
$$;

-- Corriger une intervention en une seule fois (tout ou rien) :
-- les pointages d'origine sont annulés et remplacés.
create or replace function public.admin_corriger_session(
  p_assistante uuid, p_arrivee_id bigint, p_depart_id bigint,
  p_arrivee timestamptz, p_depart timestamptz, p_motif text)
returns json language plpgsql security definer
set search_path = ''
as $$
declare
  r       public.reglages%rowtype;
  v_qui   text := public.email_admin();
  v_note  text := left('Correction' || coalesce(' : ' || nullif(btrim(p_motif), ''), ''), 300);
  old_a   public.pointages%rowtype;
  old_d   public.pointages%rowtype;
  ch_a    boolean;
  ch_d    boolean;
begin
  if not public.is_admin() then raise exception 'Accès refusé'; end if;
  select * into r from public.reglages where id = 1;
  if p_arrivee is null or p_depart is null then raise exception 'Indiquez l''arrivée et le départ'; end if;
  if p_depart <= p_arrivee then raise exception 'Le départ doit être après l''arrivée'; end if;
  if p_depart - p_arrivee > make_interval(hours => r.duree_max_h) then
    raise exception 'Durée supérieure au maximum d''une garde (% h)', r.duree_max_h;
  end if;
  if p_depart > now() + interval '5 minutes' then raise exception 'Impossible de saisir une heure dans le futur'; end if;

  if p_arrivee_id is not null then
    select * into old_a from public.pointages where id = p_arrivee_id and assistante_id = p_assistante and type = 'arrivee' and annule_le is null for update;
    if not found then raise exception 'Cette intervention a changé entre-temps : actualisez la page'; end if;
  end if;
  if p_depart_id is not null then
    select * into old_d from public.pointages where id = p_depart_id and assistante_id = p_assistante and type = 'depart' and annule_le is null for update;
    if not found then raise exception 'Cette intervention a changé entre-temps : actualisez la page'; end if;
  end if;

  ch_a := p_arrivee_id is null or date_trunc('minute', old_a.horodatage) is distinct from date_trunc('minute', p_arrivee);
  ch_d := p_depart_id  is null or date_trunc('minute', old_d.horodatage) is distinct from date_trunc('minute', p_depart);
  if not ch_a and not ch_d then return json_build_object('ok', true, 'inchange', true); end if;

  if ch_a and p_arrivee_id is not null then
    update public.pointages set annule_le = now(), annule_par = v_qui where id = p_arrivee_id;
  end if;
  if ch_d and p_depart_id is not null then
    update public.pointages set annule_le = now(), annule_par = v_qui where id = p_depart_id;
  end if;
  if ch_a then
    insert into public.pointages (assistante_id, type, horodatage, source, note, cree_par)
    values (p_assistante, 'arrivee', p_arrivee, 'admin', v_note, v_qui);
  end if;
  if ch_d then
    insert into public.pointages (assistante_id, type, horodatage, source, note, cree_par)
    values (p_assistante, 'depart', p_depart, 'admin', v_note, v_qui);
  elsif p_depart_id is not null then
    -- la durée a changé : une éventuelle confirmation doit être redonnée
    update public.pointages set valide_le = null, valide_par = null where id = p_depart_id;
  end if;

  insert into public.journal (qui, table_nom, operation, avant, apres)
  values (v_qui, 'pointages', 'CORRECTION',
          jsonb_build_object('assistante_id', p_assistante, 'arrivee', old_a.horodatage, 'depart', old_d.horodatage),
          jsonb_build_object('assistante_id', p_assistante, 'arrivee', p_arrivee, 'depart', p_depart, 'motif', left(p_motif, 300)));
  return json_build_object('ok', true);
end;
$$;

-- Effacement manuel (au cas où aucun pointage n'aurait lieu pendant longtemps)
create or replace function public.admin_purger()
returns void language plpgsql security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then raise exception 'Accès refusé'; end if;
  perform public._purge();
end;
$$;

-- =====================================================================
-- 9. NETTOYAGE IMMÉDIAT ET ADMINS
-- =====================================================================
select public._purge();

-- Pour donner accès à l'espace famille (après avoir créé le compte dans
-- Authentication > Users avec « Auto Confirm User ») : voir le GUIDE.
-- Premier admin (à faire une fois, après avoir créé son compte) : voir GUIDE.md
-- insert into public.admins (email) values ('votre.email@exemple.fr') on conflict do nothing;
update public.admins a set user_id = u.id
  from auth.users u
 where a.user_id is null and lower(u.email) = lower(a.email) and u.email_confirmed_at is not null;

-- =====================================================================
-- 10. DROITS SUR LES FONCTIONS — À LA FIN, une fois toutes les fonctions créées
--     (le droit d'exécution « public » de Postgres est retiré partout)
-- =====================================================================
revoke execute on all functions in schema public from public, anon, authenticated;

grant execute on function public.etat_assistante(text)                     to anon, authenticated;
grant execute on function public.pointer(text, text, double precision, double precision, double precision, uuid, boolean, text) to anon, authenticated;
grant execute on function public.declarer(text, text, timestamptz, text)   to anon, authenticated;
grant execute on function public.mes_heures(text, int)                     to anon, authenticated;

grant execute on function public.is_admin()                                to authenticated;
grant execute on function public.email_admin()                             to authenticated;
grant execute on function public.admin_sessions(timestamptz, timestamptz)  to authenticated;
grant execute on function public.admin_traiter_demande(bigint, boolean)    to authenticated;
grant execute on function public.admin_corriger_session(uuid, bigint, bigint, timestamptz, timestamptz, text) to authenticated;
grant execute on function public.admin_purger()                            to authenticated;

-- Contrôle final : le script s'arrête en erreur si une fonction interne reste exposée
do $$
declare v text;
begin
  select string_agg(p.oid::regprocedure::text, ', ') into v
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.prorettype <> 'trigger'::regtype
     and p.proname not in ('etat_assistante', 'pointer', 'declarer', 'mes_heures')
     and has_function_privilege('anon', p.oid, 'execute');
  if v is not null then raise exception 'Fonctions exposées aux visiteurs : %', v; end if;

  select string_agg(p.oid::regprocedure::text, ', ') into v
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.prorettype <> 'trigger'::regtype
     and p.proname not in ('etat_assistante', 'pointer', 'declarer', 'mes_heures', 'is_admin', 'email_admin',
                           'admin_sessions', 'admin_traiter_demande', 'admin_corriger_session', 'admin_purger')
     and has_function_privilege('authenticated', p.oid, 'execute');
  if v is not null then raise exception 'Fonctions internes exposées aux comptes : %', v; end if;
end $$;

commit;
