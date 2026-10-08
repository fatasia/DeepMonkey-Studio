# deepmonkey-native

The Rust native runtime for **DeepMonkey**, an AI-native programmable 3D world. This crate provides the `wgpu`/`winit` scene player and engine modules; the Studio editor runs separately through `npx deepmonkey`.

[Project](https://github.com/fatasia/DeepMonkey-Studio) · [Try Studio](https://fatasia.github.io/DeepMonkey-Studio/) · [AI / SDK / MCP](https://github.com/fatasia/DeepMonkey-Studio/blob/main/docs/ai-development.md)

![Studio and engine selection](https://raw.githubusercontent.com/fatasia/DeepMonkey-Studio/main/docs/assets/engine-switch-menu.png)

- Scene/runtime packages shared with the TypeScript engine.
- PBR materials, lighting, shadows, animation and native window playback.
- Native Deep2D, physics integration and diagnostic commands.
- Open-source dependencies and local execution; see the capability matrix for backend coverage.

## Install the player

Requires Rust **1.93+** and a supported native compiler/linker. Windows builds need Visual Studio C++ Build Tools; graphical playback needs a GPU driver supported by `wgpu`.

```sh
cargo install deepmonkey-native --version 0.2.0 --locked
deepmonkey-native --help
deepmonkey-native --package /path/to/runtime-package.json
```

Export a Deep Native runtime package from Studio and keep its referenced resources alongside the package. The CLI plays that package; it does not start the Studio editor or API.

## Use the Rust library

```sh
cargo add deepmonkey-native@0.2.0
```

The library import is `deepmonkey_native`. Contracts, runtime packages and rendering modules are documented in the [native engine source](https://github.com/fatasia/DeepMonkey-Studio/tree/main/packages/deep-engine-native) and the [capability matrix](https://github.com/fatasia/DeepMonkey-Studio/blob/main/docs/engine-comparison.md).

## Start the editor

With Node.js 24+, use `npx deepmonkey`. For AI development, `npx create-deepmonkey my-world` creates a TypeScript app with eight templates and Codex / Claude Skills. [Setup guide](https://github.com/fatasia/DeepMonkey-Studio/blob/main/docs/ai-development.md).

## License

Project terms are in the included `LICENSE` and `LICENSE.zh-CN.md`; dependency notices are in `THIRD_PARTY_NOTICES.md`.
