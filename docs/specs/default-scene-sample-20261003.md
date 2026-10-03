# 场景画布默认本体样例（2026-10-03）

## 目标

新建场景默认不再给用户一块空白画布，而是提供一个可删除、极轻量、带示例交互的本体样例：底座 + 立柱 + 状态标识。用户仍可在创建时选择空白场景，保留原始空白路径。

## 现状核查

### 1. 全仓 grep 关键词（含未跟踪文件）

- 关键词：`sceneCreationAction`、`primitives`、`默认样例`、`sample`。
- 结果：
  - `apps/web/src/controllers/sceneCreationAction.ts` 已集中处理新建场景，`models: []` / `primitives: []` 是画布样例的最小注入点。
  - `docs/specs/handoff-remaining-tasks-20261004.md` §四 #3 明确记录：数据中心内置样例已完成，场景画布默认本体样例下一步是写注入代码。
  - `docs/specs/datacenter-builtin-sample-20261004.md` 只覆盖数据中心空态样例，不覆盖三维画布。
  - 未跟踪文件中存在上述两份交接/数据中心样例文档；本任务不改它们。

### 2. 契约层（`packages/contracts/src/`）

- 已有（不重建）：
  - `SceneSnapshot` 已包含 `models`、`primitives`、`camera`、`cameraViews`、`defaultCameraViewId`、`interactions`。
  - `PrimitiveState` 已继承 `SceneModelState`，支持 `kind`、`color`、`transform`、`material`、`effects`。
  - `SceneMaterialState` 已支持显式 PBR 参数 `roughness`、`metalness`、`emissive`、`emissiveIntensity`。
  - `SceneInteractionScriptState` 与 `SceneInteractionActionState` 已支持对象 `click` 触发和 `focus` / `message` actions。
- 真实缺口：无需新增合约；只需生成符合现有 contract 的默认 primitives 与 interactions。

### 3. 依赖

- 根工程与 `apps/web/package.json` 已使用 React、Vite、Three.js、Vitest、TypeScript、`@bim-studio/contracts`。
- 真实缺口：本任务只生成内置 JSON/TS 状态，不需要新依赖、不需要改包管理配置。

### 4. 消费方

- 已有（不重建）：
  - `scenePersistenceController.applyScene` 已按 `scene.primitives` 调 `engine.createPrimitive` + `engine.applyModelState`。
  - `viewerEngineInteraction` 已消费对象级 `focus`、`message` 等 interaction action。
  - `SceneManagerDialogs` 是当前新建场景 UI；此前只有名称输入，没有模板选择。
- 真实缺口：
  - `sceneCreationAction` 新建后不会执行完整 `applyScene`，因此默认样例除写入快照外，还要同步创建到当前引擎和交互状态。
  - 新建对话框需要提供“示例本体 / 空白场景”的保守选择，默认选示例本体。

### 5. 测试与证据

- 已有（不重建）：
  - `apps/web/src/controllers/sceneCreationAction.test.ts` 覆盖新建场景清理旧状态。
  - `packages/contracts/src/sceneValidation.test.ts` 覆盖 primitive/material/effects 合约侧字段。
  - `apps/web/src/hooks/useAppInteractionEffects.test.ts` 覆盖 message 等 interaction effect。
- 真实缺口：补 `sceneCreationAction.test.ts` 覆盖默认注入符合 contract、空白选项不注入、重复创建不叠加默认样例。

### 6. 规格文档

- `handoff-remaining-tasks-20261004.md` 明确本项为用户反馈 #3 的未完成部分。
- `datacenter-builtin-sample-20261004.md` 证明“数据中心内置样例”与“场景画布默认本体样例”是两个不同面。
- `jc-i-continuation-20261001.md` 已记录注入点、契约与 fixture 先例。

## 方案

- 新增纯函数构建默认本体样例，固定 3 个 primitives：底座、立柱、状态标识，几何极轻。
- 材质显式写入 PBR 参数：白模 roughness 0.82/metalness 0，金属 roughness 0.24/metalness 0.72。
- 新建场景默认注入样例；选择空白场景时保持 `primitives: []`、`interactions: []`。
- 默认样例对象使用“示例”前缀命名，用户可在场景树中按普通对象删除，不做强制重建。
