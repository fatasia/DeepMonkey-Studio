# Deep Monkey Studio M0 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不破坏现有 `SceneSnapshot` v1、场景 API 和三维编辑体验的前提下，建立可持久化、可迁移、可撤销且可通过能力握手访问的 `ApplicationDocument` schema v2 架构地基。

**Architecture:** 采用渐进式旁路迁移：`SceneSnapshot` 永远保持 `schemaVersion: 1`，新的 `ApplicationDocument` 是独立 v2 根文档，通过纯函数双向转换；服务器并行提供应用 CRUD/不可变发布，旧 scene 路由原样保留。浏览器仍通过现有 `api` facade 工作，但底层改为可注入 `ServerClient` 和 `BrowserHostAdapter`，`App.tsx` 只接入一个 v1 场景到 v2 应用状态的最小会话缝隙，不拆 UI、不改 `ViewerEngine`。

**Tech Stack:** TypeScript 5.9、Node.js 24+、pnpm 11、Fastify 5、React 19、Vitest 4、JSON 文件元数据存储与现有 PostgreSQL 兼容适配层。

## Global Constraints

- `SceneSnapshot` 保持 `schemaVersion: 1`；禁止把它重命名或直接升级为 v2。
- `ApplicationDocument` 使用独立的 `schemaVersion: 2`；v1 → v2 → v1 必须通过三个黄金夹具逐字段等价。
- 现有 `/api/projects/:projectId/scenes/**`、`/api/scenes/:sceneId/browse`、`/api/public/scenes/:sceneId` 以及 `/studio/:sceneId`、`/view/:sceneId`、`/published/:sceneId` 行为和响应类型保持不变。
- 新的应用发布记录不可变；重新发布必须创建新 `publicationId`，撤回只移除 active pointer，不删除历史记录。
- `/api/meta` 必须免登录；同一个 `DATA_DIR` 跨 API 重启返回相同 `serverInstanceId`，不同 `DATA_DIR` 返回不同 ID。
- `packages/studio-core` 不得依赖 React、Three.js、Tauri、DOM、HTTP 或具体存储；只接受可序列化文档、命令、选择与历史状态。
- 浏览器 JSON/SSE 业务 API 访问统一经可注入 `ServerClient`；`apps/web/src/api.ts` 继续暴露现有 facade 签名，现有调用方不批量改写。Three.js 模型/几何加载与 Draco 等静态运行时资源仍由现有 loader 直接下载，不在 M0 改写。
- 只允许对 `apps/web/src/App.tsx` 做最小接线；禁止整体重写或拆分 `App.tsx`，禁止修改 `apps/web/src/viewer/ViewerEngine.ts`。
- 不开始 M1 UI：不新增 DashboardEditor、项目级路由、二维画布、SceneViewportWidget 渲染器或三维独立编辑页。
- 不在本计划实现 IdentityProvider、外部身份映射、Tauri、Renderer Adapter、WebGPU 切换或云渲染。为满足 ThingJS 级可编程性的前置要求，M0 必须定义纯 TypeScript 的 `SceneCapabilitySDK 1.0` 命令/查询/事件/lifecycle/扩展 manifest 与兼容协商，但不把现有 `ViewerEngine` 迁入 SDK。
- 每个任务严格红—绿—重构；先运行精确测试，再运行所属 workspace 的 `test` 与 `typecheck`。
- 每个任务单独提交；不得把生成的 `dist/`、`node_modules/`、运行期 `data/` 或测试临时目录加入提交。

---

## File Map

| Path | Responsibility |
| --- | --- |
| `packages/contracts/src/application.ts` | v2 应用 schema、发布记录、`/api/meta` 协议和运行时断言；不放业务状态管理。 |
| `packages/contracts/src/applicationMigration.ts` | `SceneSnapshot` v1 与 `ApplicationDocument` v2 的确定性双向转换。 |
| `packages/contracts/src/__fixtures__/scene-v1-*.json` | 纯三维、带看板、带事件三个兼容黄金文件。 |
| `packages/contracts/src/applicationMigration.test.ts` | schema 不变、迁移确定性和逐字段 round-trip 测试。 |
| `apps/api/src/store.ts` | 应用草稿、不可变发布版本、active publication pointer 的持久化。 |
| `apps/api/src/applicationRoutes.ts` | 新应用 CRUD/发布 API；与旧 scene routes 隔离。 |
| `apps/api/src/serverMeta.ts` | 持久化服务器实例 ID 与能力元数据生成。 |
| `packages/studio-core/src/*` | 纯应用状态、命令、撤销/重做、选择及 public API。 |
| `packages/server-sdk/src/*` | 可注入 HTTP transport、认证存储 port、meta 与应用客户端。 |
| `packages/scene-sdk/src/*` | 不依赖引擎实现的公开 Scene API 协议、能力权限、生命周期和扩展兼容协商。 |
| `apps/web/src/adapters/browserHostAdapter.ts` | `localStorage`/`sessionStorage`、同源服务器 profile、401 浏览器事件。 |
| `apps/web/src/studio/legacyApplicationSession.ts` | 旧场景编辑流与 v2 `ApplicationStore` 的唯一过渡接缝。 |
| `apps/web/src/api.ts` | 保持旧 facade，对 transport 做委托。 |
| `apps/web/src/App.tsx` | 仅在打开/生成 v1 场景时同步最小 application session。 |
| `packages/studio-core/src/architecture.test.ts`、`apps/web/src/architecture.test.ts` | 依赖方向与禁止深层导入回归门禁。 |

### Task 1: ApplicationDocument v2 schema and lossless v1 migration

**Files:**
- Create: `packages/contracts/src/application.ts`
- Create: `packages/contracts/src/applicationMigration.ts`
- Create: `packages/contracts/src/applicationMigration.test.ts`
- Create: `packages/contracts/src/__fixtures__/scene-v1-pure-3d.json`
- Create: `packages/contracts/src/__fixtures__/scene-v1-dashboard.json`
- Create: `packages/contracts/src/__fixtures__/scene-v1-interaction.json`
- Modify: `packages/contracts/src/index.ts:780`

**Interfaces:**
- Consumes: existing `SceneSnapshot`, `SceneDashboardState`, `SceneInteractionScriptState`, `SceneInteractionTrigger`, `SceneInteractionActionState`, `ModelFormat` from `@bim-studio/contracts`.
- Produces: `ApplicationDocument`, `SceneDocument`, `DashboardPageDocument`, `WidgetNode`, `InteractionFlow`, `PublishedApplicationRecord`, `ApplicationPublicationPointer`, `ServerMetaResponse`, `assertApplicationDocument(value: unknown): asserts value is ApplicationDocument`, `migrateSceneSnapshotV1(snapshot: SceneSnapshot): ApplicationDocument`, and `applicationToSceneSnapshotV1(application: ApplicationDocument, sceneId?: string): SceneSnapshot`.

- [ ] **Step 1: Add three v1 golden fixtures before writing migration code**

Create `packages/contracts/src/__fixtures__/scene-v1-pure-3d.json`:

```json
{
  "schemaVersion": 1,
  "id": "scene-pure-3d",
  "projectId": "project-golden",
  "name": "纯三维",
  "camera": { "position": { "x": 5, "y": 4, "z": 3 }, "target": { "x": 0, "y": 0, "z": 0 }, "mode": "orbit" },
  "models": [],
  "primitives": [],
  "measurements": [],
  "createdAt": "2026-08-20T01:00:00.000Z",
  "updatedAt": "2026-08-20T02:00:00.000Z"
}
```

Create `packages/contracts/src/__fixtures__/scene-v1-dashboard.json`:

```json
{
  "schemaVersion": 1,
  "id": "scene-dashboard",
  "projectId": "project-golden",
  "name": "带看板",
  "camera": { "position": { "x": 8, "y": 6, "z": 8 }, "target": { "x": 0, "y": 1, "z": 0 }, "mode": "orbit" },
  "models": [],
  "primitives": [],
  "measurements": [],
  "dashboard": {
    "side": "right",
    "width": 420,
    "backgroundColor": "#10151d",
    "backgroundOpacity": 0.9,
    "blur": 8,
    "borderRadius": 12,
    "widgets": [{ "id": "temperature", "title": "温度", "key": "temperature", "type": "value", "unit": "℃", "x": 0, "y": 0, "w": 4, "h": 2, "datasetId": "dataset-1", "field": "temperature" }]
  },
  "publishedAt": "2026-08-20T03:00:00.000Z",
  "createdAt": "2026-08-20T01:00:00.000Z",
  "updatedAt": "2026-08-20T02:00:00.000Z"
}
```

Create `packages/contracts/src/__fixtures__/scene-v1-interaction.json`:

```json
{
  "schemaVersion": 1,
  "id": "scene-interaction",
  "projectId": "project-golden",
  "name": "带事件",
  "camera": { "position": { "x": 10, "y": 8, "z": 10 }, "target": { "x": 0, "y": 0, "z": 0 }, "mode": "orbit" },
  "models": [],
  "primitives": [],
  "measurements": [],
  "interactions": [{
    "id": "flow-1",
    "name": "点击聚焦",
    "target": { "kind": "object", "modelId": "pump-1", "layerId": "impeller" },
    "trigger": "click",
    "enabled": true,
    "actions": [{ "id": "action-1", "type": "focus", "enabled": true, "target": { "kind": "object", "modelId": "pump-1", "layerId": "impeller" } }],
    "code": "console.info('legacy trusted script')"
  }],
  "createdAt": "2026-08-20T01:00:00.000Z",
  "updatedAt": "2026-08-20T02:00:00.000Z"
}
```

- [ ] **Step 2: Write failing migration and schema-isolation tests**

