import { afterEach, describe, expect, it } from "vitest";
import { commitSceneCommandTransaction, prepareSceneCommandTransaction, type SceneCommand } from "@bim-studio/scene-sdk";
import { SceneCommandExecutor } from "../behavior/SceneCommandExecutor";
import { ViewerSceneCommandPort } from "../behavior/ViewerSceneCommandPort";
import { EditorSceneWriteDriver, runEditorSceneTransaction } from "./editorSceneWriteDriver";
import { primitiveCreationHarness } from "./editorPrimitiveCreation.testUtils";

const target = (id = "new") => ({ kind: "object" as const, sceneId: "s", objectId: id });
const create = (id = "new"): SceneCommand => ({ id: `create-${id}`, type: "object.create-primitive", target: target(id), name: "设备", kind: "box", color: "#1683ff" });
const request = (commands: readonly unknown[], baseRevision = 0) => ({ requestId: "req", transaction: { id: "tx", sceneId: "s", baseRevision,
  module: { id: "author", capabilities: ["studio.object" as const], permissions: ["scene.write" as const] }, commands } });
const cleanup: Array<() => void> = [];
const fixture = () => { const f = primitiveCreationHarness(); cleanup.push(f.cleanup); return f; };
afterEach(() => { cleanup.splice(0).forEach(dispose => dispose()); });

