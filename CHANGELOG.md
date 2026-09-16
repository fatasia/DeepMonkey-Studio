# Changelog

All notable changes to Deep Monkey Studio are recorded here. The format follows Keep a Changelog, and releases use Semantic Versioning.

## Unreleased

### Browser image decoding

- Add `@bim-studio/deep-engine/browser-image-decoder`, a host-injected decoder factory that keeps browser APIs outside the engine core. The Lab adapter owns bitmap/canvas access; cancellation and failed pixel reads still release the bitmap, and decoded bytes have independent ownership.

### Native text correctness and engineering gates

- Fix IME deletion redo and grapheme-boundary edits, including combining marks, emoji sequences and CRLF. Undo/redo restores text metadata and caret together; failed commits preserve composition.
- Add `TextChange.previous_end_cluster` and atomic revision-exhaustion errors. Reuse the existing locked unicode-segmentation dependency for full grapheme boundaries.
- Split Native text, chart, cache and window modules by responsibility and restore strict Clippy checks. Correct soft-wrap width accounting and legacy editor selection movement.
- Remember cancelled, timed-out, settled and failed invocation IDs in a shared bounded FIFO window, rejecting reuse before late callbacks can target a new command. Hosts must still keep invocation IDs unique after eviction.

### Deep2D chart packages

- Add a font identity and capability matrix that hashes each installed face's font data (FNV-1a, stable across machines) instead of trusting family names, models source and license status explicitly, keeps system fonts out of the artifact by default, and reports missing-versus-license-blocked families as distinct object-level reasons; also split family existence from shaping coverage because the shaper silently falls back to other installed fonts.
- Add an IME transaction session over the versioned text IR: composition never touches the committed document, commit travels the single edit path, blur cancels in-flight composition, undo and redo are per-transaction, and deletion is cluster-scoped so emoji and combining sequences are never split.
- Add the N0 behavior IR and command bus with a closed command enum, two-phase submit/settle so cancellation is real rather than compensating, idempotency keys consumed at submit, double-checked CAS, host capability gating that rejects instead of degrading, bounded in-flight and timeout budgets, and observable counters for every rejection path.

- Add `TextDocumentV1`, a versioned text IR carrying text, style spans, paragraphs and inline
  objects over grapheme-cluster indices rather than byte offsets, with half-open binary-searched
  queries, monotonic revisions, and a `TextChange` report so hosts can invalidate only the affected
  cluster range; reuse the existing cluster and line-breaking helpers instead of a second text model.
- Wire the host frame context into the Deep2D path cache: the chart epoch's resource-set and the
  real letterbox physical scale now reach `set_resource_epoch`/`set_camera_scale` from all three
  production paths (chart update, legend page change using the target page, and package swap using
  the candidate epoch). The scale is the actual physical-to-logical ratio rather than the nominal
  window DPI, and a single `effective_scale()` freezes it for path tessellation, text and image
  quads, clip sets and stroke tolerance so witness and geometry cannot disagree.
- Account for vertex-transfer outcomes with six reason categories (content reuse, incremental
  copies, missing or non-copyable previous frame, rejected plan, below copy threshold), recorded
  through a pure predicate so the decision order is locked without a GPU; the startup report now
  prints both the path-cache miss breakdown and the transfer-reason breakdown.
- Add the missing runtime emphasis channel: `ChartAction::Highlight`/`Downplay` match the
  TypeScript/ECharts `dispatchAction` shape, and initial highlight/downplay actions now travel the
  same `apply` path instead of writing emphasis state directly.
- Run a real-window keyboard smoke (`--smoke-chart-keyboard`) that reuses the production key entry
  point across tab focus, focus movement, activation, release and refocus; all six stages committed
  on an RTX 4060 Laptop/Vulkan window with clean scopes and callbacks.
- Add a byte budget and an idle window to the host data-source state machine: the byte budget evicts
  oldest entries alongside the count cap and refuses to cache a single oversized payload, while the
  idle window closes a silent connection into backoff (the synchronous transport contract has no
  observable in-flight window to time out).
