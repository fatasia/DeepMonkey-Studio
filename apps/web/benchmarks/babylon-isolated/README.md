# Babylon isolated benchmark

This directory is intentionally outside the workspace dependency graph. It pins `@babylonjs/core@9.26.1` for benchmark-only experiments and must never be imported by `apps/web` production code or `@bim-studio/deep-engine`.

Run `pnpm install --ignore-workspace` from this directory. The benchmark runner must load the same GLB bytes, camera trajectory, canvas size, DPR, quality settings, warmup/sample counts, and timestamp protocol as the Deep/Three runner, then write a machine-readable report outside production source trees.

Run `pnpm run serve`, then open `http://127.0.0.1:4179/runner.html?objects=1000&warmup=30&samples=120` in a WebGPU-capable browser. The runner prints one `BABYLON_BENCHMARK_JSON` line to DevTools; save that JSON outside production trees. `asset` is explicitly `fixed-box-fixture` until the shared GLB loader is available. Query parameters `objects`, `warmup`, and `samples` are part of the protocol.
