# One stage on purpose: the web build imports the API's own route types, so the
# build needs the whole workspace anyway, and a homelab has disk.
# ponytail: split out a slim runtime stage the day image size matters.
FROM oven/bun:1

# mysqldump, for `bun run backup` inside the container. The app itself talks to
# MySQL through Bun's driver and needs none of this.
RUN apt-get update \
 && apt-get install -y --no-install-recommends default-mysql-client \
 && rm -rf /var/lib/apt/lists/*

# Pinned so the compose mount for ~/lumpy-backups has a path it can count on:
# scripts/backup.ts writes to $HOME/lumpy-backups.
ENV HOME=/root
WORKDIR /app

COPY . .
RUN bun install --frozen-lockfile && bun run build

EXPOSE 3001
# Migrations are forward-only and recorded in _migrations, so a boot applies
# whatever this image added and is a no-op otherwise.
CMD ["sh", "-c", "bun run migrate && bun run start"]