- Measure the remaining allocation profiles instead of changing them: the presentation-layer clone of
  a chart display list costs 0.0149 ms versus a 2.09 ms prepare, the flat-view materialization costs
  0.366 ms, chart atlases total about 63 KB, and the forward targets (about 44 bytes per pixel) are
  the only meaningful 2D-only allocation - with `planeless`/`skip_forward_targets` predicates and a
  startup content-profile report recorded, but the frame path left unchanged.

- Add a bounded glyph raster cache wired to real text rasterization with LRU eviction, retry-on-error semantics and a resource revision counter, plus an atlas placement entry that keeps pending copy regions explicit for the GPU upload lane.
- Add chart keyboard accessibility: focus traversal onto legend items, Enter/Space activation through the same dispatch path as the mouse, zoom shortcuts sharing wheel math, escape/modality interlocks, and a semantics tree for screen readers.

- Measure path-tessellation cache residency with an instrumented allocator (payload accounting underestimates real heap by ~6%), prove full vertex duplication between the cache and the 8 MiB CPU shadow, and decompose cold-start overhead into a 0.056 ms attributable cache-write cost with the remainder at the measurement noise floor.
- Add the offline-first host data-source state machine (injected clock and transport, stale/duplicate/cross-source version rejection, bounded ring replay cache, CAS adapter onto the chart runtime) with eleven fixed-clock tests.

- Restructure chart frame memory into per-series arc chunks with a lazily materialized flat display-list view, cutting incremental-update command memory traffic from eight copies to one and preparing 13% faster on the 8x8192 fixture.
- Add vertex-transfer allocation observability and three-scenario byte-budget, old-frame protection and timing baselines; measured data (allocation is 0.1-0.2% of stage cost) rules out ring/arena allocators for now.

- Add persistent row-level emphasis for line charts: markers compose by strength (selected over emphasis over transient hover), survive zoom and same-row hover, stay suppressed while a series is hidden, migrate with row identity on window eviction and clear with scoped downplay actions.

- Add the global chart epoch: document/data/layout/resource-set revisions with a transactional candidate commit so chart content, display list and epoch land in the same presented frame, and failures keep every source stale.
- Add measured text handling for charts: a rasterizer width measure plus binary-search ellipsis fitting for legend labels (icon prefix measured) and per-line tooltip content, replacing character-count truncation.
- Add screen-x inversion and nearest-x/segment picking for cartesian charts with zoom, category/numeric/time axes and cross-series aggregation; segment hits stay series-level while vertex picks keep datum identity.
- Add a mixed-value chunked row store (categories, Chinese text, nulls) with arc-shared row blocks, whole-chunk window eviction and copy-on-write partial shrink, proven by reference-count tests.
- Wire axis tooltip pointer handling to screen-X nearest-datum aggregation with a fixed logical tolerance, preserving source-cell formatting and a bar-only hit-rectangle fallback.
- Re-run the axis-tooltip chart smoke through a real NVIDIA RTX 4060 Laptop/Vulkan window; initial/zoom/reset/tooltip/clear frames presented with clean GPU scopes and callbacks.
- Detect deleted Deep2D path command ids after successful frame preparation, expose bounded `deletions` cache diagnostics, and leave the active cache untouched when a candidate frame is rejected.

- Compile container chrome for every dashboard widget in the content pass: background fill matching the web runtime defaults (hex plus opacity), authored shape borders as inner strokes, per-object reasons and field-level deferrals, and new capability-report coverage counts. Text, charts, bindings, shadows and runtime behavior stay explicitly deferred with publicationReady=false.

- Cache pure row statistics on immutable chart row storage with automatic invalidation on any mutable access; semantic validation reuses cached column finiteness/positivity and string-budget results, cutting repeated full-chart validation from ~4.78 ms to ~0.28 ms median on the 8x8192 fixture.

- Add runtime-package v4 with versioned chart and offline replay payloads: `chart-runtime`/`chart-sim-runtime` resource kinds, envelope identity bound to the resource index, mutual exclusion of chart and deep2d entrypoints, and an optional camera from v4.
- Add `buildChartRuntimePackage` for standalone dynamic-chart packages and wire `PlayerContent::from_package` to rebuild the chart runtime, sim host and display list from a validated package; existing package CLI modes support chart packages without new commands.
- Ship TypeScript-to-native golden fixtures for chart packages (dynamic with replay fixture and static), with real-window smoke evidence for fixed-clock sim commits and interaction sequences.

