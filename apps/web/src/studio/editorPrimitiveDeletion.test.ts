import { afterEach, describe, expect, it } from "vitest";
import { commitSceneCommandTransaction, parseSceneCommand, prepareSceneCommandTransaction, validateSceneCommand } from "@bim-studio/scene-sdk";
import { EditorSceneWriteDriver, runEditorSceneTransaction } from "./editorSceneWriteDriver";
import { ViewerSceneCommandPort } from "../behavior/ViewerSceneCommandPort";
import { deletionFixture } from "./editorPrimitiveDeletion.testUtils";
import { primitiveDeletionReferenceError } from "./editorPrimitiveDeleteAuthoring";

const command = { id: "delete", type: "object.delete-primitive", target: { kind: "object", sceneId: "s", objectId: "victim" } };
const request = (commands: unknown[] = [command]) => ({ requestId: "req", transaction: { id: "tx", sceneId: "s", baseRevision: 0,
  module: { id: "author", capabilities: ["studio.object" as const], permissions: ["scene.write" as const] }, commands } });
const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).reverse().forEach(dispose => dispose()));
const fixture = () => { const f = deletionFixture(); cleanup.push(f.cleanup); return f; };
describe("single author primitive deletion candidate", () => {
  it("validates object-only commands and existing scope/permission gates", () => {
    expect(validateSceneCommand(command).valid).toBe(true);
    expect(validateSceneCommand({ ...command, target: { kind: "scene", sceneId: "s" } }).valid).toBe(false);
    expect(validateSceneCommand({ ...command, force: true }).valid).toBe(false);
    expect(prepareSceneCommandTransaction({ ...request().transaction, module: { id: "a", capabilities: [], permissions: ["scene.write"] } }).status).toBe("rejected");
    expect(prepareSceneCommandTransaction(request([{ ...command, target: { ...command.target, sceneId: "wrong" } }]).transaction).status).toBe("rejected");
  });
  it("consumes real controller cleanup, cached resources, snapshot and existing undo", async () => {
    const f = fixture();
    expect((await runEditorSceneTransaction({ ...f.host, authoring: f.authoring }, request())).status).toBe("committed");
    expect(f.models.has("victim")).toBe(false); expect(f.models.has("keep")).toBe(true);
    expect(f.context.primitiveColors.current.has("victim")).toBe(false); expect(f.annotations.has("victim")).toBe(false);
    expect(f.context.sceneInteractions.map(item => item.id)).toEqual(["keep"]); expect(f.context.sceneDataBindings.map(item => item.id)).toEqual(["keep"]);
    expect(f.context.selectedAnnotationId).toBeUndefined(); expect(f.mesh("keep").geometry).toBe(f.sharedGeometry);
    expect(f.history.getState().canUndo).toBe(true);
    const before = f.history.undo()!; await f.authoring.restore(before);
    expect(f.models.has("victim")).toBe(true); expect(f.capture().primitives.map(p => p.modelId)).toContain("victim");
    expect(f.context.sceneInteractions.map(item => item.id)).toEqual(["victim", "keep"]);
    expect(f.context.sceneDataBindings.map(item => item.id)).toEqual(["victim", "keep"]); expect(f.annotations.has("victim")).toBe(true);
    expect(f.mesh("victim").material.color.getHexString()).toBe("1683ff");
  });
  it("cancels through existing SDK and restores actual author snapshot without an undo entry", async () => {
    const f = fixture(), abort = new AbortController(), prepared = prepareSceneCommandTransaction(request().transaction);
    if (prepared.status !== "prepared") throw Error("prepare failed");
    const driver = new EditorSceneWriteDriver({ sceneId: "s", viewer: f.engine, port: new ViewerSceneCommandPort(f.engine, undefined, id => { f.authoring.remove(id); abort.abort(); }),
      authoring: f.authoring, readRevision: f.host.readRevision, bumpRevision: f.host.bumpRevision }, f.engine);
    expect((await commitSceneCommandTransaction(prepared.plan, driver, abort.signal)).status).toBe("rolled-back");
    expect(f.models.has("victim")).toBe(true); expect(f.annotations.has("victim")).toBe(true);
    expect(f.context.sceneInteractions.map(item => item.id)).toEqual(["victim", "keep"]);
    expect(f.history.getState().canUndo).toBe(false); expect(f.open.current).toBeUndefined();
  });
  it("refuses locked and unconnected deletion without restoring or removing resources", async () => {
    const f = fixture(); f.engine.isModelLocked = () => true;
    expect((await runEditorSceneTransaction({ ...f.host, authoring: f.authoring }, request())).status).toBe("rolled-back");
    expect(f.models.get("victim")).toBe(f.original); expect(f.authoring.restore).not.toHaveBeenCalled();
    expect((await new ViewerSceneCommandPort(f.engine).deletePrimitive(command.target as never)).status).toBe("unsupported");
  });
  it("preserves a same-ID microtask replacement when SDK cancellation rolls back deletion", async () => {
    const f = fixture(), abort = new AbortController(), prepared = prepareSceneCommandTransaction(request().transaction);
    if (prepared.status !== "prepared") throw Error("prepare failed");
    let replacement: unknown;
    const driver = new EditorSceneWriteDriver({ sceneId: "s", viewer: f.engine, port: new ViewerSceneCommandPort(f.engine, undefined, id => {
      f.authoring.remove(id);
      queueMicrotask(() => { f.engine.createPrimitive(id, "replacement", "sphere", "#eeaa33"); replacement = f.models.get(id); abort.abort(); });
    }), authoring: f.authoring, readRevision: f.host.readRevision, bumpRevision: f.host.bumpRevision }, f.engine);
    const result = await commitSceneCommandTransaction(prepared.plan, driver, abort.signal);
    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw Error("expected failed rollback");
    expect(result.issue.reason).toBe("rollback-failed");
    expect(f.models.get("victim")).toBe(replacement); expect(replacement).not.toBe(f.original);
    expect(f.models.get("victim")?.name).toBe("replacement"); expect(f.authoring.restore).not.toHaveBeenCalled();
    expect(f.open.current).toBeUndefined(); expect(f.history.getState().canUndo).toBe(false);
  });
  it("executes a mixed batch with creation and deletion, committed without snapshot restore", async () => {
    const f = fixture();
    const result = await runEditorSceneTransaction({ ...f.host, authoring: f.authoring }, request([
      { id: "mk", type: "object.create-primitive", target: { kind: "object", sceneId: "s", objectId: "mixed-box" }, name: "mixed", kind: "box", color: "#334455" },
      command,
    ]));
    expect(result.status).toBe("committed");
    expect(f.models.has("victim")).toBe(false);
    expect(f.models.has("mixed-box")).toBe(true);
    expect(f.annotations.has("victim")).toBe(false);
    expect(f.authoring.restore).not.toHaveBeenCalled();
  });

  it("rolls back a mixed batch atomically: inverse ops first, then author snapshot", async () => {
    const f = fixture();
    const result = await runEditorSceneTransaction({ ...f.host, authoring: f.authoring }, request([
      { id: "mk", type: "object.create-primitive", target: { kind: "object", sceneId: "s", objectId: "mixed-box" }, name: "mixed", kind: "box", color: "#334455" },
      command,
      { id: "mv", type: "object.set-transform", target: { kind: "object", sceneId: "s", objectId: "ghost" }, position: [1, 2, 3] },
    ]));
    expect(result.status).toBe("rolled-back");
    expect(f.models.has("mixed-box")).toBe(false);
    expect(f.models.has("victim")).toBe(true);
    expect(f.mesh("victim").material.color.getHexString()).toBe("1683ff");
    expect(f.annotations.has("victim")).toBe(true);
    expect(f.context.sceneInteractions.map(item => item.id)).toEqual(["victim", "keep"]);
  });

  it("rolls back when a later mixed command targets the deleted object itself", async () => {
    const f = fixture();
    const result = await runEditorSceneTransaction({ ...f.host, authoring: f.authoring },
      request([command, { id: "hide", type: "object.set-visibility", target: command.target, visible: false }]));
    expect(result.status).toBe("rolled-back");
    expect(f.models.has("victim")).toBe(true);
    expect(f.mesh("victim").material.color.getHexString()).toBe("1683ff");
    expect(f.authoring.restore).toHaveBeenCalled();
  });

  it("refuses more than one deletion per transaction before any mutation", async () => {
    const f = fixture();
    f.engine.createPrimitive("victim2", "victim2", "box", "#999999");
    const result = await runEditorSceneTransaction({ ...f.host, authoring: f.authoring }, request([
      command,
      { id: "del2", type: "object.delete-primitive", target: { kind: "object", sceneId: "s", objectId: "victim2" } },
    ]));
    expect(result.status).toBe("rolled-back");
    expect(f.models.get("victim")).toBe(f.original);
    expect(f.models.has("victim2")).toBe(true);
    expect(f.annotations.has("victim")).toBe(true);
    expect(f.authoring.restore).not.toHaveBeenCalled();
  });

  it("still refuses deletion with unconsumed references before controller mutation", async () => {
    const f = fixture();
    f.context.selectionSets = [{ id: "g", name: "g", objectIds: ["victim"] }];
    expect((await runEditorSceneTransaction({ ...f.host, authoring: f.authoring }, { ...request(), transaction: { ...request().transaction, baseRevision: f.host.readRevision() } })).status).toBe("rolled-back");
    expect(f.models.get("victim")).toBe(f.original); expect(f.annotations.has("victim")).toBe(true); expect(f.authoring.restore).not.toHaveBeenCalled();
    const snapshot = { ...f.capture(), selectionSets: [] };
    expect(primitiveDeletionReferenceError({ ...snapshot, animation: { duration: 1, loop: false, camera: [], models: [{ id: "key", time: 0, modelId: "victim", transform: f.engine.getModelTransform("victim")! }] } }, "victim")).toContain("动画");
    expect(primitiveDeletionReferenceError({ ...snapshot, simulationEntities: [{ id: "link", kind: "flowLink", fromModelId: "keep", toModelId: "victim" }] }, "victim")).toContain("仿真");
  });
  it("refuses snapshot rollback over a newer revision", async () => {
    const f = fixture(), prepared = prepareSceneCommandTransaction(request().transaction);
    if (prepared.status !== "prepared") throw Error("prepare failed");
    const driver = new EditorSceneWriteDriver({ sceneId: "s", viewer: f.engine, port: new ViewerSceneCommandPort(f.engine, undefined, f.authoring.remove), authoring: f.authoring,
      readRevision: f.host.readRevision, bumpRevision: f.host.bumpRevision }, f.engine);
    await driver.apply([parseSceneCommand(command)]); f.host.bumpRevision();
    await expect(driver.rollback({ plan: prepared.plan, applied: [] })).rejects.toThrow("作者版本");
    expect(f.authoring.restore).not.toHaveBeenCalled(); expect(f.models.has("keep")).toBe(true); expect(f.open.current).toBeUndefined();
  });
});