Create `packages/contracts/src/applicationMigration.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import dashboardFixture from "./__fixtures__/scene-v1-dashboard.json";
import interactionFixture from "./__fixtures__/scene-v1-interaction.json";
import pure3dFixture from "./__fixtures__/scene-v1-pure-3d.json";
import type { SceneSnapshot } from "./index.js";
import { applicationToSceneSnapshotV1, migrateSceneSnapshotV1 } from "./applicationMigration.js";

const fixtures = [pure3dFixture, dashboardFixture, interactionFixture] as unknown as SceneSnapshot[];

describe("SceneSnapshot v1 compatibility", () => {
  it.each(fixtures.map((fixture) => [fixture.id, fixture] as const))
    ("round-trips %s through ApplicationDocument v2", (_id, snapshot) => {
      const application = migrateSceneSnapshotV1(snapshot);
      expect(application.schemaVersion).toBe(2);
      expect(applicationToSceneSnapshotV1(application)).toEqual(snapshot);
    });

  it("moves dashboard ownership to a page with a scene viewport", () => {
    const application = migrateSceneSnapshotV1(dashboardFixture as SceneSnapshot);
    expect(application.pages).toHaveLength(1);
    expect(application.pages[0]?.nodes.map((node) => node.kind)).toEqual([
      "scene-viewport",
      "legacy-dashboard-panel"
    ]);
    expect(application.scenes[0]).not.toHaveProperty("dashboard");
  });

  it("marks v1 scripts as legacy trusted without losing actions or code", () => {
    const application = migrateSceneSnapshotV1(interactionFixture as SceneSnapshot);
    expect(application.interactions[0]?.legacyScript?.runtime).toBe("legacy-trusted-main-thread");
    expect(application.interactions[0]?.legacyScript?.script).toEqual(interactionFixture.interactions?.[0]);
  });

  it("does not mutate the input snapshot", () => {
    const input = structuredClone(dashboardFixture) as SceneSnapshot;
    const before = structuredClone(input);
    migrateSceneSnapshotV1(input);
    expect(input).toEqual(before);
  });
});
```

- [ ] **Step 3: Run the focused test and verify the missing-module failure**

Run: `pnpm --filter @bim-studio/contracts test -- applicationMigration.test.ts`

Expected: FAIL because `./applicationMigration.js` does not exist.

- [ ] **Step 4: Define the v2 protocol without changing SceneSnapshot**

Create `packages/contracts/src/application.ts` with these exact public shapes:

```ts
import type {
  ModelFormat,
  SceneDashboardState,
  SceneInteractionActionState,
  SceneInteractionScriptState,
  SceneInteractionTrigger,
  SceneSnapshot
} from "./index.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type SceneDocument = Omit<SceneSnapshot,
  "schemaVersion" | "projectId" | "dashboard" | "interactions" |
  "publishedAt" | "createdAt" | "updatedAt">;

export interface ApplicationMetadata {
  id: string;
  projectId: string;
  name: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  source?: {
    kind: "scene-snapshot-v1";
    sceneId: string;
    hadInteractions: boolean;
    publishedAt?: string;
  };
}

export interface WidgetFrame { x: number; y: number; width: number; height: number; }

export interface SceneViewportWidgetNode {
  id: string;
  kind: "scene-viewport";
  frame: WidgetFrame;
  zIndex: number;
  sceneId: string;
  cameraViewId?: string;
  renderMode: "realtime" | "load-on-interaction" | "static-placeholder";
  interactionPolicy: "display-only" | "click-select" | "full-navigation";
  overlaySlot: "page";
}

export interface LegacyDashboardPanelWidgetNode {
  id: string;
  kind: "legacy-dashboard-panel";
  frame: WidgetFrame;
  zIndex: number;
  state: SceneDashboardState;
}

export type WidgetNode = SceneViewportWidgetNode | LegacyDashboardPanelWidgetNode;

export interface DashboardPageDocument {
  id: string;
  name: string;
  width: 1920;
  height: 1080;
  nodes: WidgetNode[];
}

export interface TopologyNode { id: string; kind: string; x: number; y: number; properties: Record<string, JsonValue>; }
export interface TopologyEdge { id: string; sourceNodeId: string; targetNodeId: string; properties: Record<string, JsonValue>; }
export interface TopologyDocument { id: string; name: string; nodes: TopologyNode[]; edges: TopologyEdge[]; }
export interface GeoConfiguration { providerIds: string[]; layers: Array<{ id: string; providerId: string; visible: boolean }>; }
export interface ApplicationDataDocument { connectionIds: string[]; datasetIds: string[]; transforms: Array<{ id: string; expression: string }>; variables: Array<{ id: string; value: JsonValue }>; }

export type ApplicationObjectRef =
  | { kind: "page"; id: string }
  | { kind: "widget"; id: string }
  | { kind: "scene"; id: string }
  | { kind: "object"; sceneId: string; modelId: string; layerId?: string };

export interface InteractionFlow {
  id: string;
  name: string;
  source: ApplicationObjectRef;
  trigger: SceneInteractionTrigger;
  enabled: boolean;
  actions: SceneInteractionActionState[];
  legacyScript?: {
    runtime: "legacy-trusted-main-thread";
    script: SceneInteractionScriptState;
  };
}

export interface ScriptModule { id: string; name: string; runtime: "worker-sandbox" | "legacy-trusted-main-thread"; code: string; capabilities: string[]; }
export interface AssetEntry { id: string; kind: "model" | "image" | "video" | "environment"; projectId: string; sourceName?: string; sourceFormat?: ModelFormat; contentHash?: string; }
export interface TimelineDocument { id: string; name: string; duration: number; trackIds: string[]; }
export interface PublicationProfile { id: string; name: string; target: "browser-preview" | "server-web"; entryPageId: string; renderer: "webgl2" | "auto"; }

export interface ApplicationDocument {
  schemaVersion: 2;
  metadata: ApplicationMetadata;
  pages: DashboardPageDocument[];
  topologies: TopologyDocument[];
  scenes: SceneDocument[];
  geo: GeoConfiguration;
  data: ApplicationDataDocument;
  interactions: InteractionFlow[];
  scripts: ScriptModule[];
  assets: AssetEntry[];
  timelines: TimelineDocument[];
  publicationProfiles: PublicationProfile[];
}

export interface PublishedApplicationRecord {
  id: string;
  applicationId: string;
  projectId: string;
  applicationRevision: number;
  document: ApplicationDocument;
  publishedAt: string;
}

export interface ApplicationPublicationPointer {
  applicationId: string;
  projectId: string;
  activePublicationId: string;
  updatedAt: string;
}

export interface ServerMetaResponse {
  serverInstanceId: string;
  apiVersion: "1.0";
  serverTime: string;
  capabilities: {
    applications: { schemaVersions: [2]; immutablePublications: true };
    legacyScenes: { schemaVersions: [1]; routes: true };
    authentication: { providers: ["local"] };
    hosts: { browser: true; tauri: false };
  };
}

export function assertApplicationDocument(value: unknown): asserts value is ApplicationDocument {
  if (!value || typeof value !== "object") throw new Error("应用文档必须是对象");
  const candidate = value as Partial<ApplicationDocument>;
  if (candidate.schemaVersion !== 2) throw new Error("仅支持 ApplicationDocument schemaVersion 2");
  if (!candidate.metadata || typeof candidate.metadata.id !== "string" || typeof candidate.metadata.projectId !== "string") {
    throw new Error("应用 metadata.id 和 metadata.projectId 必须是字符串");
  }
  if (!Number.isInteger(candidate.metadata.revision) || (candidate.metadata.revision ?? 0) < 1) {
    throw new Error("应用 metadata.revision 必须是大于等于 1 的整数");
  }
  for (const key of ["pages", "topologies", "scenes", "interactions", "scripts", "assets", "timelines", "publicationProfiles"] as const) {
    if (!Array.isArray(candidate[key])) throw new Error(`应用 ${key} 必须是数组`);
  }
  if (!candidate.geo || !candidate.data) throw new Error("应用 geo 和 data 不能为空");
}
```

Append this single public export to `packages/contracts/src/index.ts`:

```ts
export * from "./application.js";
export * from "./applicationMigration.js";
```

- [ ] **Step 5: Implement the deterministic two-way migration**

Create `packages/contracts/src/applicationMigration.ts`:

