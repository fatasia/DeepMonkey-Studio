import { afterEach, describe, expect, it } from "vitest";
import { readEditorSceneRuntime, type EditorSceneRuntimeOwner } from "./editorSceneRuntimeOwner";
import { getStudioSceneRuntime, registerStudioSceneRuntime } from "./studioSceneRuntimeRegistry";
import { primitiveCreationHarness } from "./editorPrimitiveCreation.testUtils";
import { runEditorSceneTransaction } from "./editorSceneWriteDriver";
import { ViewerSnapshotReadiness } from "../viewer/viewerSnapshotReadiness";

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).reverse().forEach(dispose => dispose()));
const fixture = () => {
  const f = primitiveCreationHarness(); cleanup.push(f.cleanup);
  Object.assign(f.engine, { snapshotReadiness: new ViewerSnapshotReadiness() });
  f.engine.completeSceneSnapshotRestore(f.engine.beginSceneSnapshotRestore("s"));
  return f;
};
const ownerOf = (f: ReturnType<typeof fixture>): EditorSceneRuntimeOwner => ({ sceneId: "s", engine: f.engine, busy: false, rendererSwitching: false });
const request = { requestId: "req", transaction: { id: "tx", sceneId: "s", baseRevision: 0,
  module: { id: "author", capabilities: ["studio.object"], permissions: ["scene.write"] },
  commands: [{ id: "create", type: "object.create-primitive", target: { kind: "object", sceneId: "s", objectId: "created" }, name: "作者新对象", kind: "box", color: "#1683ff" }] } };

describe("editor presence runtime ownership", () => {
  it("writes the main author engine while same-scene registered preview remains untouched", async () => {
    const main = fixture(), preview = fixture(); cleanup.push(registerStudioSceneRuntime("s", preview.engine));
    expect(getStudioSceneRuntime("s")).toBe(preview.engine);
    const owner = { current: ownerOf(main) };
    const host = { ...main.host, viewer: () => readEditorSceneRuntime(owner.current, "s") };
    expect(host.viewer()).toBe(main.engine);
    expect((await runEditorSceneTransaction(host, request)).status).toBe("committed");
    expect(main.snapshot().primitives[0]!.modelId).toBe("created");
    expect(preview.snapshot().primitives).toEqual([]); expect(preview.models.size).toBe(1);
  });
  it("keeps a captured polling host current across an engine replacement", async () => {
    const stale = fixture(), current = fixture();
    const owner = { current: ownerOf(stale) };
    const host = { ...current.host, viewer: () => readEditorSceneRuntime(owner.current, "s") };
    owner.current = ownerOf(current);
    expect((await runEditorSceneTransaction(host, request)).status).toBe("committed");
    expect(stale.models.has("created")).toBe(false); expect(current.models.has("created")).toBe(true);
  });
  it("refuses the old scene after navigation despite a registered matching preview", async () => {
    const main = fixture(), preview = fixture(); cleanup.push(registerStudioSceneRuntime("s", preview.engine));
    const owner = { current: ownerOf(main) };
    const host = { ...main.host, viewer: () => readEditorSceneRuntime(owner.current, "s") };
    owner.current = { ...ownerOf(main), sceneId: "next" };
    expect((await runEditorSceneTransaction(host, request)).status).toBe("failed");
    expect(main.models.has("created")).toBe(false); expect(preview.models.has("created")).toBe(false);
    expect(main.host.readRevision()).toBe(0);
  });
  it("refuses an unready author engine instead of falling back to preview", async () => {
    const preview = fixture(); cleanup.push(registerStudioSceneRuntime("s", preview.engine));
    const host = { ...preview.host, viewer: () => readEditorSceneRuntime({ ...ownerOf(preview), engine: undefined }, "s") };
    expect((await runEditorSceneTransaction(host, request)).status).toBe("failed");
    expect(preview.models.has("created")).toBe(false); expect(preview.host.readRevision()).toBe(0);
  });
  it.each(["busy", "rendererSwitching"] as const)("refuses a reused engine during %s", async flag => {
    const main = fixture(), owner = { ...ownerOf(main), [flag]: true };
    expect((await runEditorSceneTransaction({ ...main.host, viewer: () => readEditorSceneRuntime(owner, "s") }, request)).status).toBe("failed");
    expect(main.models.has("created")).toBe(false);
  });
  it("requires actual matching completed snapshot restore after the active scene changes", async () => {
    const main = fixture(), owner = ownerOf(main);
    main.engine.beginSceneSnapshotRestore("s");
    expect((await runEditorSceneTransaction({ ...main.host, viewer: () => readEditorSceneRuntime(owner, "s") }, request)).status).toBe("failed");
    expect(main.models.has("created")).toBe(false);
  });
});
