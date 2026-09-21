#!/usr/bin/env bash
# The container, proven end to end: build, boot, serve, proxy, isolate, back up,
# restore. Everything here is something the gate lane cannot see -- it runs on
# the laptop's Bun and the laptop's MariaDB. The backup checks exist because the
# first real run failed them: trixie's MariaDB 11.8 client demands TLS by default
# and mariadb:10.11 has none, so the dump deploy.sh takes before a migration would
# have blocked every migration.
#
# Runs as its own compose project on its own network, port and volume, so it is
# safe beside a real stack on the same server, and tears all of it down on exit.
#
#   scripts/docker-smoke.sh          # ~1 min warm, a few cold
set -euo pipefail
cd "$(dirname "$0")/.."

export COMPOSE_PROJECT_NAME=lumpysmoke PROXY_NETWORK=lumpysmoke-proxy
export PORT=3097 DB_PORT=3397 MYSQL_ROOT_PASSWORD=smoke$RANDOM TZ=America/New_York
export GEMINI_API_KEY= GEMINI_MODEL=
unset COMPOSE_FILE
base="http://127.0.0.1:$PORT"
# Every `| grep` below writes to /dev/null rather than using -q, on purpose: -q
# exits on the first match, the writer takes SIGPIPE, and pipefail fails a
# pipeline that matched. That flaked the migration check here, and it hides a
# leak in the inverted checks (a traversal that works reads as one that did not).

pass=0
ok()   { pass=$((pass + 1)); printf '  ok    %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*"; exit 1; }
cleanup() {
  # -v removes this project's volume only: lumpysmoke_dbdata, created above.
  docker compose down -v --remove-orphans >/dev/null 2>&1 || true
  docker network rm "$PROXY_NETWORK" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

docker network create "$PROXY_NETWORK" >/dev/null

echo "building"
docker compose build --progress quiet >/dev/null
bun_in_image=$(docker compose run --rm --no-deps -T --entrypoint bun app --version)
# FROM oven/bun:1 floats, so drift is expected and not a failure -- but the tests
# ran on the host's Bun, so it is worth saying. A server usually has no Bun at all.
if ! command -v bun >/dev/null; then
  ok "image runs Bun $bun_in_image (no Bun on this host to compare)"
elif [ "$bun_in_image" = "$(bun --version)" ]; then
  ok "image runs Bun $bun_in_image, same as this host"
else
  ok "image runs Bun $bun_in_image"
  printf '  warn  this host has Bun %s, so the gate tests ran on a different runtime: bun upgrade\n' "$(bun --version)"
fi

echo "booting"
docker compose up -d >/dev/null 2>&1
for _ in $(seq 1 45); do
  curl -sf "$base/api/categories" >/dev/null && break
  sleep 2
done
curl -sf "$base/api/categories" >/dev/null && ok "app answers a database-backed request" || {
  docker compose logs --tail 40 app; fail "app never answered"; }
docker compose logs app | grep "applied 001_init.sql" >/dev/null && ok "a fresh database gets every migration" \
  || fail "migrations did not run from 001"

echo "serving"
code() { curl -s -o /dev/null -w '%{http_code}' "$base$1"; }
body() { curl -s "$base$1"; }
[ "$(code /)" = 200 ] && body / | grep '<div id="root">' >/dev/null && ok "/ is the app" || fail "/ is not the app"
[ "$(code /expenses)" = 200 ] && body /expenses | grep '<div id="root">' >/dev/null && ok "a client route falls back to the app" \
  || fail "/expenses did not fall back"
[ "$(code /api/nope)" = 404 ] && [ "$(body /api/nope)" = '{"error":"not found"}' ] && ok "an unknown /api path is a JSON 404" \
  || fail "/api/nope was not a JSON 404"
body /%2e%2e%2fpackage.json | grep '"workspaces"' >/dev/null && fail "an encoded .. read package.json" \
  || ok "an encoded .. stays inside dist"

echo "networks"
lan=$(ipconfig getifaddr en0 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')
if [ -n "$lan" ]; then
  curl -s -m 3 -o /dev/null "http://$lan:$PORT/" && fail "the app answers on the LAN at $lan" \
    || ok "the app is loopback-only, not on $lan"
fi
docker run --rm --network "$PROXY_NETWORK" busybox:1.36 wget -qO- http://lumpy:3001/api/categories >/dev/null \
  && ok "the proxy network reaches the app as lumpy:3001" || fail "lumpy:3001 unreachable from the proxy network"
docker run --rm --network "$PROXY_NETWORK" busybox:1.36 nc -z -w 2 db 3306 2>/dev/null \
  && fail "the database is reachable from the proxy network" || ok "the database is not on the proxy network"

echo "clocks"
q() { docker compose exec -T db mariadb -uroot -p"$MYSQL_ROOT_PASSWORD" -N lumpy_budget -e "$1"; }
in_app() { docker compose exec -T app bun -e "$1"; }
app_day=$(in_app 'import {todayISO} from "@lumpy/budget-core"; console.log(todayISO())')
db_day=$(q 'select curdate()')
[ "$app_day" = "$db_day" ] && ok "app and database agree it is $app_day" || fail "app says $app_day, database says $db_day"
# The check above asks the mariadb CLI, whose session is SYSTEM. The app's own
# driver is what matters, and Bun 1.4 puts its sessions on UTC: a balance typed
# at 23:30 last night must still be as of last night, through the real route.
# Pinned to 23:30 rather than "now" so this fails at any hour, not only after 8pm.
yesterday=$(in_app 'import {addDays,todayISO} from "@lumpy/budget-core"; console.log(addDays(todayISO(), -1))')
late=$(in_app "console.log(new Date('${yesterday}T23:30:00').toISOString().slice(0, 19).replace('T', ' '))")
curl -sf -X PUT "$base/api/settings" -H 'content-type: application/json' \
  -d '{"name":"checking_balance_cents","value":"100000"}' >/dev/null
q "update settings set updated_at = convert_tz('$late', '+00:00', @@session.time_zone) where name = 'checking_balance_cents'"
as_of=$(in_app 'const r = await fetch("http://localhost:3001/api/cash-position"); console.log((await r.json()).as_of)')
[ "$as_of" = "$yesterday" ] && ok "a balance typed at 23:30 last night is as of last night" \
  || fail "a balance typed at 23:30 on $yesterday reads as of $as_of: the driver's session clock is leaking into SQL"

echo "backup"
docker compose exec -T app bun run demo >/dev/null 2>&1
fp="select count(*), sum(amount_cents), max(txn_date), (select count(*) from fixed_costs), (select count(*) from lumpy_items) from expenses"
before=$(q "$fp")
# To /tmp inside the container, not the ./backups mount: on a server running the
# real stack, a smoke dump beside the real ones is indistinguishable from them.
dump=/tmp/smoke.sql
docker compose exec -T app bun run backup "$dump" >/dev/null 2>&1 && ok "bun run backup succeeds inside the container" \
  || { docker compose exec -T app bun run backup "$dump" || true; fail "backup failed inside the container"; }
docker compose exec -T app tail -1 "$dump" | grep "Dump completed" >/dev/null && ok "the dump is complete" || fail "the dump is truncated"
q "delete from expenses; delete from fixed_costs; delete from lumpy_items"
docker compose exec -T app sh -c "cat '$dump'" | docker compose exec -T db mariadb -uroot -p"$MYSQL_ROOT_PASSWORD"
after=$(q "$fp")
[ "$before" = "$after" ] && ok "wipe and restore round-trips ($before)" || fail "restore differs: $before vs $after"

echo
echo "$pass checks passed"
