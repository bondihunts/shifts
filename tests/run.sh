#!/usr/bin/env bash
# Lance les tests de la base sur un PostgreSQL local jetable.
# Usage : bash tests/run.sh   (depuis le dossier pointage)
set -euo pipefail
ICI="$(cd "$(dirname "$0")" && pwd)"
RACINE="$(dirname "$ICI")"
PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
DIR="$(mktemp -d /tmp/pointage-tests.XXXX)"
PORT="${PORT:-5544}"
chmod 777 "$DIR"
cp "$ICI"/*.sql "$RACINE/supabase.sql" "$DIR/"
[ -f "$ICI/v1.sql" ] && cp "$ICI/v1.sql" "$DIR/"
chmod 644 "$DIR"/*.sql
run() { su postgres -c "$*"; }
run "$PGBIN/initdb -D $DIR/data -A trust >/dev/null"
run "$PGBIN/pg_ctl -D $DIR/data -o '-k $DIR -p $PORT -c TimeZone=Europe/Paris' -l $DIR/log start >/dev/null"
trap 'su postgres -c "$PGBIN/pg_ctl -D $DIR/data stop -m immediate" >/dev/null 2>&1; rm -rf "$DIR"' EXIT
PSQL="psql -h $DIR -p $PORT -X -q -v ON_ERROR_STOP=1"
run "$PSQL -f $DIR/supabase_stub.sql" >/dev/null
# 1) base existante en version 1 avec des données
run "$PSQL -f $DIR/v1.sql" >/dev/null 2>&1
run "$PSQL -f $DIR/seed_v1.sql" >/dev/null
# 2) migration vers la version actuelle, deux fois (rejouable)
run "$PSQL -f $DIR/supabase.sql" >/dev/null 2>"$DIR/err1" || { cat "$DIR/err1"; exit 1; }
run "$PSQL -f $DIR/supabase.sql" >/dev/null 2>"$DIR/err2" || { cat "$DIR/err2"; exit 1; }
# 2 bis) installation neuve en UN seul passage (cas d'un nouveau projet)
run "createdb -h $DIR -p $PORT neuve"
run "$PSQL -d neuve -f $DIR/supabase_stub.sql" >/dev/null
run "$PSQL -d neuve -f $DIR/supabase.sql" >/dev/null 2>"$DIR/err3" || { cat "$DIR/err3"; exit 1; }
echo "ok - installation neuve en un passage, aucune fonction interne exposée"
# 3) tests
run "$PSQL -f $DIR/tests.sql" 2>&1 | sed -n 's/.*NOTICE:  //p;s/.*ERROR:  /ERREUR : /p'
echo "Tous les tests de la base sont passés."