```ts
import type { ApplicationDocument, ApplicationObjectRef, DashboardPageDocument, InteractionFlow, SceneDocument } from "./application.js";
import type { SceneInteractionTarget, SceneSnapshot } from "./index.js";

const PAGE_WIDTH = 1920 as const;
const PAGE_HEIGHT = 1080 as const;

export function migrateSceneSnapshotV1(snapshot: SceneSnapshot): ApplicationDocument {
  const source = structuredClone(snapshot);
  const { schemaVersion: _schemaVersion, projectId, dashboard, interactions, publishedAt, createdAt, updatedAt, ...sceneFields } = source;
  const scene = sceneFields as SceneDocument;
  const pageId = `page:${source.id}`;
  const page: DashboardPageDocument = {
    id: pageId,
    name: `${source.name} 看板`,
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
    nodes: [{
      id: `widget:scene:${source.id}`,
      kind: "scene-viewport",
      frame: { x: 0, y: 0, width: PAGE_WIDTH, height: PAGE_HEIGHT },
      zIndex: 0,
      sceneId: source.id,
      ...(source.defaultCameraViewId ? { cameraViewId: source.defaultCameraViewId } : {}),
      renderMode: "realtime",
      interactionPolicy: "full-navigation",
      overlaySlot: "page"
    }]
  };
  if (dashboard) {
    page.nodes.push({
      id: `widget:legacy-dashboard:${source.id}`,
      kind: "legacy-dashboard-panel",
      frame: {
        x: dashboard.side === "left" ? 0 : PAGE_WIDTH - dashboard.width,
        y: 0,
        width: dashboard.width,
        height: PAGE_HEIGHT
      },
      zIndex: 1,
      state: dashboard
    });
  }
  const migratedInteractions: InteractionFlow[] = (interactions ?? []).map((script) => ({
    id: script.id,
    name: script.name,
    source: interactionTargetToRef(source.id, script.target),
    trigger: script.trigger,
    enabled: script.enabled,
    actions: structuredClone(script.actions ?? []),
    legacyScript: { runtime: "legacy-trusted-main-thread", script: structuredClone(script) }
  }));
  const modelAssets = new Map(source.models.map((model) => [model.modelId, model]));
  return {
    schemaVersion: 2,
    metadata: {
      id: source.id,
      projectId,
      name: source.name,
      revision: 1,
      createdAt,
      updatedAt,
      source: {
        kind: "scene-snapshot-v1",
        sceneId: source.id,
        hadInteractions: interactions !== undefined,
        ...(publishedAt ? { publishedAt } : {})
      }
    },
    pages: [page],
    topologies: [],
    scenes: [scene],
    geo: { providerIds: [], layers: [] },
    data: { connectionIds: [], datasetIds: [], transforms: [], variables: [] },
    interactions: migratedInteractions,
    scripts: migratedInteractions.map((flow) => ({
      id: `script:${flow.id}`,
      name: flow.name,
      runtime: "legacy-trusted-main-thread",
      code: flow.legacyScript?.script.code ?? "",
      capabilities: ["legacy.viewer", "legacy.three", "legacy.browser"]
    })),
    assets: [...modelAssets.values()].map((model) => ({
      id: model.modelId,
      kind: "model",
      projectId,
      ...(model.sourceName ? { sourceName: model.sourceName } : {}),
      ...(model.sourceFormat ? { sourceFormat: model.sourceFormat } : {})
    })),
    timelines: [],
    publicationProfiles: [
      { id: "browser-preview", name: "浏览器预览", target: "browser-preview", entryPageId: pageId, renderer: "webgl2" },
      { id: "server-web", name: "服务器 Web", target: "server-web", entryPageId: pageId, renderer: "webgl2" }
    ]
  };
}

export function applicationToSceneSnapshotV1(application: ApplicationDocument, sceneId = application.metadata.source?.sceneId ?? application.scenes[0]?.id): SceneSnapshot {
  if (!sceneId) throw new Error("应用没有可导出的三维场景");
  const scene = application.scenes.find((item) => item.id === sceneId);
  if (!scene) throw new Error(`应用中不存在场景 ${sceneId}`);
  const page = application.pages.find((item) => item.nodes.some((node) => node.kind === "scene-viewport" && node.sceneId === sceneId));
  const dashboard = page?.nodes.find((node) => node.kind === "legacy-dashboard-panel")?.state;
  const legacyInteractions = application.interactions
    .filter((flow) => flow.legacyScript?.script)
    .map((flow) => structuredClone(flow.legacyScript!.script));
  return {
    schemaVersion: 1,
    ...structuredClone(scene),
    projectId: application.metadata.projectId,
    ...(dashboard ? { dashboard: structuredClone(dashboard) } : {}),
    ...(application.metadata.source?.hadInteractions ? { interactions: legacyInteractions } : {}),
    ...(application.metadata.source?.publishedAt ? { publishedAt: application.metadata.source.publishedAt } : {}),
    createdAt: application.metadata.createdAt,
    updatedAt: application.metadata.updatedAt
  };
}

function interactionTargetToRef(sceneId: string, target: SceneInteractionTarget): ApplicationObjectRef {
  return target.kind === "widget"
    ? { kind: "widget", id: target.widgetId }
    : { kind: "object", sceneId, modelId: target.modelId, ...(target.layerId ? { layerId: target.layerId } : {}) };
}
```

- [ ] **Step 6: Run focused and package checks**

Run: `pnpm --filter @bim-studio/contracts test -- applicationMigration.test.ts`

Expected: PASS with 6 tests: three parameterized round trips plus dashboard ownership, trusted-script marking, and input immutability.

Run: `pnpm --filter @bim-studio/contracts typecheck`

Expected: exit 0 with no TypeScript diagnostics; in particular `SceneSnapshot["schemaVersion"]` remains the literal type `1`.

- [ ] **Step 7: Commit the schema boundary**

```bash
git add packages/contracts/src/application.ts packages/contracts/src/applicationMigration.ts packages/contracts/src/applicationMigration.test.ts packages/contracts/src/__fixtures__ packages/contracts/src/index.ts
git commit -m "feat(contracts): add application schema v2 migration"
```

### Task 2: Application CRUD, persistent drafts, and immutable publications

**Files:**
- Modify: `packages/contracts/src/index.ts:764-772`
- Modify: `apps/api/src/store.ts:1-60,62-84,334-390,598-613`
- Create: `apps/api/src/applicationRoutes.ts`
- Create: `apps/api/src/applicationRoutes.test.ts`
- Create: `apps/api/src/routes.test.ts`
- Modify: `apps/api/src/index.ts:4-32`

**Interfaces:**
- Consumes: Task 1 `ApplicationDocument`, `PublishedApplicationRecord`, `ApplicationPublicationPointer`, and `assertApplicationDocument`.
- Produces on `MetadataStore`: `listApplications(projectId: string): ApplicationDocument[]`, `getApplication(projectId: string, applicationId: string): ApplicationDocument | undefined`, `saveApplication(application: ApplicationDocument): Promise<ApplicationDocument>`, `removeApplication(projectId: string, applicationId: string): Promise<boolean>`, `getPublishedApplication(publicationId: string): PublishedApplicationRecord | undefined`, `listApplicationPublications(applicationId: string): PublishedApplicationRecord[]`, `savePublishedApplication(record: PublishedApplicationRecord): Promise<PublishedApplicationRecord>`, `getApplicationPublicationPointer(applicationId: string): ApplicationPublicationPointer | undefined`, `saveApplicationPublicationPointer(pointer: ApplicationPublicationPointer): Promise<ApplicationPublicationPointer>`, `removeApplicationPublicationPointer(applicationId: string): Promise<boolean>`.
- Produces HTTP: application CRUD under `/api/projects/:projectId/applications`, publish/unpublish under `/api/projects/:projectId/applications/:applicationId/publish`, active public lookup at `/api/public/applications/:applicationId`, immutable revision lookup at `/api/public/applications/:applicationId/revisions/:publicationId`.

- [ ] **Step 1: Write failing route tests for create/update conflict and immutable publish**

Create `apps/api/src/applicationRoutes.test.ts` using a real temporary `JsonStore` and bare Fastify instance. The test setup must register only `registerApplicationRoutes`, so authentication is not part of this unit:

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import pureFixture from "../../../packages/contracts/src/__fixtures__/scene-v1-pure-3d.json";
import { migrateSceneSnapshotV1, type SceneSnapshot } from "@bim-studio/contracts";
import { registerApplicationRoutes } from "./applicationRoutes.js";
import { JsonStore } from "./store.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((item) => rm(item, { recursive: true, force: true }))));

async function harness() {
  const directory = await mkdtemp(path.join(tmpdir(), "bim-app-routes-"));
  directories.push(directory);
  const store = new JsonStore(directory);
  await store.init();
  const app = Fastify();
  await registerApplicationRoutes(app, store);
  return { app, store };
}

describe("application routes", () => {
  it("creates, reads, revisions, and deletes an application", async () => {
    const { app } = await harness();
    const document = migrateSceneSnapshotV1(pureFixture as unknown as SceneSnapshot);
    document.metadata.projectId = "default";
    expect((await app.inject({ method: "POST", url: "/api/projects/default/applications", payload: document })).statusCode).toBe(201);
    const loaded = await app.inject({ method: "GET", url: `/api/projects/default/applications/${document.metadata.id}` });
    expect(loaded.json().metadata.revision).toBe(1);
    document.metadata.name = "并发修改";
    const updated = await app.inject({ method: "PUT", url: `/api/projects/default/applications/${document.metadata.id}`, payload: document });
    expect(updated.json().metadata.revision).toBe(2);
    const stale = await app.inject({ method: "PUT", url: `/api/projects/default/applications/${document.metadata.id}`, payload: document });
    expect(stale.statusCode).toBe(409);
    expect((await app.inject({ method: "DELETE", url: `/api/projects/default/applications/${document.metadata.id}` })).statusCode).toBe(204);
    await app.close();
  });

  it("creates immutable publication records and only moves the active pointer", async () => {
    const { app, store } = await harness();
    const document = migrateSceneSnapshotV1(pureFixture as unknown as SceneSnapshot);
    document.metadata.projectId = "default";
    await app.inject({ method: "POST", url: "/api/projects/default/applications", payload: document });
    const first = await app.inject({ method: "POST", url: `/api/projects/default/applications/${document.metadata.id}/publish` });
    document.metadata.name = "第二版";
    const saved = await app.inject({ method: "PUT", url: `/api/projects/default/applications/${document.metadata.id}`, payload: document });
    const second = await app.inject({ method: "POST", url: `/api/projects/default/applications/${document.metadata.id}/publish` });
    expect(first.json().id).not.toBe(second.json().id);
    expect(store.getPublishedApplication(first.json().id)?.document.metadata.name).toBe("纯三维");
    expect(saved.json().metadata.revision).toBe(2);
    expect((await app.inject({ method: "GET", url: `/api/public/applications/${document.metadata.id}` })).json().id).toBe(second.json().id);
    expect((await app.inject({ method: "DELETE", url: `/api/projects/default/applications/${document.metadata.id}/publish` })).statusCode).toBe(204);
    expect(store.getPublishedApplication(first.json().id)).toBeDefined();
    expect(store.getPublishedApplication(second.json().id)).toBeDefined();
    expect((await app.inject({ method: "GET", url: `/api/public/applications/${document.metadata.id}` })).statusCode).toBe(404);
    await app.close();
  });
});
```

- [ ] **Step 2: Run the focused route test and verify it fails**

Run: `pnpm --filter @bim-studio/api test -- applicationRoutes.test.ts`

Expected: FAIL because `applicationRoutes.ts` and the application store methods do not exist.

- [ ] **Step 3: Extend the persisted database document and store contract**

Import `ApplicationDocument`, `PublishedApplicationRecord`, and `ApplicationPublicationPointer` from `./application.js` at the top of `packages/contracts/src/index.ts`, then add these optional fields to `DatabaseDocument`; optional fields allow existing `database.json` files to load unchanged:

```ts
applications?: ApplicationDocument[];
publishedApplications?: PublishedApplicationRecord[];
applicationPublicationPointers?: ApplicationPublicationPointer[];
```

Import the three Task 1 types in `apps/api/src/store.ts`, add all interfaces listed in this task's **Produces on `MetadataStore`** block, initialize the arrays in `JsonStore.init()`, and add the following implementations next to scene persistence:

```ts
listApplications(projectId: string): ApplicationDocument[] {
  return structuredClone((this.document.applications ?? [])
    .filter((item) => item.metadata.projectId === projectId)
    .sort((left, right) => Date.parse(right.metadata.updatedAt) - Date.parse(left.metadata.updatedAt)));
}

getApplication(projectId: string, applicationId: string): ApplicationDocument | undefined {
  const item = (this.document.applications ?? []).find((candidate) =>
    candidate.metadata.projectId === projectId && candidate.metadata.id === applicationId);
  return item ? structuredClone(item) : undefined;
}

