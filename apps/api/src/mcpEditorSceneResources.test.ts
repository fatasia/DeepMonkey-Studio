import { afterEach, describe, expect, it } from "vitest";
import { EditorPresenceRegistry, registerEditorPresenceRoutes } from "./editorPresence.js";
import { registerMcpCapabilityRoute } from "./mcpCapabilityAdapter.js";
import { createApiServer } from "./serverOptions.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map(cleanup => cleanup())));

describe("MCP active scene resources", () => {
  it("lists and reads revision-bound paged semantics, selection sets, and spatial relations", async () => {
    const user = {
      id: "editor-1", username: "editor", displayName: "Editor", role: "editor" as const,
      projectIds: ["project-1"], enabled: true, createdAt: "now", updatedAt: "now",
    };
    const models = Array.from({ length: 55 }, (_, index) => ({
      modelId: `model-${index}`, name: `Model ${index}`, visible: true, opacity: 1,
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    }));
    const application = {
      metadata: { id: "app-1", projectId: "project-1", name: "Plant", revision: 7 },
      scenes: [{ id: "scene-1", name: "Line", models, primitives: [], selectionSets: [
        { id: "critical", name: "Critical", objectIds: ["model-1"], kind: "group" },
      ] }],
      spatialNavigation: { rootNodeIds: ["plant"], cacheLimit: 2, nodes: [
        { id: "plant", name: "Plant", kind: "plant", sceneId: "scene-1", loadPolicy: "focus" },
        { id: "line", name: "Line", kind: "line", parentId: "plant", target: { modelId: "model-1" }, loadPolicy: "focus" },
      ] },
    };
    const store = { getApplication: () => application } as never;
    const presence = new EditorPresenceRegistry();
    presence.upsert("session-1", user, {
      leaseId: "lease-1", projectId: "project-1", applicationId: "app-1", applicationName: "Plant",
      surface: "scene", targetId: "scene-1", targetName: "Line", persistedRevision: 7,
      draftRevision: 11, dirty: true, selectionCount: 1,
    });
    const app = createApiServer();
    cleanups.push(() => app.close());
    app.addHook("preHandler", async request => { request.systemUser = user; });
    await registerMcpCapabilityRoute(app, {
      host: { registry: { listCapabilities: () => [] } } as never, store, editorPresence: presence,
    });

    const listed = await app.inject({
      method: "POST", url: "/api/mcp",
      payload: { jsonrpc: "2.0", id: 1, method: "resources/list" },
    });
    expect(listed.statusCode).toBe(200);
    const resources = listed.json().result.resources as Array<{ uri: string }>;
    expect(resources).toHaveLength(5);
    const pages = resources.filter(resource => resource.uri.includes("/scene-context/scene-objects"));
    expect(pages).toHaveLength(2);

    const read = await app.inject({
      method: "POST", url: "/api/mcp",
      payload: { jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri: pages[0]!.uri } },
    });
    const content = JSON.parse(read.json().result.contents[0].text);
    expect(content).toMatchObject({
      schema: "deep-monkey.editor-scene-resource.v1", kind: "scene-objects",
      persistedRevision: 7, activeDraftRevision: 11, draftDirty: true,
      source: "persisted-editor-base", page: 0, pageSize: 50, total: 55,
    });
    expect(content.items).toHaveLength(50);
    expect(content.nextUri).toContain("page=1");

    for (const [kind, expected] of [
      ["selection-sets", { id: "critical", objectIds: ["model-1"] }],
      ["spatial-relations", { id: "line", parentId: "plant", target: { modelId: "model-1" } }],
    ] as const) {
      const resource = resources.find(candidate => candidate.uri.includes(`/scene-context/${kind}`));
      const response = await app.inject({
        method: "POST", url: "/api/mcp",
        payload: { jsonrpc: "2.0", id: kind, method: "resources/read", params: { uri: resource!.uri } },
      });
      expect(JSON.parse(response.json().result.contents[0].text).items).toEqual(
        expect.arrayContaining([expect.objectContaining(expected)]),
      );
    }

    application.metadata.revision = 8;
    const stale = await app.inject({
      method: "POST", url: "/api/mcp",
      payload: { jsonrpc: "2.0", id: 3, method: "resources/read", params: { uri: pages[0]!.uri } },
    });
    expect(stale.statusCode).toBe(404);
    expect(stale.json().error.message).toContain("revision");
  });

  it("serves the unsaved draft mirror when revision-consistent and falls back honestly when it drifts", async () => {
    const user = {
      id: "editor-1", username: "editor", displayName: "Editor", role: "editor" as const,
      projectIds: ["project-1"], enabled: true, createdAt: "now", updatedAt: "now",
    };
    const persistedModel = {
      modelId: "persisted-pump", name: "Persisted Pump", visible: true, opacity: 1,
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    };
    const application = {
      metadata: { id: "app-1", projectId: "project-1", name: "Plant", revision: 7 },
      scenes: [{ id: "scene-1", name: "Line", models: [persistedModel], primitives: [], selectionSets: [] }],
      spatialNavigation: { rootNodeIds: [], cacheLimit: 2, nodes: [] },
    };
    const store = { getApplication: () => application } as never;
    const presence = new EditorPresenceRegistry();
    const app = createApiServer();
    cleanups.push(() => app.close());
    app.addHook("preHandler", async request => { request.systemUser = user; });
    await registerEditorPresenceRoutes(app, presence);
    await registerMcpCapabilityRoute(app, {
      host: { registry: { listCapabilities: () => [] } } as never, store, editorPresence: presence,
    });

    // 经 presence PUT 上报镜像：draft 里有持久化基线没有的模型与选择集。
    const upsert = await app.inject({
      method: "PUT", url: "/api/editor-presence/session-1",
      payload: {
        leaseId: "lease-1", projectId: "project-1", applicationId: "app-1", applicationName: "Plant",
        surface: "scene", targetId: "scene-1", targetName: "Line", persistedRevision: 7,
        draftRevision: 11, dirty: true, selectionCount: 1,
        draftMirror: {
          sceneId: "scene-1", revision: 11,
          objects: [
            { objectId: "persisted-pump", name: "Persisted Pump", kind: "model", visible: false, locked: false },
            { objectId: "draft-only", name: "Draft Only", kind: "model", visible: true, locked: false,
              layers: [{ id: "shell", visible: false }] },
          ],
          selectionSets: [{ id: "draft-set", name: "Draft Set", objectIds: ["draft-only"] }],
          spatialRelations: [{ id: "node-1", name: "Node", kind: "plant", loadPolicy: "focus" }],
        },
      },
    });
    expect(upsert.statusCode).toBe(200);

    const listed = await app.inject({
      method: "POST", url: "/api/mcp", payload: { jsonrpc: "2.0", id: 1, method: "resources/list" },
    });
    const resources = listed.json().result.resources as Array<{ uri: string; description?: string }>;
    expect(resources.some(resource => resource.description?.includes("未保存草稿镜像"))).toBe(true);
    const objects = resources.filter(resource => resource.uri.includes("/scene-context/scene-objects"));
    expect(objects).toHaveLength(1);

    const read = await app.inject({
      method: "POST", url: "/api/mcp", payload: { jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri: objects[0]!.uri } },
    });
    const content = JSON.parse(read.json().result.contents[0].text);
    expect(content).toMatchObject({
      schema: "deep-monkey.editor-scene-resource.v1",
      source: "browser-draft-mirror", draftDirty: true, activeDraftRevision: 11, total: 2,
    });
    expect(content.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ objectId: "draft-only", layers: [expect.objectContaining({ id: "shell", visible: false })] }),
    ]));
    expect(content.items).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ objectId: "persisted-pump", visible: true }),
    ]));

    const selectionRead = await app.inject({
      method: "POST", url: "/api/mcp",
      payload: { jsonrpc: "2.0", id: 3, method: "resources/read",
        params: { uri: resources.find(resource => resource.uri.includes("/scene-context/selection-sets"))!.uri } },
    });
    expect(JSON.parse(selectionRead.json().result.contents[0].text).items).toEqual([
      expect.objectContaining({ id: "draft-set", objectIds: ["draft-only"] }),
    ]);

    // 镜像 revision 漂移（dirty 但镜像停在旧 revision）→ 明确回退持久化基线并标注 stale。
    presence.upsert("session-1", user, {
      leaseId: "lease-1", projectId: "project-1", applicationId: "app-1", applicationName: "Plant",
      surface: "scene", targetId: "scene-1", targetName: "Line", persistedRevision: 7,
      draftRevision: 12, dirty: true, selectionCount: 1,
      draftMirror: {
        sceneId: "scene-1", revision: 11, objects: [], selectionSets: [], spatialRelations: [],
      },
    });
    const staleMirror = await app.inject({
      method: "POST", url: "/api/mcp",
      payload: { jsonrpc: "2.0", id: 4, method: "resources/read",
        params: { uri: `studio://active-editor/session-1/scene-context/scene-objects?revision=12&persistedRevision=7&page=0` } },
    });
    expect(staleMirror.statusCode).toBe(200);
    const staleContent = JSON.parse(staleMirror.json().result.contents[0].text);
    expect(staleContent).toMatchObject({ source: "persisted-editor-base", draftMirrorState: "stale", activeDraftRevision: 12 });

    // 镜像 sceneId 与活跃场景不符同样不可信。
    presence.upsert("session-1", user, {
      leaseId: "lease-1", projectId: "project-1", applicationId: "app-1", applicationName: "Plant",
      surface: "scene", targetId: "scene-1", targetName: "Line", persistedRevision: 7,
      draftRevision: 12, dirty: true, selectionCount: 1,
      draftMirror: { sceneId: "scene-2", revision: 12, objects: [], selectionSets: [], spatialRelations: [] },
    });
    const wrongScene = await app.inject({
      method: "POST", url: "/api/mcp",
      payload: { jsonrpc: "2.0", id: 5, method: "resources/read",
        params: { uri: `studio://active-editor/session-1/scene-context/scene-objects?revision=12&persistedRevision=7&page=0` } },
    });
    expect(JSON.parse(wrongScene.json().result.contents[0].text)).toMatchObject({
      source: "persisted-editor-base", draftMirrorState: "unavailable",
    });
  });

  it("rejects invalid draft mirrors at the presence boundary instead of storing them", async () => {
    const user = {
      id: "editor-1", username: "editor", displayName: "Editor", role: "editor" as const,
      projectIds: ["project-1"], enabled: true, createdAt: "now", updatedAt: "now",
    };
    const presence = new EditorPresenceRegistry();
    const app = createApiServer();
    cleanups.push(() => app.close());
    app.addHook("preHandler", async request => { request.systemUser = user; });
    await registerEditorPresenceRoutes(app, presence);

    const rejected = await app.inject({
      method: "PUT", url: "/api/editor-presence/session-1",
      payload: {
        leaseId: "lease-1", projectId: "project-1", applicationId: "app-1", applicationName: "Plant",
        surface: "scene", targetId: "scene-1", persistedRevision: 7, draftRevision: 11, dirty: true, selectionCount: 1,
        draftMirror: { sceneId: "scene-1", revision: 11, objects: [{ objectId: "broken" }], selectionSets: [], spatialRelations: [] },
      },
    });
    expect(rejected.statusCode).toBe(200);
    expect(presence.readOwned(user, "session-1")?.draftMirror).toBeUndefined();
    // 合法镜像正常存储。
    const accepted = await app.inject({
      method: "PUT", url: "/api/editor-presence/session-1",
      payload: {
        leaseId: "lease-1", projectId: "project-1", applicationId: "app-1", applicationName: "Plant",
        surface: "scene", targetId: "scene-1", persistedRevision: 7, draftRevision: 11, dirty: true, selectionCount: 1,
        draftMirror: { sceneId: "scene-1", revision: 11, objects: [], selectionSets: [], spatialRelations: [] },
      },
    });
    expect(accepted.statusCode).toBe(200);
    expect(presence.readOwned(user, "session-1")?.draftMirror).toMatchObject({ sceneId: "scene-1", revision: 11 });
  });
});
