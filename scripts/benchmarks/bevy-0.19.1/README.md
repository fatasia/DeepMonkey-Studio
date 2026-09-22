# Bevy 0.19 reference runner

This runner is the frozen Bevy side of the Native wgpu benchmark. It uses `bevy = 0.19.1`, the `3d` feature, Vulkan to match the Deep Native production adapter, a fixed release profile, and the committed `Cargo.lock`. `source-manifest.json` records the crates.io source URL, Bevy crate checksum, toolchain, features, and hashes of every runner input.

Run a short production-path capture from the repository root:

```powershell
node scripts/run-bevy-019-benchmark.mjs --smoke --offline
```

Run the reference workload with the normal sample floor:

```powershell
node scripts/run-bevy-019-benchmark.mjs --hidden
```

Run the fixed Deep-vs-Bevy paired capture (five alternating rounds, common `cubes-v2` packet, and Windows PID memory sampling):

```powershell
node scripts/run-deep-bevy-paired-benchmark.mjs --skip-build --rounds 5 --instances 256
```

Dependencies, Cargo registry/cache, and all compile products are written below `%LOCALAPPDATA%\bim-studio-benchmarks\bevy-0.19.1`. Override that external location with `BEVY_BENCHMARK_CACHE_ROOT`. The launcher refuses a cache inside the repository and does not alter the root Cargo workspace, Node dependencies, system `PATH`, or product packages.

The output is raw reference evidence. The single-run launcher does not invent input latency, 30-minute stability, GPU memory, visual similarity, alternating paired rounds, or candidate evidence; any missing field keeps the result `incomplete` and `passed: false`. The paired launcher adds measured Windows host and dedicated GPU peaks, then still fails closed until the remaining production hooks exist. Use `--require-contract-complete` when a job must fail until every required raw metric exists.
