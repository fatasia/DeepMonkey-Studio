#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
root_hash="$(printf '%s' "$repository_root" | sha256sum | cut -c1-8)"
service_name="industrial-studio-${root_hash}"
unit_path="/etc/systemd/system/${service_name}.service"
node_path="$(command -v node || true)"
service_user="${BIM_STUDIO_SERVICE_USER:-$(id -un)}"
mode="deploy"
skip_build=false

for argument in "$@"; do
  case "$argument" in
    --check) mode="check" ;;
    --stop) mode="stop" ;;
    --skip-build) skip_build=true ;;
    *) echo "Unknown argument: $argument" >&2; exit 2 ;;
  esac
done

cd "$repository_root"
if [[ "$mode" == "stop" ]]; then
  sudo systemctl disable --now "$service_name" 2>/dev/null || true
  sudo rm -f "$unit_path"
  sudo systemctl daemon-reload
  echo "Native cloud service stopped: $service_name"
  exit 0
fi

[[ -n "$node_path" ]] || { echo "Node.js 24+ is required" >&2; exit 1; }
export NODE_ENV=production
pnpm --filter @bim-studio/api check:production
[[ "$mode" == "check" ]] && exit 0

if [[ "$skip_build" == false ]]; then
  pnpm install --frozen-lockfile
  pnpm build
fi

web_directory="$repository_root/apps/web/dist"
api_entry="$repository_root/apps/api/dist/index.js"
[[ -f "$web_directory/index.html" && -f "$api_entry" ]] || { echo "Production build output is incomplete" >&2; exit 1; }

temporary_unit="$(mktemp)"
trap 'rm -f "$temporary_unit"' EXIT
{
  echo "[Unit]"
  echo "Description=Industrial Studio native cloud service"
  echo "After=network-online.target postgresql.service minio.service"
  echo "Wants=network-online.target"
  echo
  echo "[Service]"
  echo "Type=simple"
  echo "User=$service_user"
  echo "WorkingDirectory=$repository_root"
  echo "Environment=NODE_ENV=production"
  echo "Environment=WEB_DIST_DIR=$web_directory"
  echo "ExecStart=$node_path $api_entry"
  echo "Restart=on-failure"
  echo "RestartSec=5"
  echo "TimeoutStopSec=30"
  echo "NoNewPrivileges=true"
  echo
  echo "[Install]"
  echo "WantedBy=multi-user.target"
} > "$temporary_unit"

sudo install -m 0644 "$temporary_unit" "$unit_path"
sudo systemctl daemon-reload
sudo systemctl enable --now "$service_name"

api_port="${API_PORT:-4100}"
health_url="http://127.0.0.1:${api_port}/api/meta"
for _ in $(seq 1 90); do
  if curl --fail --silent --show-error "$health_url" >/dev/null; then
    echo "Native cloud deployment ready: $health_url"
    exit 0
  fi
  sleep 1
done

sudo journalctl -u "$service_name" -n 80 --no-pager >&2
echo "Health check timed out" >&2
exit 1
