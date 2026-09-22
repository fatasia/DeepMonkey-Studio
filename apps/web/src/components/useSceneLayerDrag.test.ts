import type { DragEvent } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSceneLayerDrag, sceneLayerDropAllowed } from "./useSceneLayerDrag";
import { SceneLayerDragSession } from "./sceneLayerDragSession";

vi.mock("react", () => ({ useRef: () => ({ current: null }), useEffect: () => undefined }));
const objects = [{ id: "a", locked: false }, { id: "b", locked: false }, { id: "c", locked: false }];
function harness() {
  const scope = { isConnected: true, dataset: { layerOrder: '["a","b","c"]' } };
  const payload = new Map<string, string>();
  const onMoveObjects = vi.fn();
  const transfer = { types: ["application/x-scene-object-ids"], setData: (key: string, value: string) => payload.set(key, value), getData: (key: string) => payload.get(key) ?? "" };
  function event(clientY: number, owner = scope) {
    return { currentTarget: { closest: () => owner, dataset: {}, removeAttribute: vi.fn(), getBoundingClientRect: () => ({ top: 0, height: 40 }) },
      clientY, dataTransfer: transfer, preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as DragEvent<HTMLDivElement>;
  }
  const source = useSceneLayerDrag({ objectId: "b", selectedIds: new Set(["b", "a"]), organizationObjects: objects, onMoveObjects, deniedText: "拒绝" });
  const target = useSceneLayerDrag({ objectId: "c", organizationObjects: objects, onMoveObjects, deniedText: "拒绝" });
  return { source, target, event, scope, onMoveObjects, payload, transfer };
}
beforeEach(() => vi.stubGlobal("window", new EventTarget()));
afterEach(() => { useSceneLayerDrag({ deniedText: "" }).onDragEnd(); vi.unstubAllGlobals(); });

describe("scene layer drag session", () => {
  it("rejects external, cross-editor and replayed tokens", () => {
    const session = new SceneLayerDragSession<object>(), one = {}, two = {};
    expect(session.read(one, "external")).toBeUndefined();
    session.begin(one, ["b", "b", "a"], "owned");
    expect(session.read(two, "owned")).toBeUndefined(); expect(session.read(one, "wrong")).toBeUndefined();
    expect(session.read(one, "owned")).toEqual(["b", "a"]); session.cancel();
    expect(session.read(one, "owned")).toBeUndefined();
  });
  it.each([[2, "before"], [38, "after"]] as const)("commits ordered selection at y=%s as %s once", (y, position) => {
    const h = harness(); h.source.onDragStart(h.event(10)); h.target.onDrop(h.event(y));
    expect(h.onMoveObjects).toHaveBeenCalledExactlyOnceWith(["a", "b"], undefined, "c", position);
    h.target.onDrop(h.event(y)); expect(h.onMoveObjects).toHaveBeenCalledOnce();
  });
  it("accepts group center and refuses unsupported group edges", () => {
    const h = harness(); const group = useSceneLayerDrag({ groupId: "g", onMoveObjects: h.onMoveObjects, deniedText: "拒绝" });
    h.source.onDragStart(h.event(5)); group.onDrop(h.event(2)); expect(h.onMoveObjects).not.toHaveBeenCalled();
    h.source.onDragStart(h.event(5)); group.onDrop(h.event(20));
    expect(h.onMoveObjects).toHaveBeenCalledExactlyOnceWith(["a", "b"], "g", undefined, "before");
  });
  it("moves objects to group edges through root ordering and drags whole groups", () => {
    const h = harness(), onMoveRootEntries = vi.fn();
    const groups = [{ id: "g", objectIds: ["c"] }];
    const group = useSceneLayerDrag({ groupId: "g", groups, organizationObjects: objects, onMoveObjects: h.onMoveObjects, onMoveRootEntries, deniedText: "拒绝" });
    h.source.onDragStart(h.event(5)); group.onDrop(h.event(38));
    expect(onMoveRootEntries).toHaveBeenLastCalledWith([{ kind: "object", id: "a" }, { kind: "object", id: "b" }], { kind: "group", id: "g" }, "after");
    const root = useSceneLayerDrag({ objectId: "a", groups, organizationObjects: objects, onMoveRootEntries, deniedText: "拒绝" });
    group.onDragStart(h.event(20)); root.onDrop(h.event(2));
    expect(onMoveRootEntries).toHaveBeenLastCalledWith([{ kind: "group", id: "g" }], { kind: "object", id: "a" }, "before");
    expect(h.onMoveObjects).not.toHaveBeenCalled();
  });
  it("rejects dragging groups containing locked members", () => {
    const h = harness(), onMoveRootEntries = vi.fn();
    const group = useSceneLayerDrag({ groupId: "g", groups: [{ id: "g", objectIds: ["a"] }], organizationObjects: [{ id: "a", locked: true }], onMoveRootEntries, deniedText: "拒绝" });
    const event = h.event(20); group.onDragStart(event);
    expect(event.preventDefault).toHaveBeenCalledOnce(); expect(h.payload.size).toBe(0);
  });
  it.each(["Escape", "blur", "dragend"])("%s clears target state and rejects late drop", kind => {
    const h = harness(); h.source.onDragStart(h.event(5)); const over = h.event(38); h.target.onDragOver(over);
    expect(over.currentTarget.dataset.layerDrop).toBe("after");
    const cancellation = new Event(kind === "Escape" ? "keydown" : kind);
    if (kind === "Escape") Object.assign(cancellation, { key: "Escape" });
    window.dispatchEvent(cancellation); expect(over.currentTarget.dataset.layerDrop).toBeUndefined();
    h.target.onDrop(h.event(38)); expect(h.onMoveObjects).not.toHaveBeenCalled();
  });
  it("revalidates locked/deleted sources and locked destination members", () => {
    expect(sceneLayerDropAllowed(["missing"], objects)).toBe(false);
    expect(sceneLayerDropAllowed(["a", "b"], [{ id: "a", locked: true }, objects[1]!])).toBe(false);
    expect(sceneLayerDropAllowed(["a"], [{ ...objects[1]!, locked: true }, objects[0]!], ["b"])).toBe(false);
    expect(sceneLayerDropAllowed(["a"], objects, [], "a")).toBe(false);
  });
  it("rejects forged payload and disconnected editor", () => {
    const h = harness(); h.source.onDragStart(h.event(5)); h.transfer.setData(h.transfer.types[0]!, '["a"]');
    h.target.onDrop(h.event(38)); expect(h.onMoveObjects).not.toHaveBeenCalled();
    h.source.onDragStart(h.event(5)); h.scope.isConnected = false;
    h.target.onDrop(h.event(38)); expect(h.onMoveObjects).not.toHaveBeenCalled();
  });
});
