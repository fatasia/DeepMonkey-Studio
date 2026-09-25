# Third-party notices

The default champagne alpaca brand image (`apps/web/public/brand/logo-source.png`) was generated in the user's logo design session and explicitly selected for this project on 2026-09-21. It is a project brand asset, not a third-party stock image. Its original PNG is preserved; SVG, PNG, ICO and ICNS derivatives are generated locally. Provenance and SHA-256 are recorded in `docs/specs/product-alpaca-logo-2026-09-21.md`. No new library or font dependency is introduced.

Native Windows process isolation uses `windows-sys` 0.61.2 (MIT OR Apache-2.0), copyright Microsoft Corporation, from https://github.com/microsoft/windows-rs. The existing transitive crate is also pinned directly for Job Object APIs. Retain the packaged license notices when distributing the native worker.

This project uses open-source software. The lockfile is the authoritative inventory of exact versions. Run the following command before each release to audit production dependencies, including version-pinned manual evidence for packages with incomplete metadata:

```powershell
pnpm audit:licenses
```

The reviewed overrides live in `config/third-party-license-overrides.json`. A new `Unknown` or ambiguous `BSD` result fails the audit until its exact version and license evidence are recorded.

Key runtime dependencies:

The repository-only scene-client archive verifier also uses `yauzl` 3.4.0 (MIT, copyright 2014 Josh Wolfe), pinned as a development dependency. Source: https://github.com/thejoshwolfe/yauzl. Its packaged `LICENSE` is retained by the package manager; it is not added to the browser runtime.

