-- Données présentes dans une base en version 1 (pour tester la migration)
grant all on all tables in schema public to anon, authenticated;
update public.reglages set lat = 48.9380, lng = 2.5270;
insert into public.assistantes (prenom, taux_horaire) values ('Fatou', 15), ('Inès', 14);
insert into public.pointages (assistante_id, type, horodatage, lat, lng, precision_m, distance_m)
select id, 'arrivee', now() - interval '40 days', 48.938, 2.527, 20, 5 from public.assistantes where prenom = 'Fatou';
insert into public.pointages (assistante_id, type, horodatage, lat, lng, precision_m, distance_m)
select id, 'depart', now() - interval '40 days' + interval '4 hours', 48.938, 2.527, 20, 5 from public.assistantes where prenom = 'Fatou';
insert into public.pointages (assistante_id, type, horodatage, source, note)
select id, 'arrivee', now() - interval '39 days', 'admin', 'oubli' from public.assistantes where prenom = 'Inès';
insert into public.tentatives_refusees (assistante_id, type, lat, lng, precision_m, distance_m, motif)
select id, 'arrivee', 48.96, 2.527, 10, 2446, 'Hors zone' from public.assistantes where prenom = 'Fatou';
-- Données « hostiles » que la v1 acceptait : la migration doit les nettoyer sans échouer
insert into public.pointages (assistante_id, type, horodatage, lat, lng, precision_m, distance_m, note)
select id, 'depart', now() - interval '70 days', 48.938, 2.527, -5, 5, repeat('x', 400) from public.assistantes where prenom = 'Fatou';
update public.assistantes set prenom = 'Inès' || repeat(' très long', 6) where prenom = 'Inès';
