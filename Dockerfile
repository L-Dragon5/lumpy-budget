# One stage on purpose: the web build imports the API's own route types, so the
# build needs the whole workspace anyway, and a homelab has disk.
# ponytail: split out a slim runtime stage the day image size matters.
# Pinned to the Bun the repo is developed and tested on (`bun --version`). `:1`
# floats, and the lockfile pins dependencies but not the runtime -- a first build
# pulled 1.4.2 against a 1.3.10 laptop, and scripts/backup.ts works around two
# Bun 1.3.10 bugs by name. Bump this with the laptop, not instead of it.
FROM oven/bun:1.3.10

# mysqldump, for `bun run backup` inside the container. Debian's default-mysql-*
# is MariaDB's, the same family as the server -- a MySQL 8 client against
# MariaDB is where auth-plugin arguments start. The app itself reaches the
# database through Bun's driver and needs none of this.
#
# skip-ssl: trixie's client is MariaDB 11.8, and since 11.4 a MariaDB client
# requires TLS by default. mariadb:10.11 has none configured, so without this
# every backup fails with "SSL is required, but the server does not support it"
# -- and so does the dump deploy.sh takes before a migration, which then (rightly)
# refuses to migrate. The traffic never leaves the stack's private network, so
# there is nothing for TLS to protect. Image-only: the laptop's client is untouched.
RUN apt-get update \
 && apt-get install -y --no-install-recommends default-mysql-client \
 && rm -rf /var/lib/apt/lists/* \
 && printf '[client]\nskip-ssl\n' > /etc/mysql/mariadb.conf.d/99-lumpy-client.cnf

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
