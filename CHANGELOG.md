# Changelog

All notable changes to Deep Monkey Studio are recorded here. The format follows Keep a Changelog, and releases use Semantic Versioning.

## Unreleased

### Added

- Added a Rust-native battery intelligence runtime with independent BatteryMFormer SPM-PINN and SPM-PINO ONNX packages, TwinMoE production routing, online digital-twin assimilation, gated transfer calibration, CLF-CBF shadow projection, and replayable evidence.
- Added eight runnable battery-analysis examples covering isolated public validation, large-capacity engineering cells, right-censored 280 Ah aging, continuous SOC, a 96-cell Pack, and an out-of-domain pulse case.
- Added editable multi-segment battery operating-condition simulation with Rust-native digital-twin initialization, SPM-PINO/TwinMoE routing, SPM conservation fallback, uncertainty, safety-projection evidence, and a primary SOC trajectory.
- Added the DMCSL-1.0 source-available license and a repository governance baseline covering contributions, security, conduct, support, releases, issue and Pull Request templates, dependency updates, and automated policy checks.
- Added a production dependency license gate with exact-version evidence for legacy packages whose npm metadata is incomplete.
- Added direct topology insertion to the 2D editor, including project-topology binding and drag-to-canvas support.

### Changed

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
- Incorporated the ILO Declaration on Fundamental Principles and Rights at Work by its formal title, 2022 amendment, protected principles, and official source URL.
- Added unlawful collection of worker or user personal information and underpayment of bonuses or performance compensation to Covered Misconduct, while preserving the project owner's specified worker-and-user protection statement verbatim.

### Removed

- Removed the bundled Node-RED application, runtime launcher, health route, UI, proxy configuration, and dependency tree in favor of the platform's native data connectors.

## 0.1.0 - Unreleased baseline

- Initial development version. Historical work before public release is documented in repository specifications and delivery records.