async saveApplication(application: ApplicationDocument): Promise<ApplicationDocument> {
  this.document.applications ??= [];
  const index = this.document.applications.findIndex((item) =>
    item.metadata.projectId === application.metadata.projectId && item.metadata.id === application.metadata.id);
  if (index >= 0) this.document.applications[index] = structuredClone(application);
  else this.document.applications.push(structuredClone(application));
  await this.persist();
  return structuredClone(application);
}

async removeApplication(projectId: string, applicationId: string): Promise<boolean> {
  const items = this.document.applications ?? [];
  const next = items.filter((item) => item.metadata.projectId !== projectId || item.metadata.id !== applicationId);
  if (next.length === items.length) return false;
  this.document.applications = next;
  await this.persist();
  return true;
}

getPublishedApplication(publicationId: string): PublishedApplicationRecord | undefined {
  const item = (this.document.publishedApplications ?? []).find((candidate) => candidate.id === publicationId);
  return item ? structuredClone(item) : undefined;
}

listApplicationPublications(applicationId: string): PublishedApplicationRecord[] {
  return structuredClone((this.document.publishedApplications ?? []).filter((item) => item.applicationId === applicationId));
}

async savePublishedApplication(record: PublishedApplicationRecord): Promise<PublishedApplicationRecord> {
  this.document.publishedApplications ??= [];
  if (this.document.publishedApplications.some((item) => item.id === record.id)) throw new Error(`发布版本 ${record.id} 已存在`);
  this.document.publishedApplications.push(structuredClone(record));
  await this.persist();
  return structuredClone(record);
}

getApplicationPublicationPointer(applicationId: string): ApplicationPublicationPointer | undefined {
  const item = (this.document.applicationPublicationPointers ?? []).find((candidate) => candidate.applicationId === applicationId);
  return item ? structuredClone(item) : undefined;
}

async saveApplicationPublicationPointer(pointer: ApplicationPublicationPointer): Promise<ApplicationPublicationPointer> {
  this.document.applicationPublicationPointers ??= [];
  const index = this.document.applicationPublicationPointers.findIndex((item) => item.applicationId === pointer.applicationId);
  if (index >= 0) this.document.applicationPublicationPointers[index] = structuredClone(pointer);
  else this.document.applicationPublicationPointers.push(structuredClone(pointer));
  await this.persist();
  return structuredClone(pointer);
}

async removeApplicationPublicationPointer(applicationId: string): Promise<boolean> {
  const pointers = this.document.applicationPublicationPointers ?? [];
  const next = pointers.filter((item) => item.applicationId !== applicationId);
  if (next.length === pointers.length) return false;
  this.document.applicationPublicationPointers = next;
  await this.persist();
  return true;
}
```

Initialize all three arrays in both `init()` and `defaultDocument()`. Do not alter `scenes` or `publishedScenes` cleanup semantics.

- [ ] **Step 4: Implement isolated application routes with server-owned revision fields**

Create `apps/api/src/applicationRoutes.ts`. Use `assertApplicationDocument` on POST/PUT; first reject an unknown `projectId` with 404 `{ message: "项目不存在" }`; force path-owned `projectId`/`applicationId`; POST sets revision `1`; PUT requires the body revision to equal the current revision and then increments it; 409 response body is `{ message: "应用已被其他修改更新", currentRevision: number }`. Publish with `randomUUID()`, `structuredClone(current)`, and a fresh ISO timestamp. The route table must be exactly:

```ts
GET    /api/projects/:projectId/applications
POST   /api/projects/:projectId/applications
GET    /api/projects/:projectId/applications/:applicationId
PUT    /api/projects/:projectId/applications/:applicationId
DELETE /api/projects/:projectId/applications/:applicationId
POST   /api/projects/:projectId/applications/:applicationId/publish
DELETE /api/projects/:projectId/applications/:applicationId/publish
GET    /api/public/applications/:applicationId
GET    /api/public/applications/:applicationId/revisions/:publicationId
```

Deletion must return 409 `{ message: "请先撤回应用发布版本" }` while an active pointer exists. Public revision lookup must verify both `record.applicationId === :applicationId` and `record.id === :publicationId`; otherwise return 404. Never update or delete `publishedApplications` after insertion.

Register the module in `apps/api/src/index.ts` immediately after `registerRoutes`:

```ts
await registerRoutes(app, { store, queue, objects, dataDir: config.dataDir, config });
await registerApplicationRoutes(app, store);
```

- [ ] **Step 5: Run new application tests and make them green**

Run: `pnpm --filter @bim-studio/api test -- applicationRoutes.test.ts`

Expected: PASS with 2 tests, including two different publication IDs and retained historical records after unpublish.

- [ ] **Step 6: Add an explicit regression test for unchanged legacy scene routes**

Create `apps/api/src/routes.test.ts` with a temporary `JsonStore`, a bare Fastify app, and `registerRoutes(app, { store, queue: undefined as never, objects: undefined as never, dataDir, config: loadConfig() })`. Rewrite the fixture's `projectId` to `default`, PUT it to `/api/projects/default/scenes/scene-pure-3d`, publish it through `/api/projects/default/scenes/scene-pure-3d/publish`, and assert:

```ts
expect(save.statusCode).toBe(200);
expect(save.json().schemaVersion).toBe(1);
expect(publication.statusCode).toBe(201);
expect(publication.json().snapshot.schemaVersion).toBe(1);
expect((await app.inject({ method: "GET", url: "/api/public/scenes/scene-pure-3d" })).json().snapshot.name).toBe("纯三维");
expect((await app.inject({ method: "GET", url: "/api/scenes/scene-pure-3d/browse" })).json().scene.schemaVersion).toBe(1);
```

Use the store's existing `default` project; do not create test-only project setup.

- [ ] **Step 7: Run API package checks**

Run: `pnpm --filter @bim-studio/api test -- applicationRoutes.test.ts routes.test.ts store.test.ts`

Expected: PASS; legacy publication remains a `PublishedSceneRecord`, new application publications remain immutable records plus a mutable pointer.

Run: `pnpm --filter @bim-studio/api typecheck`

Expected: exit 0 with no TypeScript diagnostics.

- [ ] **Step 8: Commit persistence and routes**

```bash
git add packages/contracts/src/index.ts apps/api/src/store.ts apps/api/src/applicationRoutes.ts apps/api/src/applicationRoutes.test.ts apps/api/src/routes.test.ts apps/api/src/index.ts
git commit -m "feat(api): persist and publish application documents"
```

### Task 3: Public capability handshake and stable serverInstanceId

**Files:**
- Create: `apps/api/src/serverMeta.ts`
- Create: `apps/api/src/serverMeta.test.ts`
- Modify: `apps/api/src/index.ts:13-32`
- Modify: `apps/api/src/system.ts:24-27`

**Interfaces:**
- Consumes: Task 1 `ServerMetaResponse`.
- Produces: `loadOrCreateServerInstanceId(dataDir: string): Promise<string>`, `createServerMeta(serverInstanceId: string, now?: () => Date): ServerMetaResponse`, and unauthenticated `GET /api/meta`.

- [ ] **Step 1: Write failing persistence and route tests**

Create `apps/api/src/serverMeta.test.ts`:

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createServerMeta, loadOrCreateServerInstanceId, registerServerMetaRoute } from "./serverMeta.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((item) => rm(item, { recursive: true, force: true }))));

describe("server metadata", () => {
  it("keeps one serverInstanceId for one data directory", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "bim-meta-"));
    directories.push(directory);
    expect(await loadOrCreateServerInstanceId(directory)).toBe(await loadOrCreateServerInstanceId(directory));
  });

  it("uses different serverInstanceIds for different data directories", async () => {
    const first = await mkdtemp(path.join(tmpdir(), "bim-meta-first-"));
    const second = await mkdtemp(path.join(tmpdir(), "bim-meta-second-"));
    directories.push(first, second);
    expect(await loadOrCreateServerInstanceId(first)).not.toBe(await loadOrCreateServerInstanceId(second));
  });

  it("returns the public capability contract", async () => {
    const app = Fastify();
    await registerServerMetaRoute(app, "server-test", () => new Date("2026-08-25T00:00:00.000Z"));
    const response = await app.inject({ method: "GET", url: "/api/meta" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(createServerMeta("server-test", () => new Date("2026-08-25T00:00:00.000Z")));
    expect(response.json().capabilities.applications).toEqual({ schemaVersions: [2], immutablePublications: true });
    await app.close();
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `pnpm --filter @bim-studio/api test -- serverMeta.test.ts`

Expected: FAIL because `serverMeta.ts` does not exist.

- [ ] **Step 3: Implement atomic ID creation and the fixed capability payload**

Create `apps/api/src/serverMeta.ts`:

```ts
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { ServerMetaResponse } from "@bim-studio/contracts";

const INSTANCE_FILE = "server-instance-id";

