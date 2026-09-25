#!/bin/bash
# 素材库大卷稳健上传:gh release upload 带自动重试,单卷成功才算数。
# .003 已传;本轮补 .001/.002(各 1.9GB)。
REPO="--repo fatasia/bim-studio"
LOG=/d/Documents/bim/bim-studio/test-output/glm-night-20260923/release-upload-final.log
F1="D:/Documents/bim/asset-pack/out/deepmonkey-asset-library-v1.7z.001"
F2="D:/Documents/bim/asset-pack/out/deepmonkey-asset-library-v1.7z.002"
: > "$LOG"

upload_one () {
  local file="$1" attempt=0
  until [ "$attempt" -ge 40 ]; do
    attempt=$((attempt + 1))
    echo "[$(date +%H:%M:%S)] attempt $attempt: $(basename "$file")" >> "$LOG"
    gh release upload asset-library-v1 "$file" --clobber $REPO >> "$LOG" 2>&1
    if [ $? -eq 0 ]; then
      echo "[$(date +%H:%M:%S)] OK: $(basename "$file")" >> "$LOG"
      return 0
    fi
    echo "[$(date +%H:%M:%S)] retry in 20s" >> "$LOG"
    sleep 20
  done
  echo "[$(date +%H:%M:%S)] GIVE UP: $(basename "$file")" >> "$LOG"
  return 1
}

upload_one "$F1" || exit 1
upload_one "$F2" || exit 1

echo "[$(date +%H:%M:%S)] BOTH DONE" >> "$LOG"
echo DONE >> "$LOG"