| Package | Version | License | Source |
| --- | ---: | --- | --- |
| `unicode-segmentation` (Native text boundaries; already present through cosmic-text, now also direct) | 1.13.3 | MIT OR Apache-2.0; packaged LICENSE-MIT, LICENSE-APACHE and COPYRIGHT retained | https://github.com/unicode-rs/unicode-segmentation |
| `@thatopen/fragments` | 3.4.5 | MIT | https://github.com/ThatOpen/engine_fragment |
| `humanize` | 0.0.9 | MIT (verified from packaged `LICENSE`) | https://github.com/taijinlee/humanize |
| `pause` | 0.0.1 | MIT (verified from packaged `Readme.md`) | npm production dependency via Passport |
| `precond` | 0.2.3 | MIT (verified from source headers and packaged `README.md`) | https://github.com/MathieuTurcotte/node-precond |
| `dequeue` | 1.0.5 | BSD-2-Clause (verified from packaged `LICENSE`) | npm production dependency via node-opcua |
| `web-ifc` | 0.0.77 | MPL-2.0 | https://github.com/ThatOpen/engine_web-ifc |
| `three` | 0.185.1 | MIT | https://github.com/mrdoob/three.js |
| OpenUSD official validation samples | dev snapshots recorded in tests | Tomorrow Open Source Technology License 1.0 | https://github.com/PixarAnimationStudios/OpenUSD |
| Khronos glTF Sample Assets: Box, BoxInterleaved, BoxTextured, AlphaBlendModeTest, NormalTangentTest, TextureEncodingTest, TextureTransformMultiTest | fixed commit `90d7ede14c7e280af263824604b427a1ca02cb66`; exact hashes in `packages/deep-engine/lab/assets/sources.json` | CC-BY-4.0 or CC0-1.0 per asset; local notices vendored | https://github.com/KhronosGroup/glTF-Sample-Assets |
| `three-mesh-bvh` | 0.9.14 | MIT | https://github.com/gkjohnson/three-mesh-bvh |
| `@gltf-transform/core/extensions/functions` | 4.4.2 | MIT | https://github.com/donmccurdy/glTF-Transform |
| `draco3dgltf` | 1.5.7 | Apache-2.0 | https://github.com/google/draco |
| `meshoptimizer` | 1.0.1 | MIT | https://github.com/zeux/meshoptimizer |
| `xz-decompress` | 0.2.3 | MIT | https://github.com/httptoolkit/xz-decompress |
| `onnxruntime-node` | 1.27.0 | MIT | https://github.com/microsoft/onnxruntime |
| `ort` / ONNX Runtime Rust binding | 2.0.0-rc.13 | MIT OR Apache-2.0 | https://github.com/pykeio/ort |
| BatteryLife v11 processed sample data (SNL, CALB, HUST) | v11 | MIT; cite BatteryLife and each original data source | https://huggingface.co/datasets/Battery-Life/BatteryLife_Processed |
| TEMPEST LIC 280 Ah aging sample data | Zenodo record 20813753 | CC BY 4.0 | https://zenodo.org/records/20813753 |
| YOLOX-Nano preset weights | 0.1.1rc0 | Apache-2.0 | https://github.com/Megvii-BaseDetection/YOLOX |
| SSD MobileNet V1 preset weights | ONNX opset 12 | Apache-2.0 | https://huggingface.co/onnxmodelzoo/ssd_mobilenet_v1_12 |
| MobileNet V2 preset weights | ONNX opset 12 | Apache-2.0 | https://huggingface.co/onnxmodelzoo/mobilenetv2-12 |
| Pyronear early-smoke preset weights | 1.0.0 | Apache-2.0 | https://huggingface.co/pyronear/yolo11s_sensitive-detector |
| `sharp` / `@img/sharp-win32-x64` platform package (transitive, Node-side optional) | 0.35.x | Apache-2.0; bundled libvips components include LGPL-3.0-or-later | https://github.com/lovell/sharp |
| @img/sharp-libvips-linux-x64 (transitive platform package) | 1.3.3 | LGPL-3.0-or-later (bundled libvips) | https://github.com/lovell/sharp |
| `dxf-parser` | 1.1.2 | MIT | https://github.com/gdsestimating/dxf-parser |
| `occt-import-js` | 0.0.23 | LGPL-2.1 | https://github.com/kovacsv/occt-import-js |
| `replicad` | 1.0.0 | MIT | https://replicad.xyz |
| `replicad-opencascadejs` | 1.0.0 | LGPL-2.1-only | https://github.com/sgenoud/replicad |
| GNU LibreDWG (`dwg2dxf`, optional external converter) | 0.14 | GPL-3.0-or-later | https://github.com/LibreDWG/libredwg |
| `@dimforge/rapier3d-compat` | 0.19.3 | Apache-2.0 | https://github.com/dimforge/rapier.js |
| `watlas` | 1.0.1 | MIT | https://github.com/repalash/watlas |
| `hls.js` | 1.6.16 | Apache-2.0 | https://github.com/video-dev/hls.js |
| MediaMTX | 1.19.3 | MIT | https://github.com/bluenviron/mediamtx |
| `jszip` | 3.10.1 | MIT OR GPL-3.0-or-later | https://github.com/Stuk/jszip |
| `react` / `react-dom` | 19.2.8 | MIT | https://github.com/facebook/react |
| `lucide-react` | 0.468.0 | ISC | https://github.com/lucide-icons/lucide |
| `esbuild` | 0.28.1 | MIT | https://github.com/evanw/esbuild |
| `es-module-lexer` | 2.3.1 | MIT | https://github.com/guybedford/es-module-lexer |
| `echarts` | 6.1.0 | Apache-2.0 | https://github.com/apache/echarts |
| `gridstack` | 13.0.2 | MIT | https://github.com/gridstack/gridstack.js |
| `@tdengine/websocket` | 3.5.0 | MIT | https://github.com/taosdata/taos-connector-node |
| `fastify` / official plugins | 5.7.4 | MIT | https://github.com/fastify/fastify |
| `mysql2` | 3.23.2 | MIT | https://github.com/sidorares/node-mysql2 |
| `oracledb` | 7.0.1 | Apache-2.0 OR UPL-1.0 | https://github.com/oracle/node-oracledb |
| `bacstack` | 0.0.1-beta.14 | MIT | https://github.com/fh1ch/node-bacstack |
| `nodes7` | 0.3.18 | MIT | https://github.com/plcpeople/nodeS7 |
| `st-ethernet-ip` | 2.7.5 | MIT | https://github.com/SerafinTech/ST-node-ethernet-ip |
| `serialport` | 13.0.0 | MIT | https://github.com/serialport/node-serialport |
| PostgreSQL server | installed local version | PostgreSQL License | https://www.postgresql.org/ |
| MinIO server | installed local version | AGPL-3.0 | https://github.com/minio/minio |

