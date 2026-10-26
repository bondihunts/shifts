-- =====================================================================
--  Application de pointage — base de données Supabase
--  À coller en entier dans Supabase > SQL Editor > New query > Run
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

-- Réglages (une seule ligne)
create table if not exists public.reglages (
  id       int primary key default 1 check (id = 1),
  adresse  text,
  lat      double precision,
  lng      double precision,
  rayon_m  int not null default 150 check (rayon_m between 20 and 2000)
);
insert into public.reglages (id, adresse)
values (1, '12 rue des Lilas, 75011 Paris')
on conflict (id) do nothing;

-- Assistantes de vie. Chacune a un lien personnel (jeton secret).
create table if not exists public.assistantes (
  id           uuid primary key default gen_random_uuid(),
  prenom       text not null,
  jeton        text not null unique default encode(extensions.gen_random_bytes(16), 'hex'),
  taux_horaire numeric(6,2),
  active       boolean not null default true,
  cree_le      timestamptz not null default now()
);

-- Pointages validés
create table if not exists public.pointages (
  id            bigint generated always as identity primary key,
  assistante_id uuid not null references public.assistantes(id) on delete cascade,
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
create index if not exists pointages_assistante_horo on public.pointages (assistante_id, horodatage);
create index if not exists pointages_horo on public.pointages (horodatage);

-- Tentatives refusées (hors zone, position absente…)
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

-- Emails autorisés à voir la partie admin
create table if not exists public.admins (
  email text primary key
);

-- ---------------------------------------------------------------------
-- Sécurité : personne ne lit les tables directement, sauf les admins
-- ---------------------------------------------------------------------

create or replace function public.is_admin()
returns boolean language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.admins
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

alter table public.reglages            enable row level security;
alter table public.assistantes         enable row level security;
alter table public.pointages           enable row level security;
alter table public.tentatives_refusees enable row level security;
alter table public.admins              enable row level security;

drop policy if exists admin_all  on public.reglages;
drop policy if exists admin_all  on public.assistantes;
drop policy if exists admin_all  on public.pointages;
drop policy if exists admin_all  on public.tentatives_refusees;
drop policy if exists admin_read on public.admins;

create policy admin_all  on public.reglages            for all    to authenticated using (public.is_admin()) with check (public.is_admin());
create policy admin_all  on public.assistantes         for all    to authenticated using (public.is_admin()) with check (public.is_admin());
create policy admin_all  on public.pointages           for all    to authenticated using (public.is_admin()) with check (public.is_admin());
create policy admin_all  on public.tentatives_refusees for all    to authenticated using (public.is_admin()) with check (public.is_admin());
create policy admin_read on public.admins              for select to authenticated using (public.is_admin());

-- ---------------------------------------------------------------------
-- Fonctions
-- ---------------------------------------------------------------------

-- Distance en mètres entre deux points GPS
create or replace function public.distance_m(lat1 double precision, lng1 double precision,
                                             lat2 double precision, lng2 double precision)
returns double precision language sql immutable
as $$
  select 2 * 6371000 * asin(sqrt(
      power(sin(radians(lat2 - lat1) / 2), 2)
    + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)
  ));
$$;

-- Qui suis-je + dernier pointage (appelé à l'ouverture de l'app)
create or replace function public.etat_assistante(p_jeton text)
returns json language plpgsql stable security definer
set search_path = public
as $$
declare
  a assistantes%rowtype;
  v_dernier record;
  v_configure boolean;
begin
  select * into a from assistantes where jeton = p_jeton and active;
  if a.id is null then
    return json_build_object('ok', false, 'erreur', 'lien_invalide');
  end if;

  select lat is not null and lng is not null into v_configure from reglages where id = 1;

  select type, horodatage into v_dernier from pointages
   where assistante_id = a.id order by horodatage desc limit 1;

  return json_build_object(
    'ok', true,
    'prenom', a.prenom,
    'configure', v_configure,
    'dernier_type', v_dernier.type,
    'dernier_horodatage', v_dernier.horodatage
  );
end;
$$;

-- Le pointage : toutes les vérifications sont faites ici, côté serveur,
-- et l'heure enregistrée est celle du serveur (pas celle du téléphone).
create or replace function public.pointer(
  p_jeton     text,
  p_type      text,
  p_lat       double precision,
  p_lng       double precision,
  p_precision double precision
)
returns json language plpgsql security definer
set search_path = public
as $$
declare
  r        reglages%rowtype;
  v_id     uuid;
  v_dist   double precision;
  v_marge  double precision;
  v_recent timestamptz;
  v_horo   timestamptz;
begin
  if p_type not in ('arrivee', 'depart') then
    return json_build_object('ok', false, 'erreur', 'type');
  end if;

  select id into v_id from assistantes where jeton = p_jeton and active;
  if v_id is null then
    return json_build_object('ok', false, 'erreur', 'lien_invalide');
  end if;

  select * into r from reglages where id = 1;
  if r.lat is null or r.lng is null then
    return json_build_object('ok', false, 'erreur', 'non_configure');
  end if;

  if p_lat is null or p_lng is null then
    insert into tentatives_refusees (assistante_id, type, motif)
    values (v_id, p_type, 'Position non transmise');
    return json_build_object('ok', false, 'erreur', 'position');
  end if;

  v_dist  := distance_m(r.lat, r.lng, p_lat, p_lng);
  -- Tolérance pour l'imprécision du GPS à l'intérieur, plafonnée à 100 m
  v_marge := least(coalesce(p_precision, 0), 100);

  if v_dist - v_marge > r.rayon_m then
    insert into tentatives_refusees (assistante_id, type, lat, lng, precision_m, distance_m, motif)
    values (v_id, p_type, p_lat, p_lng, p_precision, v_dist, 'Hors zone');
    return json_build_object('ok', false, 'erreur', 'hors_zone', 'distance_m', round(v_dist));
  end if;

  -- Évite les doubles appuis
  select max(horodatage) into v_recent from pointages
   where assistante_id = v_id and type = p_type and horodatage > now() - interval '2 minutes';
  if v_recent is not null then
    return json_build_object('ok', true, 'doublon', true, 'horodatage', v_recent);
  end if;

  insert into pointages (assistante_id, type, lat, lng, precision_m, distance_m)
  values (v_id, p_type, p_lat, p_lng, p_precision, v_dist)
  returning horodatage into v_horo;

  return json_build_object('ok', true, 'horodatage', v_horo, 'distance_m', round(v_dist));
end;
$$;

grant execute on function public.etat_assistante(text) to anon, authenticated;
grant execute on function public.pointer(text, text, double precision, double precision, double precision) to anon, authenticated;

-- ---------------------------------------------------------------------
-- À MODIFIER si besoin : emails autorisés à accéder à l'admin
-- ---------------------------------------------------------------------
insert into public.admins (email) values ('admin@exemple.fr')
on conflict do nothing;
