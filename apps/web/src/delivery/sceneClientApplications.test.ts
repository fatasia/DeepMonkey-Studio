import { describe, expect, it } from "vitest";
import { migrateSceneSnapshotV1, type ApplicationDocument, type SceneSnapshot } from "@bim-studio/contracts";
import { selectSceneClientApplications } from "./sceneClientApplications";

function scene(id = "root"): SceneSnapshot {
  return { schemaVersion: 1, projectId: "project", id, name: id, models: [], primitives: [], measurements: [],
    camera: { mode: "orbit", position: { x: 0, y: 1, z: 5 }, target: { x: 0, y: 0, z: 0 } }, createdAt: "2026-09-15", updatedAt: "2026-09-15" };
}
function fixture() {
  const root = scene(), app = migrateSceneSnapshotV1(root), other = migrateSceneSnapshotV1(scene("other"));
  app.pages.push({ ...structuredClone(other.pages[0]!), id: "other-page" });
  app.scenes.push(other.scenes[0]!);
  app.publicationProfiles.push({ id: "other-profile", name: "Other", target: "server-web", entryPageId: "other-page", renderer: "auto" });
  return { root, app };
}
function link(app: ApplicationDocument, from: string, to: string, enabled = true) {
  app.interactions.push({ id: `flow-${app.interactions.length}`, name: "Link", enabled: true, source: { kind: "page", id: from }, trigger: "click",
    actions: [{ id: "open", type: "dashboard", enabled, dashboardPageId: to }] });
}
describe("scene client application closure", () => {
  it("uses real migration roots, trims unrelated pages/profiles/scenes and does not mutate input", () => {
    const { root, app } = fixture(), before = structuredClone(app);
    const result = selectSceneClientApplications(root, [app, migrateSceneSnapshotV1(scene("unrelated"))]);
    expect(result.unresolved).toEqual([]);
    expect(result.applications).toHaveLength(1);
    expect(result.applications[0]!.pages.map(page => page.id)).toEqual(["page:root"]);
    expect(result.applications[0]!.scenes.map(value => value.id)).toEqual(["root"]);
    expect(result.applications[0]!.publicationProfiles).toHaveLength(2);
    expect(app).toEqual(before);
  });
  it("closes enabled cyclic page navigation and viewport scenes", () => {
    const { root, app } = fixture(); link(app, "page:root", "other-page"); link(app, "other-page", "page:root");
    const selected = selectSceneClientApplications(root, [app]).applications[0]!;
    expect(selected.pages).toHaveLength(2); expect(selected.scenes).toHaveLength(2); expect(selected.interactions).toHaveLength(2);
  });
  it("does not follow disabled actions or keep profiles that point to unrelated pages", () => {
    const { root, app } = fixture(); link(app, "page:root", "other-page", false);
    expect(selectSceneClientApplications(root, [app]).applications[0]!.pages).toHaveLength(1);
  });
  it("includes explicitly navigated scenes without pulling unrelated publication profiles", () => {
    const { root, app } = fixture();
    app.interactions.push({ id: "navigate", name: "Navigate", source: { kind: "scene", id: "root" }, enabled: true, trigger: "click",
      actions: [{ id: "go", type: "navigateScene", enabled: true, sceneId: "other" }] });
    const selected = selectSceneClientApplications(root, [app]).applications[0]!;
    expect(selected.scenes.map(value => value.id)).toEqual(["root", "other"]);
    expect(selected.pages).toHaveLength(1);
  });
  it("returns an empty selection for unrelated applications", () => {
    expect(selectSceneClientApplications(scene(), [migrateSceneSnapshotV1(scene("unrelated"))])).toEqual({ applications: [], unresolved: [] });
  });
  it("rejects root navigation whose scene identity has multiple application owners", () => {
    const root = scene(), first = migrateSceneSnapshotV1(scene("target")), second = structuredClone(first);
    first.metadata.id = "first"; second.metadata.id = "second"; second.scenes[0]!.name = "Conflicting content";
    root.interactions = [{ id: "navigate", name: "Navigate", enabled: true, trigger: "load", target: { kind: "object", modelId: "root-object" }, code: "",
      actions: [{ id: "go", type: "navigateScene", enabled: true, sceneId: "target" }] }];
    expect(() => selectSceneClientApplications(root, [first, second])).toThrow(/scene.actions.sceneId\(target\).*跨应用歧义/);
  });
  it("replaces stale application root content before returning the dependency selection", () => {
    const { root, app } = fixture(); app.scenes[0]!.name = "Stale root";
    app.scenes[0]!.camera.position.x = 999;
    const selected = selectSceneClientApplications(root, [app]).applications[0]!;
    expect(selected.scenes[0]).toEqual(migrateSceneSnapshotV1(root).scenes[0]);
    expect(app.scenes[0]!.name).toBe("Stale root");
  });
  it("rejects old object interactions against the saved root after that object was removed", () => {
    const { root, app } = fixture();
    app.scenes[0]!.primitives = [{ modelId: "removed", kind: "box", name: "Old", visible: true, opacity: 1, color: "#ffffff",
      transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } }];
    app.interactions.push({ id: "stale", name: "Stale", enabled: true, trigger: "click",
      source: { kind: "object", sceneId: "root", modelId: "removed" }, actions: [] });
    expect(() => selectSceneClientApplications(root, [app])).toThrow(/applications\[root\].interactions\[0\].source.*场景对象不存在/);
  });
  it("selects a page-only application through the root scene dashboard action", () => {
    const root = scene(), app = migrateSceneSnapshotV1(scene("other"));
    delete app.metadata.source; app.scenes = []; app.pages[0]!.nodes = [];
    root.interactions = [{ id: "open", name: "Open", enabled: true, trigger: "load", target: { kind: "object", modelId: "root-object" }, code: "",
      actions: [{ id: "open", type: "dashboard", enabled: true, dashboardPageId: "page:other" }] }];
    expect(selectSceneClientApplications(root, [app]).applications[0]!.pages).toHaveLength(1);
  });
  it("includes inherited spatial levels and their page/scene dependencies", () => {
    const { root, app } = fixture();
    app.spatialNavigation = { cacheLimit: 1, rootNodeIds: ["campus"], nodes: [
      { id: "campus", name: "Campus", kind: "campus", sceneId: "root", loadPolicy: "focus" },
      { id: "floor", name: "Floor", kind: "floor", parentId: "campus", dashboardPageId: "other-page", loadPolicy: "focus" },
    ] };
    const selected = selectSceneClientApplications(root, [app]).applications[0]!;
    expect(selected.pages).toHaveLength(2); expect(selected.scenes).toHaveLength(2); expect(selected.spatialNavigation!.nodes).toHaveLength(2);
  });
  it("keeps the selected spatial branch and ancestors without unrelated roots or ancestor siblings", () => {
    const { root, app } = fixture();
    app.scenes.push(migrateSceneSnapshotV1(scene("sibling")).scenes[0]!);
    app.spatialNavigation = { cacheLimit: 1, rootNodeIds: ["campus", "unrelated"], nodes: [
      { id: "campus", name: "Campus", kind: "campus", sceneId: "other", loadPolicy: "focus" },
      { id: "active", name: "Active", kind: "floor", parentId: "campus", sceneId: "root", loadPolicy: "focus" },
      { id: "child", name: "Child", kind: "device", parentId: "active", loadPolicy: "focus" },
      { id: "sibling", name: "Sibling", kind: "floor", parentId: "campus", sceneId: "sibling", loadPolicy: "focus" },
      { id: "unrelated", name: "Unrelated", kind: "campus", sceneId: "sibling", loadPolicy: "focus" },
    ] };
    const selected = selectSceneClientApplications(root, [app]).applications[0]!;
    expect(selected.spatialNavigation!.nodes.map(node => node.id)).toEqual(["campus", "active", "child"]);
    expect(selected.spatialNavigation!.rootNodeIds).toEqual(["campus"]);
    expect(selected.scenes.map(value => value.id)).toEqual(["root", "other"]);
  });
  it("fills an explicitly referenced root viewport from the saved scene when the application omits it", () => {
    const { root, app } = fixture(); app.scenes = app.scenes.filter(value => value.id !== root.id);
    const selected = selectSceneClientApplications(root, [app]).applications[0]!;
    expect(selected.scenes).toEqual([migrateSceneSnapshotV1(root).scenes[0]]);
    expect(selected.scenes[0]).not.toHaveProperty("schemaVersion");
    expect(selected.scenes[0]).not.toHaveProperty("projectId");
    expect(app.scenes.some(value => value.id === root.id)).toBe(false);
  });
  it("terminates spatial parent cycles using the selected-node set", () => {
    const { root, app } = fixture();
    app.spatialNavigation = { rootNodeIds: ["a"], cacheLimit: 1, nodes: [
      { id: "a", name: "A", kind: "floor", parentId: "b", sceneId: "root", loadPolicy: "focus" },
      { id: "b", name: "B", kind: "floor", parentId: "a", loadPolicy: "focus" },
    ] };
    expect(selectSceneClientApplications(root, [app]).applications[0]!.spatialNavigation!.nodes).toHaveLength(2);
  });
  it.each(["cross-project", "missing-page", "missing-scene", "duplicate-page", "missing-parent", "missing-source"])("rejects %s with an identifiable path", condition => {
    const { root, app } = fixture();
    if (condition === "cross-project") app.metadata.projectId = "foreign";
    if (condition === "missing-page") link(app, "page:root", "absent");
    if (condition === "missing-scene") app.pages[0]!.nodes[0] = { ...app.pages[0]!.nodes[0]!, sceneId: "absent" } as typeof app.pages[0]["nodes"][number];
    if (condition === "duplicate-page") app.pages.push(app.pages[0]!);
    if (condition === "missing-parent") app.spatialNavigation = { cacheLimit: 1, rootNodeIds: ["node"], nodes: [{ id: "node", name: "Node", kind: "floor", parentId: "absent", loadPolicy: "focus" }] };
    if (condition === "missing-source") link(app, "absent", "page:root");
    expect(() => selectSceneClientApplications(root, [app])).toThrow(/applications\[root\]/);
  });
  it("preserves all associated pages for opaque enabled scripts and returns an explicit unresolved reason", () => {
    const { root, app } = fixture();
    app.scripts.push({ id: "script", name: "Script", enabled: true, runtime: "legacy-trusted-main-thread", apiVersion: "1.0", entrypoint: "behavior",
      code: "executeSomething()", lifecycle: [], capabilities: [], permissions: [] });
    const result = selectSceneClientApplications(root, [app]);
    expect(result.applications[0]!.pages).toHaveLength(2);
    expect(result.unresolved[0]).toMatchObject({ applicationId: "root", path: "applications[root].scripts[0]" });
  });
  it.each(["scene.read", "scene.write"] as const)("uses the enforced worker permission boundary for %s", permission => {
    const { root, app } = fixture();
    app.scripts.push({ id: "worker", name: "Worker", enabled: true, runtime: "worker-sandbox", apiVersion: "1.0", entrypoint: "behavior",
      code: "opaqueCode()", lifecycle: [], capabilities: ["studio.scene"], permissions: [permission] });
    const selected = selectSceneClientApplications(root, [app]);
    expect(selected.unresolved.length).toBe(permission === "scene.read" ? 0 : 1);
    expect(selected.applications[0]!.pages.length).toBe(permission === "scene.read" ? 1 : 2);
  });
});
