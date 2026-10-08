# Deep2D

Standalone Rust 2D rendering for native applications, dashboards and charts. Deep2D reuses DeepMonkey's display-list, layout and GPU painter sources without depending on the 3D engine or Studio.

- Validated display lists, paths, fills, strokes, gradients, rounded corners and shadows.
- Flex layout with deterministic pixel rounding and injectable text measurement.
- Image/glyph atlases, clipping, blending and backdrop effects.
- Cached geometry and GPU resources, dynamic stencil path fills and hit testing.
- Optional `wgpu` renderer; CPU preparation and reference rasterization work without GPU dependencies.

## Install

```sh
cargo add deepmonkey-2d
```

Requires Rust 1.93+. The library import is `deepmonkey_2d`. `gpu` is enabled by default; CPU-only consumers can use `default-features = false`.

```rust
use deepmonkey_2d::{decode_display_list, prepare_display_list};

let list = decode_display_list(&std::fs::read("scene.json")?)?;
let prepared = prepare_display_list(&list)?;
```

For GPU rendering, pass your `wgpu::Device`, `Queue` and target format to `Deep2dGpuPainter::new`. Use `draw` with your command encoder and texture view, and reuse `Deep2dGpuAssetCache` across updates. The host owns its window, event loop, font shaping and atlas production; Studio's Windows media compositor is outside this crate.

## Run an example

```sh
cargo run --example offscreen -- scene.json output.ppm
```

The example renders on a hardware GPU, saves a PPM image and compares pixels against the CPU reference. Run it from the crate source or the [repository staging workflow](https://github.com/fatasia/DeepMonkey-Studio/tree/main/packages/deep2d).

Repository maintainers: `python scripts/export-deep2d-crate.py <output-directory>` stages the authoritative Native sources and records their SHA-256 provenance. Run Cargo checks against that staged manifest.

[DeepMonkey Studio](https://github.com/fatasia/DeepMonkey-Studio) · [AI / SDK / MCP](https://github.com/fatasia/DeepMonkey-Studio/blob/main/docs/ai-development.md)

See the included `LICENSE`, `LICENSE.zh-CN.md` and `THIRD_PARTY_NOTICES.md` for terms and notices.