### Documentation and community

- Lock the first industrial-format corpus and dependency evidence set with reproducible hashes, explicit licensing/build gaps, and profile-specific limits; no candidate is promoted to product support.
- Add offline guides for first startup, core concepts, model import, troubleshooting FAQs and contributions; expand the catalog to 25 articles across six categories.
- Document the platform architecture and correct the 3D generation API examples against the current server adapters.
- Add maintainer responsibilities, a roadmap, development and documentation guides, release notes guidance and a documentation issue form.
- Check article registration, local images, internal links, search and supported Markdown; extend the repository gate to the new governance documents.

### Session recovery

- Stop pending startup session recovery when authentication expires, so late responses cannot restore an invalidated user or schedule another retry.

### Studio rendering and publication checks

- Add a strict runtime-package selection smoke entry to verify coordinate-frame world measurements, authored-camera reset and existing local annotations through the native window handler.

- Native chart data candidates share unchanged dataset rows, isolate mutable snapshots, and move incoming window rows without changing the v1 JSON contract.

- Native Deep2d caches validated path tessellation across staged updates, invalidates on geometry/style/clip changes even without a revision bump, and bounds retained entries with LRU accounting.

- Native Deep2d stages changed path vertices with bounded CPU uploads and copies retained ranges on the GPU, preserving draw batches and the active buffer; diagnostics distinguish uploaded, copied and reused bytes.

- Native chart updates and axis zoom reuse unchanged series paths and hit indexes, retain their resource revisions, and preserve draw-order picking; full-rebuild geometry and real GPU pixel comparisons cover the incremental path.

- Add offline chart simulation with fixed-step TS/Native replay, bounded row windows, source-owned cancellation and retryable data commits; Native chart viewers can load versioned sim fixtures.

- Chart data messages now have a versioned TS/Native schema with chart ownership, revision and budget checks; a shared replay golden covers rolling-window and replacement results, including initial-action row remapping.

- Native charts accept revision-checked dataset batches and bounded append windows, remap retained row selections, and keep old data and hit geometry on failure; unchanged or hidden data can reuse the committed frame.

- Freeze selected dependencies and content-addressed resources for new client publications. Historical retries use protected version records and reject missing or changed bytes; source edits no longer change an old client package.
- Native publications now use server-compiled, window-verified candidates bound to the user and saved scene; expired, reused or cancelled requests cannot publish. Downloads reuse the verified runtime bytes.
- Native measurements use double-precision world coordinates from the package coordinate frame, and resetting the view restores the authored camera; rendering and existing annotation files retain local coordinates.
- Static scene compilation preserves a local coordinate frame in the Native camera, validates geometry precision, and restores world coordinates across origin changes. Publication errors show a summary with an expandable issue list.
- Add a Native ZIP launch command that validates the entire archive before extracting its fixed runtime payload and launching an explicitly selected player.
- Native 2D-only packages now use 64 KiB shadow depth storage instead of 64 MiB and skip 21 unused mesh/shadow pipelines; transitions into 3D rebuild and validate full resources before activation.
- Dashboard rectangle, rounded rectangle and ellipse content now lowers to native vector paths with source/compile/artifact hashes and explicit per-object gaps; incomplete components remain ineligible for publication.

- Added a TypeScript-generated standalone dashboard package golden consumed by Native tests, including atlas preparation and tampered-payload rejection; the package also passed a real Vulkan window smoke.

- Compiled dashboard paths and atlas pixels can now be packaged through a dedicated runtime builder, with a stable empty scene entry and the existing package hashes and validation.

- Native axis tooltip aggregation preserves distinct large integer category IDs instead of merging them through floating-point rounding; regression coverage now checks cross-dataset row order, hidden series and axis isolation.

- Axis tooltips now aggregate visible line, bar and scatter values sharing an X axis, cap entries deterministically, and exclude hidden or invalid logarithmic values.

- Native line-chart point selections and hover now draw token-colored markers at committed source coordinates; markers follow zoom and disappear when their series is hidden.

- Native line charts now pick source data points within eight logical pixels using a frame-owned spatial index, preserving row identity through zoom, visibility changes and dense-line decimation.