export async function loadOrCreateServerInstanceId(dataDir: string): Promise<string> {
  await mkdir(dataDir, { recursive: true });
  const filePath = path.join(dataDir, INSTANCE_FILE);
  try {
    const current = (await readFile(filePath, "utf8")).trim();
    if (current) return current;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const generated = randomUUID();
  try {
    const handle = await open(filePath, "wx");
    try { await handle.writeFile(`${generated}\n`, "utf8"); }
    finally { await handle.close(); }
    return generated;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const current = (await readFile(filePath, "utf8")).trim();
    if (!current) throw new Error("server-instance-id 文件为空");
    return current;
  }
}

export function createServerMeta(serverInstanceId: string, now = () => new Date()): ServerMetaResponse {
  return {
    serverInstanceId,
    apiVersion: "1.0",
    serverTime: now().toISOString(),
    capabilities: {
      applications: { schemaVersions: [2], immutablePublications: true },
      legacyScenes: { schemaVersions: [1], routes: true },
      authentication: { providers: ["local"] },
      hosts: { browser: true, tauri: false }
    }
  };
}

export async function registerServerMetaRoute(app: FastifyInstance, serverInstanceId: string, now = () => new Date()): Promise<void> {
  app.get("/api/meta", async () => createServerMeta(serverInstanceId, now));
}
```

In `buildApp()`, resolve the ID once and register the route before system routes:

```ts
const serverInstanceId = await loadOrCreateServerInstanceId(config.dataDir);
await registerServerMetaRoute(app, serverInstanceId);
await registerSystemRoutes(app, store, config.dataDir);
```

In `apps/api/src/system.ts`, change the public bypass condition to include the exact path, not an `/api/meta*` prefix:

```ts
if (pathname === "/health" || pathname === "/api/meta" || pathname === "/api/auth/login" || pathname.startsWith("/api/public/") || pathname.startsWith("/assets/")) return;
```

- [ ] **Step 4: Run the focused and API package checks**

Run: `pnpm --filter @bim-studio/api test -- serverMeta.test.ts`

Expected: PASS with 3 tests.

Run: `pnpm --filter @bim-studio/api test && pnpm --filter @bim-studio/api typecheck`

Expected: all API tests pass and typecheck exits 0.

- [ ] **Step 5: Commit the handshake**

```bash
git add apps/api/src/serverMeta.ts apps/api/src/serverMeta.test.ts apps/api/src/index.ts apps/api/src/system.ts
git commit -m "feat(api): add stable public server metadata"
```

### Task 4: Pure studio-core application state, commands, and history

**Files:**
- Create: `packages/studio-core/package.json`
- Create: `packages/studio-core/tsconfig.json`
- Create: `packages/studio-core/src/command.ts`
- Create: `packages/studio-core/src/applicationStore.ts`
- Create: `packages/studio-core/src/applicationStore.test.ts`
- Create: `packages/studio-core/src/index.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: Task 1 `ApplicationDocument` and `ApplicationObjectRef` only.
- Produces: `StudioCommand`, `ApplicationState`, `ApplicationStore`, `createRenameApplicationCommand(name: string): StudioCommand`, and the package public API `@bim-studio/studio-core`.

- [ ] **Step 1: Add package metadata and a failing state/history test**

Create `packages/studio-core/package.json`:

```json
{
  "name": "@bim-studio/studio-core",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "build": "tsc --noEmit",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": { "@bim-studio/contracts": "workspace:*" },
  "devDependencies": { "typescript": "^5.9.3", "vitest": "^4.1.0" }
}
```

Create `packages/studio-core/tsconfig.json` with the same structure as `packages/contracts/tsconfig.json`.

Create `packages/studio-core/src/applicationStore.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import pureFixture from "../../contracts/src/__fixtures__/scene-v1-pure-3d.json";
import { migrateSceneSnapshotV1, type SceneSnapshot } from "@bim-studio/contracts";
import { ApplicationStore, createRenameApplicationCommand } from "./index.js";

function document() { return migrateSceneSnapshotV1(pureFixture as SceneSnapshot); }

describe("ApplicationStore", () => {
  it("dispatches, undoes, and redoes a serializable command", () => {
    const store = new ApplicationStore(document());
    store.dispatch(createRenameApplicationCommand("新名称"));
    expect(store.getState()).toMatchObject({ dirty: true, canUndo: true, canRedo: false });
    expect(store.getState().document?.metadata.name).toBe("新名称");
    expect(store.undo()).toBe(true);
    expect(store.getState().document?.metadata.name).toBe("纯三维");
    expect(store.redo()).toBe(true);
    expect(store.getState().document?.metadata.name).toBe("新名称");
  });

  it("resets history when a different document is loaded", () => {
    const store = new ApplicationStore(document());
    store.dispatch(createRenameApplicationCommand("临时名称"));
    store.load(document());
    expect(store.getState()).toMatchObject({ dirty: false, canUndo: false, canRedo: false });
  });

  it("publishes one immutable snapshot per subscriber notification", () => {
    const store = new ApplicationStore(document());
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.setSelection([{ kind: "scene", id: "scene-pure-3d" }]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(() => (store.getState().selection as unknown[]).push({})).toThrow();
    unsubscribe();
  });
});
```

- [ ] **Step 2: Run the package test and verify the missing implementation failure**

Run: `pnpm --filter @bim-studio/studio-core test`

Expected: FAIL because `src/index.ts` and `ApplicationStore` do not exist.

- [ ] **Step 3: Implement commands and the in-memory history store**

Create `packages/studio-core/src/command.ts`:

```ts
import type { ApplicationDocument } from "@bim-studio/contracts";

export interface RenameApplicationCommand {
  readonly id: string;
  readonly type: "application.rename";
  readonly label: string;
  readonly payload: { readonly name: string };
}

export type StudioCommand = RenameApplicationCommand;

export function createRenameApplicationCommand(name: string): RenameApplicationCommand {
  return {
    id: commandId(),
    type: "application.rename",
    label: `重命名应用为“${name}”`,
    payload: { name }
  };
}

export function applyStudioCommand(document: ApplicationDocument, command: StudioCommand): ApplicationDocument {
  const reducerInput = freezeRecursively(structuredClone(document));
  switch (command.type) {
    case "application.rename": {
      const renamed = structuredClone(reducerInput);
      return { ...renamed, metadata: { ...renamed.metadata, name: command.payload.name } };
    }
  }
}
```

Do not use global `crypto` in Core because Node and browser injection differ. Replace the ID expression above with a deterministic caller-independent counter held in this module:

```ts
let nextCommandId = 1;
const commandId = () => `command:${nextCommandId++}`;
```

and set `id: commandId()`. This preserves the no-host-dependency rule.

Create `packages/studio-core/src/applicationStore.ts`:

```ts
import type { ApplicationDocument, ApplicationObjectRef } from "@bim-studio/contracts";
import { applyStudioCommand, type StudioCommand } from "./command.js";

export interface ApplicationState {
  readonly document?: ApplicationDocument;
  readonly selection: readonly ApplicationObjectRef[];
  readonly dirty: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

interface HistoryEntry { command: StudioCommand; before: ApplicationDocument; after: ApplicationDocument; }
type Listener = () => void;

export class ApplicationStore {
  private document?: ApplicationDocument;
  private selection: ApplicationObjectRef[] = [];
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private listeners = new Set<Listener>();

  constructor(document?: ApplicationDocument) { if (document) this.load(document); }

  getState(): ApplicationState {
    return Object.freeze({
      ...(this.document ? { document: structuredClone(this.document) } : {}),
      selection: Object.freeze(structuredClone(this.selection)),
      dirty: this.undoStack.length > 0,
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0
    });
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  load(document: ApplicationDocument): void {
    this.document = structuredClone(document);
    this.selection = [];
    this.undoStack = [];
    this.redoStack = [];
    this.emit();
  }

  dispatch(command: StudioCommand): void {
    if (!this.document) throw new Error("没有已打开的应用文档");
    const before = structuredClone(this.document);
    const after = applyStudioCommand(before, command);
    this.document = structuredClone(after);
    this.undoStack.push({ command, before, after: structuredClone(after) });
    this.redoStack = [];
    this.emit();
  }

  undo(): boolean {
    const entry = this.undoStack.pop();
    if (!entry) return false;
    this.document = structuredClone(entry.before);
    this.redoStack.push(entry);
    this.emit();
    return true;
  }

  redo(): boolean {
    const entry = this.redoStack.pop();
    if (!entry) return false;
    this.document = structuredClone(entry.after);
    this.undoStack.push(entry);
    this.emit();
    return true;
  }

  setSelection(selection: readonly ApplicationObjectRef[]): void {
    this.selection = structuredClone([...selection]);
    this.emit();
  }

  private emit(): void { for (const listener of this.listeners) listener(); }
}
```

Create `packages/studio-core/src/index.ts`:

```ts
export * from "./applicationStore.js";
export * from "./command.js";
```

- [ ] **Step 4: Refresh the lockfile and run package checks**

Run: `pnpm install --lockfile-only`

Expected: `pnpm-lock.yaml` gains a `packages/studio-core` importer with a workspace link to `packages/contracts`; no registry dependency versions change unexpectedly.

Run: `pnpm --filter @bim-studio/studio-core test && pnpm --filter @bim-studio/studio-core typecheck`

Expected: 3 tests pass and typecheck exits 0.

- [ ] **Step 5: Commit studio-core**

```bash
git add packages/studio-core pnpm-lock.yaml
git commit -m "feat(core): add application commands and history"
```

### Task 5: Injectable ServerClient, BrowserHostAdapter, and compatible api facade

**Files:**
- Create: `packages/server-sdk/package.json`
- Create: `packages/server-sdk/tsconfig.json`
- Create: `packages/server-sdk/src/serverClient.ts`
- Create: `packages/server-sdk/src/serverClient.test.ts`
- Create: `packages/server-sdk/src/index.ts`
- Modify: `apps/web/package.json`
- Create: `apps/web/src/adapters/browserHostAdapter.ts`
- Create: `apps/web/src/adapters/browserHostAdapter.test.ts`
- Modify: `apps/web/src/api.ts:1-55,58-173`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: Task 1 application/meta contracts and Task 2 HTTP routes.
- Produces: `ServerProfile { baseUrl: string }`, `AuthStore`, `ServerClientOptions`, `ServerClient.request<T>(path: string, init?: RequestInit): Promise<T>`, `ServerClient.open(path: string, init?: RequestInit): Promise<Response>`, `getMeta()`, typed application CRUD/publish methods, and `BrowserHostAdapter implements AuthStore`.
- Compatibility promise: exported `getAuthToken`, `setAuthToken`, and every existing property of `api` retain their current parameter and return signatures.

- [ ] **Step 1: Create package metadata and failing transport tests**

Create `packages/server-sdk/package.json` and `tsconfig.json` by copying Task 4 package structure, changing the package name to `@bim-studio/server-sdk`.

Create `packages/server-sdk/src/serverClient.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { ServerClient } from "./serverClient.js";

describe("ServerClient", () => {
  it("resolves paths against the injected profile and adds the injected token", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ serverInstanceId: "s1" }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = new ServerClient({
      profile: { baseUrl: "https://bim.example.test/base/" },
      authStore: { getAccessToken: () => "token-1", setAccessToken: () => undefined, clearAccessToken: () => undefined },
      fetch
    });
    await client.request("/api/meta");
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://bim.example.test/api/meta");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer token-1");
  });

  it("notifies once and throws the server message on 401", async () => {
    const onUnauthorized = vi.fn();
    const client = new ServerClient({
      profile: { baseUrl: "https://bim.example.test" },
      authStore: { getAccessToken: () => "expired", setAccessToken: () => undefined, clearAccessToken: () => undefined },
      fetch: async () => new Response(JSON.stringify({ message: "登录失效" }), { status: 401 }),
      onUnauthorized
    });
    await expect(client.request("/api/projects")).rejects.toThrow("登录失效");
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test and verify the missing-client failure**

Run: `pnpm --filter @bim-studio/server-sdk test`

Expected: FAIL because `serverClient.ts` does not exist.

- [ ] **Step 3: Implement the injected client and typed v2 methods**

Create `packages/server-sdk/src/serverClient.ts`:

```ts
import type { ApplicationDocument, PublishedApplicationRecord, ServerMetaResponse } from "@bim-studio/contracts";

export type Awaitable<T> = T | Promise<T>;
export interface ServerProfile { baseUrl: string; }
export interface AuthStore {
  getAccessToken(): Awaitable<string | undefined>;
  setAccessToken(token: string, persistent: boolean): Awaitable<void>;
  clearAccessToken(): Awaitable<void>;
}
export interface ServerClientOptions {
  profile: ServerProfile;
  authStore: AuthStore;
  fetch?: typeof globalThis.fetch;
  onUnauthorized?: () => void;
}

export class ServerClient {
  private readonly fetchImpl: typeof globalThis.fetch;
  constructor(private readonly options: ServerClientOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async open(path: string, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers);
    const token = await this.options.authStore.getAccessToken();
    if (token) headers.set("authorization", `Bearer ${token}`);
    const response = await this.fetchImpl(new URL(path, normalizedBase(this.options.profile.baseUrl)), { ...init, headers });
    if (!response.ok) {
      const body = await response.clone().json().catch(() => ({ message: response.statusText })) as { message?: string };
      if (response.status === 401) this.options.onUnauthorized?.();
      throw new Error(body.message ?? `请求失败：${response.status}`);
    }
    return response;
  }

  async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.open(path, init);
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }

  getMeta(): Promise<ServerMetaResponse> { return this.request("/api/meta"); }
  listApplications(projectId: string): Promise<ApplicationDocument[]> { return this.request(`/api/projects/${encodeURIComponent(projectId)}/applications`); }
  getApplication(projectId: string, applicationId: string): Promise<ApplicationDocument> { return this.request(`/api/projects/${encodeURIComponent(projectId)}/applications/${encodeURIComponent(applicationId)}`); }
  createApplication(document: ApplicationDocument): Promise<ApplicationDocument> { return this.request(`/api/projects/${encodeURIComponent(document.metadata.projectId)}/applications`, json("POST", document)); }
  saveApplication(document: ApplicationDocument): Promise<ApplicationDocument> { return this.request(`/api/projects/${encodeURIComponent(document.metadata.projectId)}/applications/${encodeURIComponent(document.metadata.id)}`, json("PUT", document)); }
  deleteApplication(projectId: string, applicationId: string): Promise<void> { return this.request(`/api/projects/${encodeURIComponent(projectId)}/applications/${encodeURIComponent(applicationId)}`, { method: "DELETE" }); }
  publishApplication(projectId: string, applicationId: string): Promise<PublishedApplicationRecord> { return this.request(`/api/projects/${encodeURIComponent(projectId)}/applications/${encodeURIComponent(applicationId)}/publish`, { method: "POST" }); }
  unpublishApplication(projectId: string, applicationId: string): Promise<void> { return this.request(`/api/projects/${encodeURIComponent(projectId)}/applications/${encodeURIComponent(applicationId)}/publish`, { method: "DELETE" }); }
}

