# Deep Monkey Studio

[简体中文](README.md) · [English](README.en.md)

Deep Monkey Studio is an industrial digital-twin, simulation, and visualization platform. It combines BIM/CAD ingestion, scene authoring, industrial data connections, dashboards, automation, and native deployment tooling in a pnpm monorepo.

The project is under active development. The production Studio still uses its proven Three.js renderer. The self-developed **Deep Engine** is built and verified in isolated packages, a browser WebGPU lab, and a native Rust `wgpu` executable until its quality, performance, compatibility, lifecycle, and seamless-switching gates pass.

## Deep Engine

Deep Engine is a WebGPU-first rendering and native-client architecture with no WebGL fallback in its new runtime. Its current verified foundations include:

- versioned render packets, geometry, materials, textures, and instance updates;
- GGX PBR, HDR output, ACES mapping, IBL, PCF shadows, and MSAA;
- GPU frustum culling, atomic instance compaction, and indexed indirect draws;
- typed shader IR, DeepSL authoring, deterministic shader packages, and bounded caches;
- strict glTF/GLB parsing with explicit unsupported-feature diagnostics;
- a native Rust `winit + wgpu` renderer and an early GPU vector-painter path;
- explicit Three.js compatibility boundaries and backend-switch contracts.

These are working foundations, not a claim of engine completeness or parity with Unity, Unreal Engine, Godot, Three.js, or Babylon.js. Benchmark and capability claims require frozen, reproducible test sets.

## Repository map

| Path | Purpose |
| --- | --- |
| `apps/web` | React Studio and published viewer |
| `apps/api` | API, storage, conversion, and integration services |
| `packages/deep-engine` | Deep Engine TypeScript/WebGPU runtime, contracts, and lab |
| `packages/deep-engine-native` | Native Rust `wgpu` renderer and Deep2D executor |
| `packages/contracts` | Shared application and scene contracts |
| `tools` | Native conversion and Unity/Revit integration tools |
| `docs` | Architecture, verification evidence, and delivery plans |

## Quick start

Requirements: Node.js 24 and pnpm 11.18.0.

```bash
corepack enable
corepack prepare pnpm@11.18.0 --activate
pnpm install --frozen-lockfile
pnpm studio start web
```

To work only on Deep Engine:

```bash
pnpm --filter @bim-studio/deep-engine typecheck
pnpm --filter @bim-studio/deep-engine test
pnpm --filter @bim-studio/deep-engine build
pnpm --filter @bim-studio/deep-engine lab:build
pnpm --filter @bim-studio/deep-engine lab:serve
```

For the native executor, install Rust 1.93.0 and run:

```bash
cd packages/deep-engine-native
cargo test --locked
cargo run --locked -- --headless-contract
```

The Chinese [README.md](README.md) is maintained first and is the canonical product guide. This English README summarizes the current architecture and onboarding path. See the [Deep Engine execution plan](docs/specs/deep-engine-execution-plan-2026-09-12.md) for current boundaries and [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## License

The repository uses the custom [Deep Monkey Community Source License 1.0](LICENSE) and is source-available. Unrestricted organizations and individuals receive MIT-style permissions. Any organization engaging in Covered Misconduct is prohibited from using the project in any way, directly or through another person. Publishing source or paying a fee creates no exception.

The Chinese explanation is in [LICENSE.zh-CN.md](LICENSE.zh-CN.md) and the usage matrix is in [LICENSING.md](LICENSING.md). Third-party code, models, and sample assets retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and attribution files next to individual assets.