- Preserve current draft edits when withdrawing a publication, and prevent delayed withdrawal or deletion responses from changing another open scene.
- Native charts now draw selection, hover and persistent emphasis outlines from committed geometry, preserving clipping and hit targets; selected state is committed only after GPU preparation succeeds.

- Native chart legends now show real text, toggle series visibility and paginate within their reserved band; startup and GPU updates use the same presenter and hit rectangles.

- Bind scene withdrawal and deletion to the captured draft and publication; preserve newer concurrent changes and reject cloud-session operations against a different version even when timestamps match.
- Native ChartIR now renders token-styled datum tooltips inside the canvas, stages hover pixels before committing state, and shares immutable chart data across interaction candidates. The window smoke covers tooltip display and removal.

- Restore historical scene publications in one transaction, reject concurrent draft/version changes, and preserve distinct versions that share a timestamp.
- Upload rasterized Native text through the existing image atlas path. Fix atlas UV interpolation to preserve 1:1 text pixels while clamping cropped regions against neighboring texels.
- Add bounded Native text shaping and RGBA rasterization with COSMIC Text, verified against installed Chinese, Arabic and combining-character fonts.
- Package only explicitly associated scenes, pages, resources, and runtime data; remove the empty-reference project fallback, deduplicate file reads, and verify declared texture and script hashes before delivery.

- Open ChartIR in the existing Native window with pointer selection, wheel zoom and Home reset; stage GPU geometry before committing updated chart state.
- Commit Native chart state, source replacement, geometry and hit indices together; preserve the last frame on failure and route pointer hover/selection through committed data.
- Prepare chart geometry and hit testing as one immutable Native snapshot, retaining original data-row targets through filtering, visibility and zoom.
- Validate Native client archives against the existing runtime-package parser and bind their scene, compiled bytes, object mappings, source assets, and compatibility records before accepting integrity checks.

- Render heatmap cells against category, numeric and logarithmic axes; apply zoom and plot clipping while keeping the full-data color scale stable.
- Render Native Cartesian zoom windows in numeric, logarithmic and category scale space, clip affected series to the plot, and verify GPU zoom/reset output.
- Add a read-only client ZIP verifier with target checks, complete file/hash matching, duplicate-entry detection, bounded reads, and explicit failure exit codes.

