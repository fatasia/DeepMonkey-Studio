#!/usr/bin/env bash
# 480 分钟生产级双后端 soak 启动器(WebGL + WebGPU 顺序执行,合计 960 分钟 ≈ 16 小时)。
# 用法: bash scripts/fixtures/launch-production-soak.sh
# 输出: test-output/viewer-soak-480/{report-webgl.json,report-webgpu.json}
# 前提: pnpm --dir apps/web run build 已完成(dist 存在);静默机器(无并行 GPU/CPU 负载)。

set -euo pipefail
cd "$(dirname "$0")/../../.."

REPO_ROOT=$(pwd)
OUTPUT_BASE="$REPO_ROOT/test-output/viewer-soak-480"
MINUTES=480
SAMPLE_SECONDS=30

echo "=== 生产级 480 分钟双后端 soak 启动 ==="
echo "开始时间: $(date -Iseconds)"
echo "输出目录: $OUTPUT_BASE"

run_soak() {
  local backend=$1
  local log="$OUTPUT_BASE/soak-${backend}.log"
  echo "--- 启动 ${backend} 后端 ${MINUTES} 分钟 soak ---"
  cd "$REPO_ROOT/apps/web"

  BIM_STUDIO_SOAK_MINUTES=$MINUTES \
  BIM_STUDIO_SOAK_SAMPLE_SECONDS=$SAMPLE_SECONDS \
  BIM_STUDIO_SOAK_RENDERER=$backend \
  BIM_STUDIO_SOAK_HEAP_SAMPLING=1 \
  node scripts/gate-viewer-soak.mjs \
    > "$log" 2>&1

  local exit_code=$?
  if [ $exit_code -eq 0 ]; then
    echo "✓ ${backend} soak 通过(exit 0)"
  else
    echo "✗ ${backend} soak 失败(exit $exit_code)"
    cat "$log" | tail -10
  fi
  return $exit_code
}

echo "=== Phase 1: WebGL 后端 480 分钟 ==="
run_soak webgl
WEBGL_RESULT=$?

echo ""
echo "=== Phase 2: WebGPU 后端 480 分钟 ==="
run_soak webgpu
WEBGPU_RESULT=$?

echo ""
echo "=== 双后端 soak 完成 ==="
echo "WebGL exit: $WEBGL_RESULT"
echo "WebGPU exit: $WEBGPU_RESULT"
echo "完成时间: $(date -Iseconds)"

if [ $WEBGL_RESULT -eq 0 ] && [ $WEBGPU_RESULT -eq 0 ]; then
  echo "✓ 双后端 480 分钟生产级 soak 全部通过"
else
  echo "✗ 存在失败后端,检查上方日志"
fi