ONNX Runtime only supplies the inference engine. Every imported ONNX/YOLO weight file remains an independent artifact; verify its dataset, weight and redistribution license before packaging it with a commercial deployment.

## MPL-2.0 note

`web-ifc` is distributed under MPL-2.0. Using the unmodified package does not require the Deep Monkey Studio application as a whole to be open-sourced. If an executable distribution includes `web-ifc`, retain its copyright and license notices and tell recipients where the corresponding `web-ifc` source is available. Modifications made directly to MPL-covered files must remain available under MPL-2.0 when distributed.

This repository does not vendor BIMI/商业 BIM 平台 viewer code or source from Aedifex, Pascal Editor, Massing, or xeokit.

## Dashboard design references

The native React/ECharts dashboard templates and decorations are original Deep Monkey Studio implementations. DataV React was reviewed as an MIT-licensed visual-design reference; no DataV source code, package, or image asset is vendored or included at runtime. DataV React source and license: https://github.com/DataV-Team/DataV-React

## STEP and DWG converter notes

`occt-import-js` runs as a replaceable WASM import boundary in the API and is covered by LGPL-2.1. Retain its license and source offer when distributing the application, and publish modifications made directly to LGPL-covered files under the applicable terms.

`replicad-opencascadejs` runs only in an on-demand browser Worker for parameterized STEP generation. It remains a replaceable WASM boundary; distributions must retain the LGPL-2.1 notice and corresponding source availability. The application does not modify its covered sources.

GNU LibreDWG is an optional GPL-3.0-or-later executable invoked as a separate process to produce DXF. The installer keeps the converter outside the application bundles. Internal use does not distribute the converter; if a deployment package is delivered outside the organization, include the GPL license and corresponding source offer and have the distribution model reviewed before release.

## Proprietary conversion tools

RVT conversion through an installed Autodesk Revit instance is separate from the browser viewer. The deployment organization is responsible for valid Autodesk/Revit licenses on conversion workers. Unity Asset Transformer Toolkit (formerly Pixyz Plugin) is not a dependency of this project.

### Native font shaping and rasterization

Native uses `cosmic-text` 0.19.0 (MIT OR Apache-2.0), with only `std` and `swash` features. Upstream: https://github.com/pop-os/cosmic-text. Packaged LICENSE-MIT identifies Copyright (c) 2022 System76. Exact transitive versions/checksums are in `packages/deep-engine-native/Cargo.lock`.

The added font stack includes `fontdb` 0.23.0 and `harfrust` 0.5.2 (MIT), `swash` 0.2.10, `skrifa` 0.40.0/0.44.0, `read-fonts` 0.37.0/0.41.0 and `font-types` 0.11.3/0.12.5 (MIT OR Apache-2.0). `self_cell` 1.3.0 offers Apache-2.0 OR GPL-2.0-only; this project selects Apache-2.0. `slotmap` 1.1.1 uses Zlib, `unicode-linebreak` 0.1.5 uses Apache-2.0. Other newly resolved support crates offer MIT, Apache-2.0 or Zlib options, verified from Cargo package metadata on 2026-09-15.

Font files are loaded from the host installation; no system font binaries are bundled or redistributed. Font appearance and fallback depend on the installed font set. Reproducible delivery still requires licensed font packaging and identity/version evidence.