- Respect both logarithmic chart axes and independently specified axis bounds in Native Cartesian geometry.
- Apply chart series visibility to Native geometry and keep resource identities stable when other series are hidden or reordered; verify hide/restore with GPU pixel readback.
- Apply Native chart legend visibility and position to plot geometry, releasing hidden legend space and rejecting canvases too small for the selected layout.
- Index every client ZIP payload with its size and SHA-256, add a content hash independent of build time, and reject colliding or unsafe archive paths before delivery.
- Compile DashboardDocument outer frames into the existing retained layout tree, preserve unconsumed component fields, and compare a real compilation fixture with Native layout output.
- Reject unresolved internal DashboardDocument viewports, interaction sources and publication entries before compilation, while preserving valid cross-page references.
- Define DashboardDocument v1 as a complete ApplicationDocument v2 compilation snapshot with an explicit entry page and unambiguous page/widget identities.
- Run Native compatibility checks before publishing. Reuse a one-time prepared package for the first delivery, reject changed content or options, and keep late results from updating a newly opened scene.
- Respect Native chart tooltip enablement, clear transient hover when a series is hidden, and reject out-of-range live chart actions before changing state.
- Keep persistent multi-target chart emphasis separate from hover, including whole-series defaults with per-datum exceptions and validated live updates.
- Initialize Native chart zoom and action state from ChartIR in order, and retain the previous state when a reset candidate fails validation.
- Add a Native ChartIR byte reader with JSON budgets and semantic checks, exposed through `--headless-chart` for validating compiled chart artifacts.
- Block formal Native package downloads when compatibility checks fail or require confirmation. Keep compiler diagnostic ZIPs behind a separate API with explicit diagnostic names and manifest metadata.
- Align Native chart validation with TS for typed series fields, stable identifiers, numeric and logarithmic axes, and heatmap data; share a negative fixture corpus across both readers.
- Preserve ChartIR legend, tooltip, zoom and initial actions in Native decoding; validate interaction references and compare all six series against a shared TypeScript compilation fixture.
- Serialize scene package recovery and builds across same-origin tabs with Web Locks; conflicting requests fail immediately, and retries read the latest persisted attempt before starting.
- Add a strict ChartIR v1 runtime reader that requires complete compiled fields and isolates nested data and interaction state from source mutations.
- Show original-version package records in both publication dialogs, with retry and cancellation controls. Prevent duplicate publication clicks and retain package records across reloads.
- Load the Native export image decoder through a dedicated entry point so compilation does not initialize the full WebGPU renderer module graph.
- Route client-package builds through an App-owned artifact runner and recovery storage: retries resolve the original published snapshot, repeated artifact requests share one attempt, and completed downloads cannot be relabeled as cancelled.
- Check compiled camera mappings as a separate Native capability; missing window evidence or inconsistent compiled/deferred fields blocks the compatibility report.
- Cancelled client-package exports no longer download ZIP files that finish generating after cancellation; late asset results are discarded before packaging.
- Ignore late editor state updates after switching or reopening a scene during publication, and keep the newly opened publication dialog intact.
- Convert scene compilation evidence into object-level compatibility reports, retaining uncompiled fields as blockers. Stopping an in-flight cloud allocation now waits for its Worker identity and shutdown acknowledgement.
- Protect cloud sessions from stale publication requests and late refreshes. Concurrent starts and stops share per-scene coordination, and registry writes run in order.
- Publish the saved scene only after its references pass checks. Publication requests carry that snapshot; conflicting saves or releases return 409, and draft metadata, the published snapshot and history commit together.
- Added a shared scene compatibility report that binds capability evidence to the source, compilation, artifact, fixture and platform. Native publication requires window-level evidence; static compilation alone cannot pass the report.
- Keep publication dialogs open when client package generation fails, while retaining the published snapshot and reporting the separate package failure.
- Keep the latest selection, camera and viewport when delayed Deep synchronization completes; stale overlays no longer force a WebGL fallback.
- Detect duplicate scene object and widget IDs in publication audits, and resolve primitive interaction targets. Added a single-scene audit entry point that uses other scenes only to resolve navigation references.

### Runtime package fixes

- Deep Native client ZIPs now contain a real v3 runtime package, compilation evidence and a hashed compatibility report. Missing runtime evidence keeps the report blocked; the conversionRequired placeholder is removed.
- Client exports preserve ordinary text and resolve signed resource URLs to local package paths while retaining credential redaction.
- Saved GLB compilation preserves alpha-masked materials under opaque model overrides. Combining an alpha mask with model transparency now reports an unsupported conversion instead of silently dropping the mask.
- Saved-scene compilation now writes the selected initial camera into runtime package v3, records a separate camera capability, and keeps uncompiled navigation semantics deferred.
- Native package opening now applies authored cameras and restores legacy defaults when switching back. Full renderer replacements verify offscreen before activating the window surface; unchanged authored cameras preserve the user's live view.
- Native now validates runtime package v3 camera resources and detects camera-only changes. Player camera application remains pending.
- Added TypeScript runtime package v3 with an indexed camera resource; WebGPU prewarm delivers camera and geometry in one commit. Native v3 loading is pending.
- Added a shared versioned scene-camera payload validator and Native view conversion, with a common TypeScript/Rust fixture. Runtime package entrypoint integration remains pending.
- Native camera projection now carries focal scale and near/far planes through rendering, selection, LOD and shadow updates, including scene replacement and resize.
- Native camera state now carries pitch through rendering, picking, LOD and shadow views. Authored camera package integration remains in progress.
- Native LOD now uses the rendered camera direction after focusing away from the world origin, and remains finite when the camera is at the origin.
- Scene compilation now emits validated runtime JSON with separate source, compilation and artifact hashes. Evidence lists scene and object semantics still awaiting runtime integration.
- Added saved-scene GLB compilation with shared geometry, embedded decoded textures, per-instance transforms and author-to-render identity mappings. Publication integration remains in progress.
- Snapshot primitive compilation now uses the editor's seven geometry types, XYZ transforms, linear colors and material opacity. Imported assets and unadapted appearance settings remain explicit conversion errors.
- Returning to the active runtime package now cancels a pending replacement. Cancelled requests report cancellation, and incomplete prewarm candidates cannot commit when an adapter throws an undefined value.

