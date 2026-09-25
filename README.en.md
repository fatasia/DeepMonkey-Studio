<p align="center">
  <img src="apps/web/public/brand/logo-transparent.png" width="128" alt="DeepMonkey Studio Logo" />
</p>

<h1 align="center">DeepMonkey Studio</h1>

<p align="center">
  Vibe World | The foundation for an AI metaverse<br />
  The worlds you create, I will preserve
</p>

[简体中文](README.md) · [English](README.en.md)

[![Deep Engine CI](docs/assets/badges/deep-engine-ci.svg)](.github/workflows/deep-engine.yml)
[![Studio web + API](docs/assets/badges/studio-ci.svg)](.github/workflows/studio.yml)
[![Repository governance](docs/assets/badges/repository-governance.svg)](.github/workflows/repository-governance.yml)
[![License: MIT with Ethical Restrictions](https://img.shields.io/badge/license-MIT%20with%20Ethical%20Restrictions-blue.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Web%20%7C%20Windows%20%7C%20Android-4c8ddc)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6)
![Rust](https://img.shields.io/badge/Rust-stable-dea584)
![React](https://img.shields.io/badge/React-19-61dafb)
![Three.js](https://img.shields.io/badge/Three.js-0.185-black)
![WebGPU](https://img.shields.io/badge/WebGPU-ready-9c5bd1)

## A note from the author

At first, I just wanted to improve the 3D editor. One thing led to another, and it became a full platform engine.

I see it as more than a digital twin and 3D workspace: it is a foundation for future metaverses, AI4S, and world models (GPT-6 and Fable 5 are already pretty impressive, after all).
The upper layer includes a 2D editor, 3D editor, script editor, and plugins;
the lower layer includes our own engine, data platform, AI platform, and large-model Harness.

Under the hood, we have made many optimizations for WebGPU, rendering, and industrial and BIM models. The modules are independent and simple enough to use separately as an SDK.

During development and testing, AI downloaded many industrial models from the internet. If any of them inadvertently infringe on someone's rights, I sincerely apologize and will remove them from the project.

The project uses the broadest possible MIT license so anyone can use it freely (technological progress depends on the support of industry experts), with an exception only for certain companies that disregard employees' human rights (see [LICENSE.zh-CN.md](LICENSE.zh-CN.md)).

[Documentation](docs/README.md) · [Contributing](CONTRIBUTING.md) · [Support](SUPPORT.md)

License designation: **MIT License + Ethical Restrictions** (source-available).

![Deep Monkey Studio platform architecture](apps/web/public/docs-assets/generated/platform-architecture-gold.png)

## Highlights

- **An industrial workspace built for AI:** Scenes, components, data, semantics, scripts, and runtime state have stable contracts. AI can understand the current project, make controlled changes, run analyses, verify results, and deliver work rather than only answer questions in chat.
- **Our own high-performance graphics engine:** Incremental scene updates, change-driven rendering, GPU-driven culling and indirect draws, LOD and streaming, instancing, resource residency, and transient reuse control CPU, GPU, and memory costs. Quality levels and reasons for fallback are observable.
- **Extensible from scripts to engine backends:** Scene/Server SDKs, versioned contracts, a plugin capability registry, the `studio.*` script API, MCP, Unity Bridge, and render backend adapters allow independent extensions without changing the entire platform.
- **Industrial authoring, data, and simulation in one place:** Create 2D dashboards, 3D scenes, device topologies, and interactions; connect field data and vision AI; and run Plant Lite, PPR Lite, robotics, virtual commissioning, and operational studies.
- **Create once, deliver across platforms:** Three WebView, Deep WebGPU, Deep Native, and Rust WASM share a publication contract. Produce Web, Windows, WASM, and Android runtime packages with capability, resource, and compatibility checks before delivery.

## Complete feature list

Grouped by product subsystem. Format targets, experimental modules, and capabilities that have a contract but no product entry point are not counted as available features.

### AI can understand and act

- Projects, applications, scenes, pages, topologies, components, datasets, semantic metrics, vision events, and publication records use versioned structural contracts and stable IDs. AI receives addressable engineering objects and relationships, not just screenshots or unstructured text.
- Context delivery is scoped to the current project, scene, selected objects, and task, while retaining provenance, versions, character budgets, and omission status. Answers and generated results can be traced back to real components, data, evidence, and diagnostics.
- Through a unified Tool Harness, AI can query data, draft dashboards and scripts, edit scenes, invoke parametric modeling, simulation, and operations capabilities, inspect screenshots, and trigger publication validation. Tools declare input and output schemas, permissions, execution location, timeouts, cancellation, and evidence.
- Write operations use the same command and transaction system, with dry runs, diff previews, user confirmation, revision-based concurrency protection, undo/redo, save and recovery, and auditing. Failures do not leave partially applied state.
- Responses, Chat Completions, MCP, and pluggable AI Providers share session and run records. The process shows reading, generation, preview, application, and verification states, with stop, retry, and reconnection recovery.

### Projects, applications, and assets

- Manage projects, applications, scenes, pages, and topologies together. Create, duplicate, rename, delete, autosave, undo/redo, recover local drafts, browse version history, and transfer between projects.
- A unified asset library manages models, images, videos, environment maps, materials, prefabs, and robot assets. Search, classify, crop thumbnails, record provenance and licensing, drag assets into scenes, and replace existing instances.
- The parametric workbench creates, validates, and saves parametric models. Industrial prefabs support instance parameters, materials, connection points, and scene-level persistence.
- The model optimizer performs polygon reduction, Draco compression, texture compression, vertex colors, and Web lightmap baking locally in the browser. Tasks can be cancelled, and results return to the project as new assets.

### Models and industrial formats

- Import RVT, IFC/IFCZIP, STEP/STP, IGES/IGS, DWG, DXF, glTF/GLB, FBX, OBJ, STL, 3MF, DAE, 3DS, OpenUSD (USD/USDA/USDC/USDZ), and URDF/robot ZIP, directly or through conversion.
- RVT has native GLB and IFC paths that preserve component hierarchy and properties. STEP/IGES uses built-in OCCT WASM; DWG uses LibreDWG to produce DXF. IFC, glTF, FBX, OpenUSD, and general meshes load through their respective viewing pipelines.
- JT and X_T provide built-in structural inspection and previews for validated subsets. Files that cannot reliably produce geometry remain in inspection or waiting state; a file header or bounding box is never presented as a complete import.
- The conversion queue supports progress, cancellation, timeouts, lease recovery, output audits, hashes, hierarchy/property/PMI sidecars, LOD derivation, and retry after failure. See [Format support](docs/converter-plugin-and-format-support.md) for detailed boundaries.

### 3D editor

- Recursive scene tree, virtualized long lists, search and filters, multi-selection, grouping, sorting, drag and drop, locking, visibility, isolation, duplication, deletion, and selection sets. Models, internal layers, BIM components, spaces, lights, markers, and primitives share consistent object operations.
- Translation, rotation, scaling, snapping, and multi-object transforms; base color, opacity, metalness, roughness, normal/AO/emissive maps, UV, double-sided and transparency modes, multiple material slots, object effects, and IES light editing.
- Find components by name, stable ID, property, floor, and category. RVT rooms/MEP Spaces, IFC components, BIM properties, floor visibility, and exploded views can be located, isolated, and operated on in batches.
- Measure distance, minimum distance between components, angles, and elevation. Use clipping boxes, axis and picked-face clipping; radial, vertical, and axial explosions; BVH collision checks; and location of engineering analysis results.
- Orbit, first-person, and third-person navigation; ground following and collision; six standard views, custom camera bookmarks, camera constraints, an orientation cube, and WebXR VR/AR.
- Model animation, camera and object timelines, keyframe recording, animation state machines, linear/smooth/curve interpolation, looping and ping-pong playback, and path display. Markers, spatial audio, and interaction state are saved with scenes.
- Fixed, dynamic, and kinematic rigid bodies; colliders, mass, friction, restitution, gravity, character control, and revolute joints. Physics state participates in saving, preview, and publication capability checks.
- Clear, overcast, rain, snow, fog, and thunderstorm weather; skyboxes, backgrounds, grids, HDR/EXR, coordinate origins, and geolocation. Directional, ambient, hemisphere, point, spot, and area lights, shadows, reflections, and probe-grid baking.
- SMAA, FXAA, SSAO, GTAO, SSR, volumetric fog, Bloom, outlines, depth of field, vignette, film grain, afterimages, and color correction. Render diagnostics, frame capture, performance settings, and backend capability status are visible.

### 2D dashboards and topology

- Multi-page freeform canvas, rulers/guides, grid snapping, zoom, marquee and multi-selection, layer tree, grouping, locking, sorting, copy/paste, alignment and distribution, undo/redo, page backgrounds, and adaptive layout based on 1920 pixels.
- Text, shapes, decoration, rolling numbers, liquid level, progress, status, gauges, line, area, bar, combo, pie, scatter, radar, funnel, Sankey, sunburst, treemap, graph, map, word cloud, box plot, waterfall, polar, ranking, tables, scrolling tables, filters, forms, images, video, live monitoring, webpages, Unity, and topology components.
- Charts support dimensions, series, metrics, aggregation, calculated fields, sorting, Top N, drill-down, linked filtering, conditional styling, and semantic metrics. Reports support detail, grouping, pivot tables, pagination, subtotals/totals, frozen columns, and XLSX export.
- A template library covers multiple industries and layouts. Sample data, component/page image export, printing, and report export are supported; preview and publication reuse the same document contract.
- The topology editor supports device nodes, links, spatial views, operating states, alert acknowledgement, and data product binding. Topologies can be embedded in dashboards or return to the original editing context.

### Data center and semantic layer

- Manage HTTP, WebSocket, MQTT, AMQP, Kafka, CoAP, PostgreSQL, MySQL, SQL Server, MongoDB, Oracle, TDengine, OPC UA, Modbus TCP, BACnet, S7, EtherNet/IP, SNMP, TCP, UDP, and serial connections natively.
- Visual data pipelines provide sources, cleaning, formulas, aggregation, field mapping, previews, debugging, retries, refresh policies, live events, and historical replay. Credentials stay on the server.
- Datasets bind directly to 2D components, 3D objects, and AI capabilities. Parametric direct binding, device signal rules, record forms, permission-controlled data writeback, and execution receipts are supported.
- Semantic models manage metrics, dimensions, parameters, filters, and versions together. Dashboards bind to confirmed metric definitions; version changes do not silently alter their meaning.

### Scripts, interactions, and automation

- The professional script editor provides syntax highlighting, completion, type checks, diagnostics, formatting, search, dependency management, and Git-backed version history and recovery.
- Scenes, models, components, prefabs, dashboard widgets, and topologies share an event system covering load, click, double-click, right-click, hover, animation, collision, and path-node events.
- Actions include visibility, color, opacity, location, animation, prefab actions, page/scene navigation, camera switching, messages, data writes, and Unity actions. Visual workflows check real targets and parameters.
- The `studio.*` host API exposes scene, data, AI, network, renderer, and editor capabilities. Script permissions, lifecycle, failure logs, and publication dependencies are auditable.

### AI and vision

- The AI assistant answers engineering/BIM/scene/selected-object questions, runs read-only SQL, generates dashboards and script drafts, and suggests scene operations. Sessions, run steps, stops, retries, evidence, and change confirmation remain traceable.
- The assistant works with real components, spaces, datasets, vision events, and the current editing context. It supports Responses and Chat Completions protocols, SSE streaming, and server-side key management.
- The vision center manages images, RTSP/RTMP/SRT/HLS video, ONNX models, recognition jobs, and events. It handles common YOLOv5/v7/v8/v10/v11 outputs and provides thresholds, NMS, labels, and letterbox coordinate restoration.
- Recognition events can bind to scene objects and trigger highlighting, camera location, status messages, and alert flows. Windows can use DirectML GPU inference, with presets for downloading built-in models and an entry point for user-supplied models.

### Industrial engineering and simulation

- The operations center includes predictive maintenance, virtual commissioning, battery intelligence, logistics, energy, What-if studies, and live monitoring. A Study retains inputs, model version, evidence, results, and a reproducibility fingerprint.
- Plant Lite provides discrete-event modeling for production lines and logistics, equipment and transport networks, shifts, changeovers, product mixes, personnel, energy consumption, quality, reliability, buffer strategies, bottleneck scans, timeline playback, and evidence export.
- PPR Lite manages products, processes, resources, operations, line balancing, quality control, and work instructions, and can pass plans to Plant Lite for validation.
- Robotics and workcells support URDF/asset packs, joint preview, kinematics, path editing, cycle-time budgets, trajectory playback, collision and load checks, workcell planning, ergonomics evidence, and result delivery.
- Virtual commissioning supports signal mapping, control phases, interlocks, fault injection, reset, test design, suite execution, and evidence reports. Logistics, workcell, commissioning, and What-if panels can open directly in a scene.
- Parametric modeling, manufacturing validation, industrial diagnostics, alert root-cause analysis, energy analysis, and battery models are invoked through one capability registry with permissions, timeouts, cancellation, auditing, and structured results.

### Deep WebGPU engine

- The TypeScript WebGPU kernel, Rust `wgpu` native executor, and Rust WASM runtime share scene packages, capability reports, and quality policies. Studio can switch supported backends without losing authoring state.
- The engine includes a render graph, PBR, glTF, geometry and textures, LOD/streaming, instancing and culling, material/Shader IR, caches, lighting and shadows, GI/probes, post-processing, picking, animation, a physics bridge, retained UI, and the Deep2D chart runtime.
- Change revisions and dirty regions drive incremental compilation and partial uploads. Instance batching, LOD, HiZ/occlusion culling, compact visibility sets, indirect draws, chunked submission, and lower idle frame rates reduce CPU submission, GPU overdraw, and main-thread work.
- GPU buffer suballocation, resource residency, transient texture pools, pipeline/Shader/text caches, resource prewarming, and on-demand streaming reduce repeat allocation and uploads. Workers and cancellable tasks handle model processing, baking, and heavy computation.
- Frame time, upload bytes, cache hits, visible objects, VRAM budget, quality level, device-loss recovery, and backend capabilities have explicit diagnostics. Performance validation covers whole-frame P95/P99, memory, and visual consistency; unsupported capabilities block publication or give a reason for fallback.
- The SDK offers subpath entries including `/app`, `/webgpu`, `/gltf`, `/geometry`, `/textures`, `/streaming`, `/shadows`, `/lighting`, `/postprocess`, `/shader*`, `/runtime-package`, `/three-bridge`, and `/host`.

### Publication, multiplatform clients, and storage

- Scenes and full applications support saving, preview, publication checks, stable snapshots, republishing, withdrawal, deletion, history restoration, and publication diffs. Asset dependencies are frozen by hash and checked for compatibility.
- Export `.scene.json`, `.bimscene` with assets, GLB, and FBX. Generate a read-only Web Scene Viewer, static site, portable ZIP, standalone Windows program, local desktop client, Android APK, Deep Native, and Rust WASM deliverables.
- The publication dialog selects render target, quality level, resource budget, and branding. Offline packages support download cancellation, integrity checks, local startup, first-run checks, and error receipts.
- Optional cloud-render sessions support creation, stopping, concurrency protection, and lifecycle auditing. Live media automatically converts RTSP/RTMP/SRT into browser-ready HLS/WebRTC.
- Metadata supports local JSON, SQLite, or PostgreSQL; assets support local files or MinIO. Migration preserves original data, with backup, restore, key rotation, service accounts, and production checks.

### Extensibility, SDKs, and AI Tool Harness

- Scene SDK, Server SDK, shared contracts, data runtime, plugin runtime, and Deep Engine can be built independently. The platform HTTP API, script API, AI tools, runtime packages, and examples use the same versioned contracts.
- The plugin registry hosts data queries, data connectors, model conversion, parametric modeling, manufacturing validation, virtual commissioning, workcell validation, and AI Providers. A new capability becomes discoverable by the UI, API, and AI when it declares input/output schemas, permissions, execution location, timeouts, cancellation, diagnostics, and version compatibility.
- `studio.*` lets scripts extend scenes, data, networking, renderers, and editors. Dependencies and Git versions follow the project; lifecycle and permissions enter publication checks.
- MCP and the editor resource bridge let AI read scene snapshots, run diagnostics, and submit transactions under control. Writes pass project permissions, revision, diff confirmation, and audit checks.
- Render backends connect through a common host and capability matrix. Data sources, converters, industrial algorithms, clients, and publication targets each follow boundary contracts and can be replaced or added without duplicating project state.
- Unity Bridge supports asset versions, scene/event/data-layer declarations, dashboard embedding, and action callbacks. Asset compatibility and publication readiness are checkable.

### Documentation center

- In-app `/docs` provides offline illustrated guides covering getting started, assets and editing, data and AI, industrial tasks, delivery and operations, SDKs, and participation in the project, with Chinese and English language switching.
- The documentation center is the single source of truth. The GitHub Wiki mirror is generated by `pnpm docs:wiki:export` rather than maintained separately.

### System administration and governance

- Administrator, editor, and viewer roles with project-level permissions. Login sessions, user management, service health, logs, error/operation audits, cache, and performance maintenance live in the system center.
- AI Providers, MCP, cloud rendering, notification channels/recipients/routes/delivery logs, and service status are configured together. Sensitive credentials are not echoed to the browser.
- Branding covers the logo, app icon, system name, browser title, copyright, theme color, default language, new-scene environment, and maintenance mode.
- Repository release gates cover dependency licenses, third-party asset provenance, source size, type checks, unit tests, builds, browser flows, publication artifacts, and recovery verification.

## Technology stack

| Layer | Main technologies |
| --- | --- |
| Web editor | TypeScript, React 19, Vite 8, Three.js, ECharts, GridStack, Monaco Editor, BVH, Rapier |
| Deep Engine | `wgpu`, `winit`, Rapier, WebAssembly |
| API and real-time data | Fastify, WebSocket, MQTT, Kafka, AMQP, OPC UA, Modbus, BACnet, S7, EtherNet/IP, SNMP, serial |
| Data and object storage | SQLite, PostgreSQL, MinIO; MySQL, SQL Server, MongoDB, Oracle, and TDengine as business data sources |
| AI and vision | MCP, ONNX Runtime, DirectML, YOLO inference, pluggable AI providers |
| Clients and delivery | Tauri 2, WebView2, Rust Native/WASM, Android, static Web Viewer, Windows NSIS/MSI |
| Engineering | pnpm workspace, TypeScript, Vitest, Node Test Runner, Cargo Test |

## Quick start

### 1. Requirements

| Usage | Required | Optional |
| --- | --- | --- |
| Windows/Linux Web editor | Git, Node.js 24+, Corepack, pnpm 11.18.0 | PostgreSQL, MinIO |
| Windows desktop client development | Web environment, stable Rust, Visual Studio C++ Build Tools, WebView2 | Windows SDK |
| Linux native deployment | 64-bit Linux, Node.js 24+, Corepack, pnpm, bash; systemd for long-running services | PostgreSQL 16+, MinIO Server/Client, reverse proxy and TLS |
| Installed Windows client | WebView2 | Server origin when connecting to a collaboration server |

The `client` development target supports Windows only. Both Windows and Linux can run `web` or `api`. Trying the editor does not require PostgreSQL, MinIO, Python, or Docker.

### 2. Clone, install, and configure

```bash
git clone https://github.com/fatasia/bim-studio.git
cd bim-studio
corepack enable
corepack prepare pnpm@11.18.0 --activate
pnpm install --frozen-lockfile
```

Copy the environment template without overwriting an existing `.env`:

```powershell
# Windows PowerShell
Copy-Item .env.example .env
```

```bash
# Linux
cp .env.example .env
```

Start with these settings:

```dotenv
API_PORT=4100
BIM_STUDIO_WEB_HOST=0.0.0.0
BIM_STUDIO_WEB_PORT=5173
WEB_ORIGIN=http://localhost:5173
METADATA_STORE=sqlite
OBJECT_STORE=local
AI_BASE_URL=https://api.openai.com/v1
AI_API_KEY=
AI_MODEL=gpt-4.1-mini
```

`.env` is the main configuration file for local and bare-metal deployments. See `.env.example` for every key and its documentation. Never commit `.env`, database passwords, MinIO secrets, AI keys, certificates, or production data.

### 3. Initialize

Prepare public samples and metadata without starting services:

```bash
pnpm run init -- --prepare-only
```

Running `pnpm run init` without `--prepare-only` starts Web mode after initialization. Initialization preserves existing data by default; do not use `--force` as a routine command.

### 4. Start and access

```bash
# Windows/Linux: API + Web editor
pnpm studio start web

# Windows: API + Web + Tauri desktop development client
pnpm studio start client

# API only, for an existing frontend or client
pnpm studio start api
```

After startup:

- Web editor: `http://localhost:5173`; devices on the same network can use `http://<host-ip>:5173`.
- Admin center: `/manager`; documentation: `/docs`; branding: `/branding`.
- API: `http://localhost:4100`; health check: `http://localhost:4100/health`.
- Windows client: `pnpm studio start client` opens a Tauri window against the same production API. An installed client can work independently with its built-in SQLite database and local object directory.
- The current development administrator username and password are both `admin`.

Remote APIs, custom ports, and HTTPS:

```bash
pnpm studio start web --api-port 4200 --web-port 5200
pnpm studio start web --api-origin http://192.168.1.20:4100
pnpm studio start web --https
```

### 5. Import an asset pack

An asset pack must include published `pack.manifest.json`, `catalog.json`, and `audit.json` files plus a per-file SHA-256 manifest. The importer validates paths, hashes, directory layout, and publication status before atomically replacing the target directory:

```bash
pnpm assets:import -- /path/to/deepmonkey-assets.zip

# Choose the asset library directory
pnpm assets:import -- /path/to/deepmonkey-assets.zip --target=/data/bim-assets
```

On Windows, use a path such as `D:\Downloads\deepmonkey-assets.zip`. Check disk space and redistribution rights before syncing optional assets from public sources:

```bash
pnpm assets:sync:open-packs
pnpm assets:verify:open
```

### 6. Database and object storage

SQLite with a local object directory is recommended for single-machine development:

```dotenv
METADATA_STORE=sqlite
SQLITE_DATABASE=./data/database.sqlite
OBJECT_STORE=local
```

Use PostgreSQL and MinIO for production:

```dotenv
METADATA_STORE=postgres
POSTGRES_HOST=127.0.0.1
POSTGRES_PORT=5432
POSTGRES_DATABASE=bim_studio
POSTGRES_USER=bim_studio
POSTGRES_PASSWORD=change-me

OBJECT_STORE=minio
MINIO_ENDPOINT=http://127.0.0.1:9000
MINIO_ACCESS_KEY=change-me
MINIO_SECRET_KEY=change-me
MINIO_BUCKET=bim-studio
```

The API creates the required tables and bucket. When storage is switched for the first time, it migrates existing local data without deleting the source files. Multi-instance production deployments must use PostgreSQL and MinIO. JSON is for temporary development only; SQLite with local objects is intended for single-machine and desktop use.

### 7. Build, package, and publish

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm verify:release
```

`pnpm build` creates production Web/API artifacts. `pnpm verify:release` runs the complete release gate. Build Windows installers on a Windows machine configured with Rust, MSVC, and WebView2:

```bash
pnpm desktop:bundle
pnpm desktop:verify-bundle
```

NSIS/MSI packages are written to `apps/desktop/src-tauri/target/release/bundle/`. Generate read-only Web Viewer, portable ZIP, Windows scene application, Deep Native, WASM, and Android APK targets from the scene publication dialog. Publication stops with an explicit error when a required signing setup, template, or runtime is missing.

For bare-metal Linux production deployment:

```bash
pnpm studio deploy --check
pnpm studio deploy
pnpm studio status
```

`deploy` manages Web and API through systemd. Remove the deployment with `pnpm studio undeploy`. See [Native development and deployment](docs/native-deployment.md) for production, backup, restore, HTTPS, and rollback procedures.

### 8. Docker

The repository does not currently ship an official `Dockerfile` or Compose deployment. Do not use an unverified ad-hoc image in production. Run the application through the bare-metal `pnpm studio` commands above. PostgreSQL and MinIO may run separately in containers as long as their addresses are reachable from the settings in `.env`. Until an official container release is available, use the native Windows/Linux deployment and release gates. As of 2026-09-25, the repository root provides a `docker-compose.yml` that delivers the PostgreSQL + MinIO infrastructure with one command (pinned images, persistent volumes, health checks; no application image), see the [Deployment guide](docs/deployment.md).

### 9. Common commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Minimal Web development startup |
| `pnpm studio start client` | Windows desktop integration development |
| `pnpm studio start web` | Windows/Linux Web + API |
| `pnpm studio start api` | API only |
| `pnpm studio stop` | Stop processes managed by the current launcher |
| `pnpm studio restart` | Restart with the previous arguments |
| `pnpm studio status` | Show processes, addresses, and health |
| `pnpm studio check` | Read-only health check; exits nonzero on failure |
| `pnpm studio help` | Show every target, option, and example |
| `pnpm gate:repository` | Check repository structure, documentation, and governance |
| `pnpm typecheck` / `pnpm test` / `pnpm build` | Type checking, tests, and production build |

### 10. Development notes

- Use the pnpm version pinned at the repository root. Do not create another lockfile with npm or Yarn; prefer `pnpm install --frozen-lockfile`.
- `pnpm run init` starts services by default; add `--prepare-only` when you only need to prepare data. If startup fails, run `pnpm studio status` and `pnpm studio check` before trying again instead of starting duplicate processes on the same ports.
- The `client` port is fixed at 5173 and currently does not accept `--https`. Use `web` mode for a custom port, remote API, or HTTPS.
- When changing shared contracts, scene formats, data migrations, or publication logic, update consumers, tests, documentation, and `CHANGELOG.md` together. Types or mock data alone do not establish a finished product capability.
- Check provenance, hashes, and redistribution terms before adding models, fonts, images, dependencies, or asset packs. Never commit customer models, production data, logs, or credentials.
- Run focused tests for affected packages before `pnpm gate:repository`. Also run the complete `pnpm verify:release` when shared contracts or the publication path change.

## Quick deploy

For single-node self-hosted storage, the root-level `docker-compose.yml` starts the PostgreSQL + MinIO infrastructure with one command (pinned images, persistent volumes, health checks); the application itself still runs bare-metal:

```bash
cp .env.example .env   # fill in POSTGRES_PASSWORD, MINIO_ROOT_*, and other credentials
docker compose up -d   # infrastructure only
pnpm run init          # seed system metadata and start Web/API
```

See the [Deployment guide](docs/deployment.md) for full steps, health checks, backup/restore, and upgrade notes.

## Documentation

- [Vision AI quick start](docs/vision-quickstart.md) · [Format support](docs/converter-plugin-and-format-support.md)
- [Native development and deployment](docs/native-deployment.md) · [Scene format](docs/scene-format.md)
- [Documentation index](docs/README.md)

Open `/docs` in the application for the offline illustrated guides. Contributors should start with the [developer guide](docs/development.md).

## Deep Engine

Deep Engine includes a TypeScript WebGPU kernel, a Rust `wgpu` native executor, and a WASM runtime. Studio retains the Three.js WebGL authoring mode and switches to Deep WebGPU according to scene capabilities; Deep Native, WASM, and Android are separate delivery targets. Code entry points: [WebGPU kernel](packages/deep-engine/README.md) and [native executor](packages/deep-engine-native/README.md).

## Contributing

Issues and pull requests are welcome. Read the [contribution guide](CONTRIBUTING.md) before submitting. Every merge must pass `pnpm gate:repository` and tests appropriate to the change. Report security vulnerabilities privately according to [SECURITY.md](SECURITY.md); do not open a public Issue.

## License

Source-available under the custom [Deep Monkey Community Source License 1.0](LICENSE), not an OSI-approved license. Unrestricted organizations and individuals receive MIT-style permissions; any organization engaging in Covered Misconduct may not use the project at all, directly or through third parties. Publishing source or paying a fee creates no exception. See [LICENSE.zh-CN.md](LICENSE.zh-CN.md) and [LICENSING.md](LICENSING.md) for details, and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for third-party components.

## Acknowledgements

Thanks to the maintainers and contributors of every project we depend on, especially [Three.js](https://github.com/mrdoob/three.js), [Orillusion](https://github.com/Orillusion/orillusion), and [Unity](https://github.com/Unity-Technologies). We have learned a great deal from them about rendering, engine architecture, and editor interaction. Thanks also to [OpenAI](https://github.com/openai) and [Zhipu GLM](https://github.com/zai-org) for providing tokens during their events.
