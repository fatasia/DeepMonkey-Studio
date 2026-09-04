# Third-party notices

This project uses open-source software. The lockfile is the authoritative inventory of exact versions. Run the following command before each release to audit production dependencies:

```powershell
corepack pnpm licenses list --prod
```

Key runtime dependencies:

| Package | Version | License | Source |
| --- | ---: | --- | --- |
| `@thatopen/fragments` | 3.4.5 | MIT | https://github.com/ThatOpen/engine_fragment |
| `web-ifc` | 0.0.77 | MPL-2.0 | https://github.com/ThatOpen/engine_web-ifc |
| `three` | 0.185.1 | MIT | https://github.com/mrdoob/three.js |
| OpenUSD official validation samples | dev snapshots recorded in tests | Tomorrow Open Source Technology License 1.0 | https://github.com/PixarAnimationStudios/OpenUSD |
| `three-mesh-bvh` | 0.9.14 | MIT | https://github.com/gkjohnson/three-mesh-bvh |
| `@gltf-transform/core/extensions/functions` | 4.4.2 | MIT | https://github.com/donmccurdy/glTF-Transform |
| `draco3dgltf` | 1.5.7 | Apache-2.0 | https://github.com/google/draco |
| `meshoptimizer` | 1.0.1 | MIT | https://github.com/zeux/meshoptimizer |
| `xz-decompress` | 0.2.3 | MIT | https://github.com/httptoolkit/xz-decompress |
| `onnxruntime-node` | 1.27.0 | MIT | https://github.com/microsoft/onnxruntime |
| YOLOX-Nano preset weights | 0.1.1rc0 | Apache-2.0 | https://github.com/Megvii-BaseDetection/YOLOX |
| SSD MobileNet V1 preset weights | ONNX opset 12 | Apache-2.0 | https://huggingface.co/onnxmodelzoo/ssd_mobilenet_v1_12 |
| MobileNet V2 preset weights | ONNX opset 12 | Apache-2.0 | https://huggingface.co/onnxmodelzoo/mobilenetv2-12 |
| Pyronear early-smoke preset weights | 1.0.0 | Apache-2.0 | https://huggingface.co/pyronear/yolo11s_sensitive-detector |
| `sharp` / platform package (transitive, Node-side optional) | 0.34.x | Apache-2.0; bundled libvips components include LGPL-3.0-or-later | https://github.com/lovell/sharp |
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
| `node-red` | 5.0.4 | Apache-2.0 | https://github.com/node-red/node-red |
| `@flowfuse/node-red-dashboard` | 1.30.2 | Apache-2.0 | https://github.com/FlowFuse/node-red-dashboard |
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
| Node-RED database and IoT nodes | see lockfile | Apache-2.0 / MIT / BSD-3-Clause / ISC | https://flows.nodered.org/ |

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
