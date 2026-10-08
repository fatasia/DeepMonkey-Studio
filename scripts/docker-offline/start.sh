#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
archive="DeepMonkey-Studio-Docker-{{VERSION}}.tar.gz"
test -f "$archive" || { printf 'Place %s beside this script.\n' "$archive" >&2; exit 1; }
grep "  $archive\$" SHA256SUMS.txt | sha256sum --check --strict -
secret() { od -An -N24 -tx1 /dev/urandom | tr -d ' \n'; }
if test ! -f .env; then
    umask 077
    cp .env.example .env
    for name in POSTGRES_PASSWORD MINIO_ROOT_PASSWORD BIM_STUDIO_ADMIN_PASSWORD BIM_STUDIO_SESSION_SECRET; do
        value=$(secret)
        sed "s/^$name=\$/$name=$value/" .env > .env.next
        mv .env.next .env
    done
    printf 'Created local .env; administrator login is admin with BIM_STUDIO_ADMIN_PASSWORD from that file.\n'
fi
docker load --input "$archive"
docker compose -f docker-compose.yml -f docker-compose.app.yml up -d --no-build --pull never --wait --wait-timeout 180
printf 'DeepMonkey Studio is ready. Open STUDIO_PUBLIC_ORIGIN from .env.\n'