function normalizedBase(baseUrl: string): string { return `${baseUrl.replace(/\/$/, "")}/`; }
function json(method: "POST" | "PUT", body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}
```

Create `packages/server-sdk/src/index.ts`:

```ts
export * from "./serverClient.js";
```

- [ ] **Step 4: Add BrowserHostAdapter with storage-choice tests**

Create `apps/web/src/adapters/browserHostAdapter.test.ts` using a minimal fake storage/window and assert remembered tokens go only to local storage, session tokens go only to session storage, `clearAccessToken()` clears both, and `notifyUnauthorized()` dispatches `bim-studio-auth-required`.

Create `apps/web/src/adapters/browserHostAdapter.ts`:

```ts
import type { AuthStore, ServerProfile } from "@bim-studio/server-sdk";

const AUTH_TOKEN_KEY = "bim-studio-auth-token";

export class BrowserHostAdapter implements AuthStore {
  constructor(private readonly browserWindow: Window) {}
  getServerProfile(): ServerProfile { return { baseUrl: this.browserWindow.location.origin }; }
  getAccessToken(): string { return this.browserWindow.localStorage.getItem(AUTH_TOKEN_KEY) ?? this.browserWindow.sessionStorage.getItem(AUTH_TOKEN_KEY) ?? ""; }
  setAccessToken(token: string, persistent: boolean): void {
    this.clearAccessToken();
    (persistent ? this.browserWindow.localStorage : this.browserWindow.sessionStorage).setItem(AUTH_TOKEN_KEY, token);
  }
  clearAccessToken(): void {
    this.browserWindow.localStorage.removeItem(AUTH_TOKEN_KEY);
    this.browserWindow.sessionStorage.removeItem(AUTH_TOKEN_KEY);
  }
  notifyUnauthorized(): void { this.browserWindow.dispatchEvent(new CustomEvent("bim-studio-auth-required")); }
}
```

- [ ] **Step 5: Delegate the old facade transport without changing callers**

Add `@bim-studio/server-sdk: workspace:*` to `apps/web/package.json` and run `pnpm install --lockfile-only`.

At the top of `apps/web/src/api.ts`, instantiate one browser adapter and client:

```ts
const browserHost = new BrowserHostAdapter(window);
const serverClient = new ServerClient({
  profile: browserHost.getServerProfile(),
  authStore: browserHost,
  onUnauthorized: () => browserHost.notifyUnauthorized()
});

export function getAuthToken() { return browserHost.getAccessToken(); }
export function setAuthToken(token?: string, remember = true) {
  if (token) browserHost.setAccessToken(token, remember);
  else browserHost.clearAccessToken();
}
const request = <T>(url: string, init?: RequestInit) => serverClient.request<T>(url, init);
```

Delete only the old `AUTH_TOKEN_KEY` constant and old private `request` implementation. In `streamAssistant`, replace direct `fetch(...)` with:

```ts
const response = await serverClient.open("/api/ai/assistant/stream", {
  method: "POST",
  headers: { "content-type": "application/json", accept: "text/event-stream" },
  body: JSON.stringify({ mode, question, context })
});
```

Keep its existing SSE parsing loop. Add v2 methods to the existing `api` object by direct delegation:

```ts
getMeta: () => serverClient.getMeta(),
listApplications: (projectId: string) => serverClient.listApplications(projectId),
getApplication: (projectId: string, applicationId: string) => serverClient.getApplication(projectId, applicationId),
createApplication: (document: ApplicationDocument) => serverClient.createApplication(document),
saveApplication: (document: ApplicationDocument) => serverClient.saveApplication(document),
deleteApplication: (projectId: string, applicationId: string) => serverClient.deleteApplication(projectId, applicationId),
publishApplication: (projectId: string, applicationId: string) => serverClient.publishApplication(projectId, applicationId),
unpublishApplication: (projectId: string, applicationId: string) => serverClient.unpublishApplication(projectId, applicationId),
```

Do not rename or remove any existing `api` member.

- [ ] **Step 6: Run SDK and web checks**

Run: `pnpm --filter @bim-studio/server-sdk test && pnpm --filter @bim-studio/server-sdk typecheck`

Expected: 2 client tests pass and typecheck exits 0.

Run: `pnpm --filter @bim-studio/web test -- browserHostAdapter.test.ts && pnpm --filter @bim-studio/web typecheck`

Expected: BrowserHostAdapter tests pass; all existing facade consumers typecheck without edits.

- [ ] **Step 7: Commit the client boundary**

```bash
git add packages/server-sdk apps/web/package.json apps/web/src/adapters/browserHostAdapter.ts apps/web/src/adapters/browserHostAdapter.test.ts apps/web/src/api.ts pnpm-lock.yaml
git commit -m "refactor(web): inject server client and browser host"
```

### Task 6: Minimal v2 application state seam in the existing scene workflow

**Files:**
- Modify: `apps/web/package.json`
- Create: `apps/web/src/studio/legacyApplicationSession.ts`
- Create: `apps/web/src/studio/legacyApplicationSession.test.ts`
- Modify: `apps/web/src/App.tsx:1-117,263-285,1303-1363,1440-1450`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: Task 1 migration functions and Task 4 `ApplicationStore`.
- Produces: `LegacyApplicationSession.open(snapshot: SceneSnapshot): ApplicationDocument`, `capture(snapshot: SceneSnapshot): SceneSnapshot`, `getApplication(): ApplicationDocument | undefined`, and one private `useRef` integration in `App.tsx`.

- [ ] **Step 1: Write the failing session test**

Create `apps/web/src/studio/legacyApplicationSession.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import dashboardFixture from "../../../../packages/contracts/src/__fixtures__/scene-v1-dashboard.json";
import type { SceneSnapshot } from "@bim-studio/contracts";
import { LegacyApplicationSession } from "./legacyApplicationSession.js";