### Documentation

- Rewrote the Chinese and English READMEs around a one-paragraph pitch and a curated feature list; moved the full capability inventory to `docs/capabilities.md` and the vision-AI walkthrough to `docs/vision-quickstart.md`, and tightened the contributing, governance, and security docs.

### Added

- Keep the previous Browser environment alive until its replacement frame succeeds; restore its bindings when frame encoding or submission throws. Added GPU fault-injection coverage and a separate Native Windows IBL/drop candidate.

- Added a shared prefiltered IBL payload for Browser and Native, with bounded validation, same-device replacement and cancellation recovery. Added production GPU coverage for local spot LOD and multi-chunk frame submission; fixed spot frame-uniform ABI sizing.

- Fixed scene-tree double-clicks selecting a neighboring object when the selection toolbar appeared; model and primitive double-clicks now keep the focused object selected.

- Studio Deep now consumes author-selected LOD levels across the runtime package, renderer and residency planner. Selection changes preserve zero/multiple levels without geometry uploads; Native uses the same golden contract. Full meshlet/streaming acceptance remains pending.

- Connected the Studio author grid to Deep's HDR/depth path. Fixed transparent composition reading and writing the same HDR texture when AO is disabled; added production GPU readback and cleanup regression coverage.

- Added display-space spatial antialiasing to Deep WebGPU, with an explicit opt-out for no-AA benchmarks and GPU image/timing probes. Studio editor handles now render in a separate same-device pass; grid and remaining helper coverage are still being integrated.
- Fixed fit-selection actions ignoring primitives in Studio, published views and the standalone scene viewer.

- Studio Deep maps author Bloom strength and threshold to a separate five-level Gaussian path matching the project's Three profile; legacy preview Bloom remains available. Six fixed HDR cases pass GPU readback comparison; full Studio visual acceptance remains pending.
- GPU skinning supports an explicit original-weight mode for author adapters, including fused morph-skin inputs; existing callers retain normalized weights.
- Added GPU deformation history and PBR pose-stream pipeline variants, with fixed skin/morph/fused compute-to-draw readback tests. Studio integration remains in progress.

- Connected Studio vignette and hue/saturation/brightness/contrast to Deep's output stage, and made AO/Bloom enablement follow the author on every frame. Bloom/AO algorithm parity remains pending.
- Added native packet shadow flags and Unlit shading across batching, culling, LOD, shadow invalidation and GPU draws, with Vulkan readback coverage.
- Added MeshBasic/Unlit materials to the Deep browser packet path and connected Deep-specific frame/GPU timing to Studio diagnostics.
- Connected authored Fog/FogExp2 parameters to Deep HDR rendering and added cancellable, frame-boundary shadow-map resizing with GPU retirement.
- Added authored directional shadow camera/PCF parameters and independent object shadow flags to the Deep browser path, with exact GPU shadow allocation checks.
- Added author HDR/panorama backgrounds to the Deep Studio view, using the current decoded textures, independent sky intensity/rotation, and cancellable GPU environment replacement.
- Connected Studio ambient and hemisphere lights to Deep PBR diffuse lighting, including camera-layer filtering and the author's global shadow switch.
- Added strict no-I/O glTF data-URI texture decoding, a retry-safe glTF render-animation runtime with clip selection/loop/once/cross-fade, opt-in bounded frame telemetry, and shared local-light shadow-atlas planning plus atomic GPU resource ownership.
- Added Windows-native real-GPU lifecycle coverage for RenderPacket geometry/instance/texture/sampler/material reuse, device-epoch rebuilds, failure rollback, and Deep2D rectangle clipping.
- Added a Rust-native battery intelligence runtime with independent BatteryMFormer SPM-PINN and SPM-PINO ONNX packages, TwinMoE production routing, online digital-twin assimilation, gated transfer calibration, CLF-CBF shadow projection, and replayable evidence.
- Added eight runnable battery-analysis examples covering isolated public validation, large-capacity engineering cells, right-censored 280 Ah aging, continuous SOC, a 96-cell Pack, and an out-of-domain pulse case.
- Added editable multi-segment battery operating-condition simulation with Rust-native digital-twin initialization, SPM-PINO/TwinMoE routing, SPM conservation fallback, uncertainty, safety-projection evidence, and a primary SOC trajectory.
- Added the DMCSL-1.0 source-available license and a repository governance baseline covering contributions, security, conduct, support, releases, issue and Pull Request templates, dependency updates, and automated policy checks.
- Added a production dependency license gate with exact-version evidence for legacy packages whose npm metadata is incomplete.
- Added direct topology insertion to the 2D editor, including project-topology binding and drag-to-canvas support.

