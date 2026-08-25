#!/bin/sh
set -eu

Xvfb "${DISPLAY:-:99}" -screen 0 "${CLOUD_RENDER_VIRTUAL_SCREEN:-1920x1080x24}" -nolisten tcp &
exec node /workspace/apps/cloud-render-worker/dist/index.js
