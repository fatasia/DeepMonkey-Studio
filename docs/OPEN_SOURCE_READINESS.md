# Open source readiness

DeepMonkey Studio is an open source foundation for Vibe World workflows across metaverse scenes, AI for Science, and world model applications.

## What is included

- Web editor and API workspace under `apps/web` and `apps/api`.
- Deep Engine browser and native runtimes under `packages/deep-engine` and `packages/deep-engine-native`.
- Windows desktop distribution through Tauri.
- Unity Bridge package and Revit conversion worker.

## Build from source

```powershell
pnpm install --frozen-lockfile
pnpm --filter @bim-studio/contracts build
pnpm --filter @bim-studio/deep-engine build
pnpm --filter @bim-studio/web build
```

Run the focused checks before publishing:

```powershell
pnpm gate:repository
pnpm audit:licenses
pnpm --filter @bim-studio/api test
pnpm --filter @bim-studio/web test
```

## Releases

Published release assets include the Windows desktop installers, Unity Bridge package, Revit plugin bundle, usage notes, and SHA256 checksums. See the [release page](https://github.com/fatasia/DeepMonkey-Studio/releases).

## Contributions and support

Read [CONTRIBUTING.md](../CONTRIBUTING.md) before opening a pull request. Security reports belong in [SECURITY.md](../SECURITY.md). Product questions belong in [SUPPORT.md](../SUPPORT.md).

## Scope

The repository contains source code, test fixtures, build scripts, and public engineering documentation. Local caches, generated test output, credentials, customer files, and private models are excluded from source control.
