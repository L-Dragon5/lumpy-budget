#!/usr/bin/env bash
# Pull, build, restart -- the whole deploy, and a no-op when there is nothing new.
# Run it from a systemd timer (see README, "Deploying on a push") or by hand.
#
#   scripts/deploy.sh            # deploy if origin moved, otherwise exit 0
#   scripts/deploy.sh --force    # rebuild and restart at the current commit
#
# Nothing in here needs a registry, a webhook or an inbound port: it is `git
# fetch` from the server outwards.
set -euo pipefail
cd "$(dirname "$0")/.."

log() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

branch="${DEPLOY_BRANCH:-main}"
git fetch --quiet origin "$branch"
have=$(git rev-parse HEAD)
want=$(git rev-parse "origin/$branch")

if [ "$have" = "$want" ] && [ "${1:-}" != "--force" ]; then
  log "up to date at ${have:0:8}"
  exit 0
fi

log "deploying ${have:0:8} -> ${want:0:8}"

# The one case worth a dump first. A migration is forward-only and DDL in MySQL
# cannot roll back, so the backup is the only way back to this morning.
# `grep >/dev/null`, never `grep -q`, behind a pipe here: -q exits on the first
# match, git diff takes SIGPIPE, and pipefail calls the pipeline false -- so a big
# diff full of migrations would read as none and skip exactly this backup.
if git diff --name-only "$have" "$want" | grep '^services/db/migrations/' >/dev/null; then
  if [ -n "$(docker compose ps --status running --quiet app 2>/dev/null)" ]; then
    log "migrations in this diff, backing up first"
    # No `|| true`: a failed backup before a migration is a reason to stop.
    docker compose exec -T app bun run backup
  else
    log "migrations in this diff, but nothing is running yet -- no backup to take"
  fi
fi

# --ff-only, so a worktree somebody edited on the server fails loudly here rather
# than merging. Dockge edits belong in .env, which is not tracked.
git merge --ff-only "origin/$branch"

# --build, or the old image is reused and this deploys nothing at all. A build
# that fails leaves the running containers untouched, which is why it is safe on
# a timer.
docker compose up -d --build

# "Deployed" means answering, not started: a container that crash-loops is
# started over and over. The app migrates before it listens, so it gets a minute,
# and the question needs the database -- a blank app that cannot reach MariaDB
# still serves index.html. Asked from inside the container, which has bun and
# not curl, and which is the only place the port is certain to be reachable.
for _ in $(seq 1 30); do
  if docker compose exec -T app bun -e \
      'const r = await fetch("http://localhost:3001/api/categories"); process.exit(r.ok ? 0 : 1)' \
      >/dev/null 2>&1; then
    # Yesterday's image layers, which otherwise accumulate until the disk notices.
    # Only after the new image has proved itself.
    docker image prune --force >/dev/null
    log "deployed $(git rev-parse --short HEAD), answering"
    exit 0
  fi
  sleep 2
done

log "FAILED: $(git rev-parse --short HEAD) is not answering after 60s"
docker compose logs --tail 40 app
exit 1