describe("actual author primitive command consumer", () => {
  it("creates actual cached geometry/material, transforms and persists existing PrimitiveState", async () => {
    const f = fixture();
    const outcome = await runEditorSceneTransaction(f.host, request([create(), { id: "move", type: "object.set-transform", target: target(), position: [4, 2, -3], scale: [2, 1, .5] }]));
    expect(outcome.status).toBe("committed");
    const mesh = f.mesh("new");
    expect(mesh.geometry.getAttribute("position").count).toBeGreaterThan(0);
    expect(mesh.geometry).toBe(f.primitiveGeometryCache.get("box"));
    expect(mesh.material.color.getHexString()).toBe("1683ff");
    expect(mesh.material.roughness).toBe(.72); expect(mesh.material.metalness).toBe(.05);
    const saved = f.snapshot().primitives[0]!;
    expect(saved).toMatchObject({ modelId: "new", name: "设备", kind: "box", color: "#1683ff", transform: { position: { x: 4, y: 2, z: -3 }, scale: { x: 2, y: 1, z: .5 } } });
    mesh.position.x = 99;
    expect(f.snapshot().primitives[0]!.transform.position.x).toBe(4);
    f.engine.applyModelState("new", saved);
    expect(mesh.position.toArray()).toEqual([4, 2, -3]);
  });
  it("preserves existing object and selection on duplicate ID", async () => {
    const f = fixture(), original = f.original;
    expect((await runEditorSceneTransaction(f.host, request([create("instance")]))).status).toBe("rolled-back");
    expect(f.models.get("instance")).toBe(original); expect(f.controls.selected).toBe("instance");
    expect(f.primitiveGeometryCache.size()).toBe(0);
  });
  it("rolls back created object, author transform and selected layer on later unsupported command", async () => {
    const f = fixture();
    const outcome = await runEditorSceneTransaction(f.host, request([create(), { id: "parent", type: "object.set-parent", target: target(), parentId: null }]));
    expect(outcome.status).toBe("rolled-back"); expect(f.models.has("new")).toBe(false);
    expect(f.authorModelTransforms.has("new")).toBe(false); expect(f.modelRoot.children).toEqual([f.original.object]);
    expect(f.controls.selected).toBe("instance"); expect(f.controls.selectedLayer).toBe("root/0");
    expect(f.snapshot().primitives).toEqual([]);
  });
  it("uses SDK cancellation after apply and idempotent owned rollback", async () => {
    const f = fixture(), signal = new AbortController();
    const preparation = prepareSceneCommandTransaction(request([create()]).transaction);
    if (preparation.status !== "prepared") throw Error("prepare failed");
    const driver = new EditorSceneWriteDriver({ sceneId: "s", viewer: f.engine, port: new ViewerSceneCommandPort(f.engine), readRevision: f.host.readRevision,
      bumpRevision: () => { f.host.bumpRevision(); signal.abort(); } }, f.engine);
    expect((await commitSceneCommandTransaction(preparation.plan, driver, signal.signal)).status).toBe("rolled-back");
    driver.rollback({ plan: preparation.plan, applied: [] });
    expect(f.models.has("new")).toBe(false); expect(f.models.get("instance")).toBe(f.original);
    expect(f.controls.selectedLayer).toBe("root/0");
  });
  it("rejects stale CAS without creating resources", async () => {
    const f = fixture(); f.host.bumpRevision();
    expect((await runEditorSceneTransaction(f.host, request([create()]))).status).toBe("rejected");
    expect(f.primitiveGeometryCache.size()).toBe(0); expect(f.models.size).toBe(1);
  });
  it("cleans up registration before a creation adapter throws", async () => {
    const f = fixture(), port = new ViewerSceneCommandPort(f.engine), actual = port.createPrimitive.bind(port);
    port.createPrimitive = command => { actual(command); throw new Error("adapter failure after registration"); };
    expect((await runEditorSceneTransaction({ ...f.host, port }, request([create()]))).status).toBe("rolled-back");
    expect(f.models.has("new")).toBe(false); expect(f.authorModelTransforms.has("new")).toBe(false);
    expect(f.controls.selectedLayer).toBe("root/0");
  });
  it("old ports explicitly refuse creation and mismatched scenes never reach Viewer", async () => {
    const f = fixture(), port = new ViewerSceneCommandPort(f.engine);
    const executor = new SceneCommandExecutor("s", port);
    const command = create() as Extract<SceneCommand, { type: "object.create-primitive" }>;
    expect((await executor.execute([{ ...command, target: { ...target(), sceneId: "wrong" } }]))[0]).toMatchObject({ success: false, code: "scene-mismatch" });
    Object.defineProperty(port, "createPrimitive", { value: undefined });
    expect((await executor.execute([command]))[0]).toMatchObject({ success: false, code: "unsupported" });
    expect(f.models.size).toBe(1);
  });
  it("does not remove a same-ID replacement while rolling back", async () => {
    const f = fixture(), driver = new EditorSceneWriteDriver({ sceneId: "s", viewer: f.engine, port: new ViewerSceneCommandPort(f.engine), readRevision: f.host.readRevision, bumpRevision: f.host.bumpRevision }, f.engine);
    await driver.apply([create()]);
    const replacement = { ...f.models.get("new")!, name: "replacement" }; f.models.set("new", replacement);
    const prepared = prepareSceneCommandTransaction(request([create()]).transaction);
    if (prepared.status !== "prepared") throw Error("prepare failed");
    expect(() => driver.rollback({ plan: prepared.plan, applied: [] })).toThrow("已被替换");
    expect(f.models.get("new")).toBe(replacement);
  });
  it("captures ownership before load microtasks replace the same ID", async () => {
    const f = fixture(), port = new ViewerSceneCommandPort(f.engine), actual = port.createPrimitive.bind(port);
    let replacement: ReturnType<typeof f.engine.createPrimitive> | undefined;
    port.createPrimitive = command => {
      const outcome = actual(command);
      queueMicrotask(() => {
        f.engine.removeModel("new");
        replacement = f.engine.createPrimitive("new", "用户替换", "sphere", "#55aa77");
      });
      return outcome;
    };
    const outcome = await runEditorSceneTransaction({ ...f.host, port }, request([create(), { id: "parent", type: "object.set-parent", target: target(), parentId: null }]));
    expect(outcome.status).toBe("failed"); expect(outcome.issue).toMatchObject({ reason: "rollback-failed" });
    expect(f.models.get("new")).toBe(replacement); expect(replacement!.name).toBe("用户替换");
    expect(f.models.get("instance")).toBe(f.original); expect(f.mesh("new").material.color.getHexString()).toBe("55aa77");
  });
});