### Changed

- Refresh viewer render and post-processing pixel ratios after display-density changes, retaining adaptive scale and existing WebGPU shadow-resize protection. Visual verification remains pending.

- Kept cancellation effective between HDR preparation and frame-boundary publication, preserving the active environment when a staged replacement is cancelled.
- Kept late HDR loads from overwriting a newer environment or a disposed viewer, and added cancellable chunked conversion of author environment pixels for Deep preparation.
- Preserved MSAA in the WebGL HDR post-processing targets, replaced Deep TAA nearest-history lookup with depth-aware bilinear reconstruction, and added bounded idle-frame convergence without advancing Studio scripts or uploading the scene again.
- Aligned Deep Engine direct PBR lighting with the frozen correlated-Smith reference and removed disabled-feature render-pass work; the frozen 1024 benchmark kept SSIM at 0.949514 while reducing Deep GPU P95 from 0.531456 ms to 0.458752 ms. The competitive GPU threshold remains unmet.
- Made built-in examples a first-class battery data source so the primary SOC/SOH/RUL action remains executable without a production dataset; incompatible task/example pairs now switch to a supported analysis target.
- Expanded battery reports with measured data coverage, weakest-cell Pack aggregation, standard/PINN candidate comparison, and retained PINN physical-identification evidence even when disagreement protection keeps the standard result.
- Added optional image selection, 4:3 cropping, and model/video preview capture for project-resource thumbnails, with failure-safe saving and reload persistence. Project resources now use searchable thumbnail cards matching the public library.
- Optimized models can save and return to their source scene in one action; insertion waits for scene restoration and only consumes successful return requests.
- Added layer context-menu grouping/ungrouping and drag-out behavior, double-click timeline keyframes, selected-frame camera recording, four-decimal parameter displays, and per-segment transitions.
- Anchored 2D/3D panel toggles to workspace boundaries, spaced ViewCube actions evenly, aligned the vision sample runner with page content, and centered AI-assistant mode controls.
- Aligned the branding settings header and scrolling behavior with other secondary pages, and kept the parametric generation action bar reachable at short viewport heights.
- Unified scene object browsing, selection, grouping, and selection sets into one object manager; made the animation timeline movable and resizable; and restored the optimized-model return path.
- Reworked 2D resource categories, compact cards, template-library layout, view-cube actions, and shared workspace grid backgrounds.
- Rebuilt the scene director around explicit camera and object tracks, editable keyframes, shot/navigation workspaces, and a resizable track canvas whose controls keep a stable size.
- Moved RVT conversion options into the model-import flow, made uploaded assets wait for an authoritative ready state before optimize or insert, and kept the object tree visible while import settings are open.
- Added consistent 2D grouping shortcuts, 3D Delete handling, outside-click dismissal for overflow menus, explicit light selection, and larger project-resource and industrial-prefab thumbnails.
- Expanded Covered Misconduct restrictions to every organization and prohibited all use by a restricted organization, including internal use, evaluation, testing, and research.
- Removed the minimum weekly rest-day criterion from Covered Misconduct.
- Incorporated the ILO Declaration on Fundamental Principles and Rights at Work by its formal title, 2022 amendment, protected principles, and official source URL.
- Added unlawful collection of worker or user personal information and underpayment of bonuses or performance compensation to Covered Misconduct, while preserving the project owner's specified worker-and-user protection statement verbatim.

### Removed

- Removed the bundled Node-RED application, runtime launcher, health route, UI, proxy configuration, and dependency tree in favor of the platform's native data connectors.

## 0.1.0 - Unreleased baseline

- Initial development version. Historical work before public release is documented in repository specifications and delivery records.