describe("LegacyApplicationSession", () => {
  it("opens v1 as v2 state and emits the same v1 snapshot", () => {
    const session = new LegacyApplicationSession();
    const snapshot = dashboardFixture as unknown as SceneSnapshot;
    expect(session.open(snapshot).schemaVersion).toBe(2);
    expect(session.getApplication()?.metadata.id).toBe(snapshot.id);
    expect(session.capture(snapshot)).toEqual(snapshot);
  });

  it("replaces state when navigation opens another scene", () => {
    const session = new LegacyApplicationSession();
    session.open(dashboardFixture as unknown as SceneSnapshot);
    const second = { ...structuredClone(dashboardFixture), id: "second-scene", name: "第二场景" } as SceneSnapshot;
    session.open(second);
    expect(session.getApplication()?.metadata.name).toBe("第二场景");
    expect(session.store.getState().canUndo).toBe(false);
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `pnpm --filter @bim-studio/web test -- legacyApplicationSession.test.ts`

Expected: FAIL because `legacyApplicationSession.ts` does not exist.

- [ ] **Step 3: Implement the narrow compatibility session**

Add `@bim-studio/studio-core: workspace:*` to `apps/web/package.json`, refresh the lockfile with `pnpm install --lockfile-only`, and create `apps/web/src/studio/legacyApplicationSession.ts`:

```ts
import { applicationToSceneSnapshotV1, migrateSceneSnapshotV1, type ApplicationDocument, type SceneSnapshot } from "@bim-studio/contracts";
import { ApplicationStore } from "@bim-studio/studio-core";

export class LegacyApplicationSession {
  readonly store = new ApplicationStore();

  open(snapshot: SceneSnapshot): ApplicationDocument {
    const application = migrateSceneSnapshotV1(snapshot);
    this.store.load(application);
    return application;
  }

  capture(snapshot: SceneSnapshot): SceneSnapshot {
    const application = migrateSceneSnapshotV1(snapshot);
    this.store.load(application);
    return applicationToSceneSnapshotV1(application, snapshot.id);
  }

  getApplication(): ApplicationDocument | undefined {
    return this.store.getState().document;
  }
}
```

- [ ] **Step 4: Add only the two App.tsx synchronization points**

In `App.tsx`, import `LegacyApplicationSession`, create exactly one ref next to the existing renderer snapshot ref, and make no component extraction:

```ts
const applicationSessionRef = useRef(new LegacyApplicationSession());
```

At the start of `applyScene(...)`, after the `engine`/`sceneProject` guard and before mutating viewer state, add:

```ts
applicationSessionRef.current.open(scene);
```

In `makeSnapshot()`, assign the current object literal to `const snapshot: SceneSnapshot`, then return:

```ts
return applicationSessionRef.current.capture(snapshot);
```

Do not change route parsing, viewer creation, model loading, dashboard overlay, save endpoint, publish endpoint, or any `ViewerEngine` method. The current UI continues saving v1 through `api.saveScene`; v2 is now the in-memory architecture seam, not a second UI flow.

- [ ] **Step 5: Run focused compatibility and build checks**

Run: `pnpm --filter @bim-studio/web test -- legacyApplicationSession.test.ts`

Expected: both session tests pass.

Run: `pnpm --filter @bim-studio/web typecheck && pnpm --filter @bim-studio/web build`

Expected: typecheck exits 0; Vite build completes; no changes are required in `ViewerEngine.ts`.

- [ ] **Step 6: Commit the vertical seam**

```bash
git add apps/web/package.json apps/web/src/studio/legacyApplicationSession.ts apps/web/src/studio/legacyApplicationSession.test.ts apps/web/src/App.tsx pnpm-lock.yaml
git commit -m "refactor(web): seed application state from legacy scenes"
```

### Task 7: Architecture boundaries and end-to-end golden compatibility gate

**Files:**
- Create: `packages/studio-core/src/architecture.test.ts`
- Create: `apps/web/src/architecture.test.ts`
- Create: `apps/web/src/sceneFiles.test.ts`
- Create: `apps/api/src/applicationCompatibility.test.ts`

**Interfaces:**
- Consumes: all public APIs from Tasks 1-6.
- Produces: executable merge gates proving Core dependency direction, web adapter usage, loose v1 import compatibility, API restart persistence, immutable application publication, and continued v1 scene publication.

- [ ] **Step 1: Write the Core dependency-boundary test and make it fail on forbidden imports**

Create `packages/studio-core/src/architecture.test.ts`:

```ts
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const forbidden = /from\s+["'](?:react(?:-dom)?(?:\/[^"']*)?|three(?:\/[^"']*)?|@tauri-apps\/[^"']*|node:https?)["']|\bfetch\s*\(|\bwindow\b|\bglobalThis\s*\.\s*document\b|\bdocument\s*\.\s*(?:body|cookie|createElement|getElementById|querySelector|querySelectorAll)\b/;

describe("studio-core dependency direction", () => {
  it("does not import UI, renderer, host, or network implementations", async () => {
    const directory = path.resolve(import.meta.dirname);
    const files = (await readdir(directory)).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
    const violations: string[] = [];
    for (const file of files) {
      const source = await readFile(path.join(directory, file), "utf8");
      if (forbidden.test(source)) violations.push(file);
    }
    expect(violations).toEqual([]);
  });
});
```

Add `@types/node` as a dev dependency of `packages/studio-core` because only the test uses Node filesystem APIs. Run `pnpm install --lockfile-only`.

- [ ] **Step 2: Add web boundary checks for facade and forbidden core deep imports**

Create `apps/web/src/architecture.test.ts`:

```ts
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => entry.isDirectory()
    ? sourceFiles(path.join(directory, entry.name))
    : Promise.resolve(entry.name.endsWith(".ts") || entry.name.endsWith(".tsx") ? [path.join(directory, entry.name)] : [])));
  return nested.flat();
}

describe("web architecture boundary", () => {
  it("uses package public APIs instead of package source deep imports", async () => {
    const root = path.resolve(import.meta.dirname);
    const files = await sourceFiles(root);
    const violations: string[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      if (/from\s+["']@bim-studio\/(?:studio-core|server-sdk)\//.test(source)) violations.push(path.relative(root, file));
    }
    expect(violations).toEqual([]);
  });

  it("keeps raw HTTP transport inside api.ts and adapters", async () => {
    const root = path.resolve(import.meta.dirname);
    const files = (await sourceFiles(root)).filter((file) =>
      !file.endsWith("api.ts") &&
      !file.endsWith("sceneFiles.ts") &&
      !file.endsWith("ViewerEngine.ts") &&
      !file.endsWith(path.join("optimizer", "modelOptimizer.ts")) &&
      !file.includes(`${path.sep}adapters${path.sep}`) &&
      !file.endsWith(".test.ts"));
    const violations: string[] = [];
    for (const file of files) if (/\bfetch\s*\(/.test(await readFile(file, "utf8"))) violations.push(path.relative(root, file));
    expect(violations).toEqual([]);
  });
});
```

Before enforcing the second assertion, run `rg -n "\bfetch\(" apps/web/src -g "*.ts" -g "*.tsx"`. Expected: JSON/SSE business API transport appears only in `api.ts`/the adapter boundary. The test explicitly preserves three pre-existing non-business-API exceptions: `sceneFiles.ts` for packaged scene geometry, `ViewerEngine.ts` for renderer-owned model/manifest assets, and `optimizer/modelOptimizer.ts` for Draco runtime files.

- [ ] **Step 3: Add loose scene file golden import coverage**

Export `parseScene(text: string): SceneSnapshot` from `apps/web/src/sceneFiles.ts` without changing its validation. Create `apps/web/src/sceneFiles.test.ts` importing each of the three JSON fixtures and asserting `parseScene(JSON.stringify(fixture))` equals the fixture. Add a negative case asserting schemaVersion `2` throws `不支持的场景文件版本`. This proves `.scene.json` remains a v1 interchange format during M0.

- [ ] **Step 4: Add API restart and dual-route compatibility coverage**

Create `apps/api/src/applicationCompatibility.test.ts` with one temporary data directory and this sequence:

```ts
const firstStore = new JsonStore(directory);
await firstStore.init();
const v1 = { ...(pureFixture as SceneSnapshot), projectId: "default" };
await firstStore.saveScene(v1);
const v2 = migrateSceneSnapshotV1(v1);
await firstStore.saveApplication(v2);
const publication = await firstStore.savePublishedApplication({
  id: "publication-golden",
  applicationId: v2.metadata.id,
  projectId: v2.metadata.projectId,
  applicationRevision: v2.metadata.revision,
  document: structuredClone(v2),
  publishedAt: "2026-08-25T00:00:00.000Z"
});
await firstStore.saveApplicationPublicationPointer({
  applicationId: v2.metadata.id,
  projectId: v2.metadata.projectId,
  activePublicationId: publication.id,
  updatedAt: publication.publishedAt
});

const restartedStore = new JsonStore(directory);
await restartedStore.init();
expect(restartedStore.getScene("default", v1.id)).toEqual(v1);
expect(restartedStore.getApplication("default", v2.metadata.id)).toEqual(v2);
expect(restartedStore.getPublishedApplication(publication.id)).toEqual(publication);
expect(restartedStore.getApplicationPublicationPointer(v2.metadata.id)?.activePublicationId).toBe(publication.id);
```

Then mutate the reloaded draft name and assert the stored publication document name remains `纯三维`. This is the final proof that draft persistence and immutable publication are independent.

- [ ] **Step 5: Run the architecture and golden gates**

Run: `pnpm --filter @bim-studio/contracts test -- applicationMigration.test.ts`

Expected: all three v1 fixtures round-trip through v2.

Run: `pnpm --filter @bim-studio/studio-core test -- architecture.test.ts applicationStore.test.ts`

Expected: Core history tests and forbidden-dependency test pass.

Run: `pnpm --filter @bim-studio/web test -- architecture.test.ts sceneFiles.test.ts legacyApplicationSession.test.ts`

Expected: public-import, transport-boundary, v1 loose-file, and session tests pass.

Run: `pnpm --filter @bim-studio/api test -- applicationCompatibility.test.ts applicationRoutes.test.ts routes.test.ts serverMeta.test.ts`

Expected: restart persistence, immutable application publication, old scene routes, and stable meta tests pass.

- [ ] **Step 6: Run the repository-wide merge gate**

Run: `pnpm test`

Expected: every workspace test passes; no test writes tracked files.

Run: `pnpm typecheck`

Expected: every workspace exits 0 with no TypeScript diagnostics.

Run: `pnpm build`

Expected: API and web production builds complete; legacy `/studio/:sceneId`, `/view/:sceneId`, and `/published/:sceneId` route bundles still build.

Run: `git diff --name-only f07e033..HEAD`

Expected: no `apps/web/src/viewer/ViewerEngine.ts`, no M1 UI module, no Tauri file, and no generated `dist/`/`data/` path appears.

- [ ] **Step 7: Commit the merge gates**

```bash
git add packages/studio-core/src/architecture.test.ts packages/studio-core/package.json apps/web/src/architecture.test.ts apps/web/src/sceneFiles.ts apps/web/src/sceneFiles.test.ts apps/api/src/applicationCompatibility.test.ts pnpm-lock.yaml
git commit -m "test(m0): enforce architecture and v1 compatibility"
```

### Task 8: SceneCapabilitySDK 1.0 programmability and extension contract

**Files:**
- Create: `packages/scene-sdk/package.json`
- Create: `packages/scene-sdk/tsconfig.json`
- Create: `packages/scene-sdk/src/protocol.ts`
- Create: `packages/scene-sdk/src/compatibility.ts`
- Create: `packages/scene-sdk/src/compatibility.test.ts`
- Create: `packages/scene-sdk/src/architecture.test.ts`
- Create: `packages/scene-sdk/src/index.ts`
- Modify: `packages/contracts/src/application.ts`
- Modify: `packages/contracts/src/applicationMigration.ts`
- Modify: `packages/contracts/src/applicationValidation.ts`
- Modify: `packages/contracts/src/applicationValidation.test.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Produces `SCENE_API_VERSION = "1.0"`, `SceneCapability`, `ScenePermission`, `SceneObjectRef`, `SceneCommand`, `SceneQuery`, `SceneEvent`, `SceneScriptLifecycle`, `SceneExtensionManifest`, `SceneHostCapabilities`, `SceneExtensionCompatibility`, and `resolveSceneExtensionCompatibility(...)` from package public API `@bim-studio/scene-sdk`.
- Extends `ScriptModule` with required `apiVersion: "1.0"` and `entrypoint: "behavior"`; the v1 migration must populate both fields and round-trip behavior must remain unchanged.
- Establishes protocol only. It must not import or expose React, Three.js, `ViewerEngine`, DOM, HTTP, Tauri, WebGPU objects, or executable plugin loading.

- [ ] **Step 1: Add package metadata and failing compatibility tests**

Create package metadata matching `packages/studio-core`, with package name `@bim-studio/scene-sdk`, dependency only on `@bim-studio/contracts`, and Vitest/TypeScript dev dependencies.

In `compatibility.test.ts`, first assert these cases against the missing implementation:

1. A worker behavior extension requesting `studio.scene`, `studio.object`, `studio.camera`, and `scene.read` is compatible with API `1.0`, browser host, and both render backends.
2. API major mismatch (`2.0` extension against `1.0` host) returns incompatible with reason code `api-major-mismatch`.
3. Missing capability and missing permission are both reported deterministically and sorted.
4. A trusted main-thread extension is rejected when the host does not allow trusted extensions.
5. A WebGPU-only extension is rejected on a WebGL 2 host with `renderer-unsupported`.
6. Every command/query/event fixture survives `structuredClone` and `JSON.stringify` without functions, class instances, or engine objects.

Run: `pnpm --filter @bim-studio/scene-sdk test`

Expected: FAIL because the package implementation does not exist.

- [ ] **Step 2: Define the exact public protocol**

`protocol.ts` must export:

```ts
export const SCENE_API_VERSION = "1.0" as const;
export type SceneApiVersion = typeof SCENE_API_VERSION;

export const SCENE_CAPABILITIES = [
  "studio.scene", "studio.object", "studio.mesh", "studio.material",
  "studio.camera", "studio.controls", "studio.animation", "studio.timeline",
  "studio.input", "studio.data", "studio.runtime"
] as const;
export type SceneCapability = typeof SCENE_CAPABILITIES[number];

export const SCENE_PERMISSIONS = [
  "scene.read", "scene.write", "data.read", "data.write",
  "network.connect", "renderer.extend", "editor.extend"
] as const;
export type ScenePermission = typeof SCENE_PERMISSIONS[number];

export type SceneObjectRef =
  | { kind: "scene"; sceneId: string }
  | { kind: "object"; sceneId: string; objectId: string }
  | { kind: "mesh"; sceneId: string; objectId: string; meshId: string };

export type SceneCommand =
  | { id: string; type: "object.set-visibility"; target: SceneObjectRef; visible: boolean }
  | { id: string; type: "object.set-transform"; target: SceneObjectRef; position?: [number, number, number]; rotation?: [number, number, number]; scale?: [number, number, number] }
  | { id: string; type: "selection.set"; targets: SceneObjectRef[] }
  | { id: string; type: "camera.set"; sceneId: string; position: [number, number, number]; target: [number, number, number]; near?: number; far?: number; fov?: number }
  | { id: string; type: "camera.fly-to"; sceneId: string; target: SceneObjectRef | { position: [number, number, number] }; durationMs: number }
  | { id: string; type: "animation.control"; target: SceneObjectRef; action: "play" | "pause" | "stop" | "seek"; clipId?: string; time?: number }
  | { id: string; type: "data.apply"; target: SceneObjectRef; values: Record<string, import("@bim-studio/contracts").JsonValue>; timestamp: string };

export type SceneQuery =
  | { id: string; type: "object.get"; target: SceneObjectRef }
  | { id: string; type: "object.search"; sceneId: string; text?: string; tags?: string[] }
  | { id: string; type: "camera.get"; sceneId: string }
  | { id: string; type: "capabilities.get" };

export type SceneEvent =
  | { type: "scene.ready" | "scene.disposed"; sceneId: string; timestamp: string }
  | { type: "selection.changed"; sceneId: string; targets: SceneObjectRef[]; timestamp: string }
  | { type: "object.event"; name: string; target: SceneObjectRef; timestamp: string; data?: import("@bim-studio/contracts").JsonValue }
  | { type: "data.received"; sceneId: string; timestamp: string; data: import("@bim-studio/contracts").JsonValue };

export type SceneScriptLifecycle = "onStart" | "onUpdate" | "onFixedUpdate" | "onData" | "onEvent" | "onStop" | "onDispose";
export type SceneExtensionExecution = "worker-sandbox" | "trusted-main-thread";
export type SceneHostKind = "browser" | "tauri" | "cloud";
export type SceneRendererKind = "webgl2" | "webgpu";

export interface SceneExtensionManifest {
  id: string;
  name: string;
  version: string;
  /** External manifests may target a newer SDK; compatibility negotiation validates this string before loading. */
  apiVersion: string;
  entry: string;
  execution: SceneExtensionExecution;
  capabilities: SceneCapability[];
  permissions: ScenePermission[];
  hosts: SceneHostKind[];
  renderers: SceneRendererKind[];
  lifecycle: SceneScriptLifecycle[];
}
```

All protocol members must use serializable data and stable IDs; no callable function belongs in the protocol.

- [ ] **Step 3: Implement deterministic compatibility negotiation**

`compatibility.ts` must define `SceneHostCapabilities` with API version, host, renderer, supported capability/permission arrays, and `allowTrustedExtensions`. `resolveSceneExtensionCompatibility` returns `{ compatible: boolean; reasons: Array<{ code; detail }> }`. It must validate a strict `major.minor` API form, require equal major and host minor greater than or equal to extension minor, and report reason codes in this fixed order: `invalid-api-version`, `api-major-mismatch`, `api-minor-unsupported`, `host-unsupported`, `renderer-unsupported`, `invalid-execution`, `trusted-extension-disabled`, `capability-unsupported`, `permission-denied`. Missing capabilities/permissions use sorted comma-separated detail so output is deterministic.

- [ ] **Step 4: Version ApplicationDocument scripts and preserve v1 migration**

Add required fields to `ScriptModule`:

```ts
apiVersion: "1.0";
entrypoint: "behavior";
```

Populate them in `migrateSceneSnapshotV1`, validate their exact literals in `applicationValidation.ts`, update valid builders and malformed tests, and keep all three v1 → v2 → v1 golden tests green.

- [ ] **Step 5: Add architecture boundary tests**

`architecture.test.ts` recursively reads non-test `.ts` files in this package and fails on imports/references to `react`, `react-dom`, `three`, `ViewerEngine`, `@tauri-apps/`, `window`, `document`, `fetch`, `node:http`, or `node:https`. It also scans exported protocol fixtures recursively and asserts no value is a function and every value survives `structuredClone` plus JSON round-trip.

- [ ] **Step 6: Run package and repository contract checks**

Run: `pnpm install --lockfile-only`

Run: `pnpm --filter @bim-studio/scene-sdk test && pnpm --filter @bim-studio/scene-sdk typecheck`

Expected: compatibility and architecture tests pass; typecheck has no diagnostics.

Run: `pnpm --filter @bim-studio/contracts test && pnpm --filter @bim-studio/contracts typecheck`

Expected: all contract validation and golden migration tests remain green.

- [ ] **Step 7: Commit the programmability contract**

```bash
git add packages/scene-sdk packages/contracts/src/application.ts packages/contracts/src/applicationMigration.ts packages/contracts/src/applicationValidation.ts packages/contracts/src/applicationValidation.test.ts pnpm-lock.yaml
git commit -m "feat(sdk): define scene programmability contract"
```

## Final Acceptance Checklist

- [ ] `SceneSnapshot` is still declared once with `schemaVersion: 1`, and existing scene file/API responses are unchanged.
- [ ] All three v1 golden files migrate to v2 and round-trip byte-semantically after JSON parsing.
- [ ] A v2 application survives `JsonStore` restart and update conflicts return HTTP 409 with the current revision.
- [ ] Each application publish creates a new immutable record; unpublish only clears the active pointer.
- [ ] `/api/meta` works with no Authorization header and its ID is stable for one `DATA_DIR`.
- [ ] A fake `fetch` and fake `AuthStore` can test `ServerClient` without `window`.
- [ ] Existing web callers still import `api`, `getAuthToken`, and `setAuthToken` with unchanged signatures.
- [ ] An old scene opened in `App.tsx` seeds an `ApplicationStore`, and saving still uses the old scene endpoint.
- [ ] Architecture tests reject Core dependencies on React/Three/Tauri/HTTP/DOM and reject package deep imports.
- [ ] `App.tsx` only has minimal session wiring; `ViewerEngine.ts` is untouched; no M1 UI exists.
- [ ] `SceneCapabilitySDK 1.0` exposes versioned serializable commands, queries, events, lifecycle, capabilities, permissions and extension compatibility without React/Three/DOM/host dependencies.
- [ ] Every `ScriptModule` records API version and entrypoint; incompatible extension API/host/renderer/capability/permission requirements are rejected before execution.
- [ ] `pnpm test`, `pnpm typecheck`, and `pnpm build` all pass before merge.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-25-dev-studio-m0-foundation.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task and review between tasks.
2. **Inline Execution** — execute task-by-task in this session with checkpoints.
