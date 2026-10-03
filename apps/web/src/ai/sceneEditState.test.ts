import { describe, expect, it } from "vitest";
import type { SceneCommand } from "@bim-studio/scene-sdk";
import { readSceneState, sceneAuthorFingerprint, simulateSceneCommands, verifyExpectedFacts, type SceneStateSnapshot } from "./sceneEditState";

const obj = (id: string, extra: Partial<SceneStateSnapshot["objects"][number]> = {}) => ({
  id, name: `设备${id}`, kind: "primitive" as const, visible: true, position: [0, 0, 0] as [number, number, number],
  rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number], color: "#112233", ...extra,
});
const base = (): SceneStateSnapshot => ({
  sceneId: "s", objects: [obj("a"), obj("b", { kind: "model", position: [1, 2, 3] })],
  camera: { position: [0, 0, 8], target: [0, 0, 0] }, lighting: { enabled: true, intensity: 1 }, environment: { weather: "sunny", backgroundColor: "#000000" },
});
const ref = (id: string) => ({ kind: "object" as const, sceneId: "s", objectId: id });

describe("scene edit simulation & diff", () => {
  it("reports field-level before/after values and keeps the input snapshot untouched", () => {
    const before = base();
    const commands: SceneCommand[] = [
      { id: "1", type: "object.set-transform", target: ref("a"), position: [4, 0, 0], rotation: [0, Math.PI / 2, 0] },
      { id: "2", type: "material.set", target: ref("a"), patch: { color: "#F00", roughness: 0.4 } },
      { id: "3", type: "lighting.set", sceneId: "s", patch: { intensity: 1.5 } },
    ];
    const { diff, after } = simulateSceneCommands(commands, before);
    expect(diff.blockers).toEqual([]);
    // 同一对象的变换与材质并入一条;前值取自改动前状态,材质的新键没有前值。
    expect(diff.entries).toHaveLength(2);
    expect(diff.entries[0]!.fields).toEqual([
      { key: "position", label: "位置", before: "(0, 0, 0)", after: "(4, 0, 0)" },
      { key: "rotation", label: "旋转", before: "(0°, 0°, 0°)", after: "(0°, 90°, 0°)" },
      { key: "color", label: "颜色", before: "#112233", after: "#ff0000" },
      { key: "roughness", label: "粗糙度", after: "0.4" },
    ]);
    expect(diff.entries[1]!.fields[0]).toMatchObject({ label: "强度", before: "1", after: "1.5" });
    expect(after.objects[0]!.position).toEqual([4, 0, 0]);
    expect(before.objects[0]!.position).toEqual([0, 0, 0]);
  });

  it("later commands see earlier results: create then transform; delete counts", () => {
    const { diff } = simulateSceneCommands([
      { id: "c", type: "object.create-primitive", target: ref("n"), name: "新方块", kind: "box", color: "#00ff00" },
      { id: "t", type: "object.set-transform", target: ref("n"), position: [1, 1, 1] },
      { id: "d", type: "object.delete-primitive", target: ref("a") },
    ], base());
    expect(diff.blockers).toEqual([]);
    // 新建对象的后续变换并入同一条新增,不再单列一条修改。
    expect(diff.counts).toEqual({ add: 1, modify: 0, delete: 1, action: 0 });
    expect(diff.entries[0]!.fields).toEqual([{ key: "kind", label: "形状", after: "box" }, { key: "color", label: "颜色", after: "#00ff00" }, { key: "position", label: "位置", after: "(1, 1, 1)" }]);
  });

  it("blocks missing targets, locked objects, non-primitive deletion and unsupported scopes", () => {
    const state = base(); state.objects[0]!.locked = true;
    const { diff } = simulateSceneCommands([
      { id: "1", type: "object.set-visibility", target: ref("ghost"), visible: false },
      { id: "2", type: "material.set", target: ref("a"), patch: { color: "#fff" } },
      { id: "3", type: "object.delete-primitive", target: ref("b") },
      { id: "4", type: "object.set-transform", target: { kind: "scene", sceneId: "s" }, position: [0, 0, 0] },
    ], state);
    expect(diff.blockers).toHaveLength(4);
    expect(diff.blockers.join("|")).toMatch(/ghost.*不存在/);
  });

  it("flags irreversible runtime effects and no-op transforms", () => {
    const { diff } = simulateSceneCommands([
      { id: "1", type: "animation.control", target: ref("a"), action: "play" },
      { id: "2", type: "object.set-transform", target: ref("a"), position: [0, 0, 0] },
    ], base());
    expect(diff.irreversibleCount).toBe(1);
    expect(diff.entries[1]!.noop).toBe(true);
  });

  it("verifies expected facts against actual readback and pinpoints mismatches", () => {
    const before = base();
    const sim = simulateSceneCommands([
      { id: "1", type: "object.set-transform", target: ref("a"), position: [4, 0, 0] },
      { id: "2", type: "object.set-visibility", target: ref("b"), visible: false },
      { id: "3", type: "object.delete-primitive", target: ref("a") },
    ], before);
    const actual = structuredClone(sim.after);
    expect(verifyExpectedFacts(sim.expected, actual, sim.after).every(check => check.ok)).toBe(true);
    actual.objects.find(item => item.id === "b")!.visible = true;
    const bad = verifyExpectedFacts(sim.expected, actual, sim.after).filter(check => !check.ok);
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatchObject({ label: "设备b · 可见性", expected: "否", actual: "是" });
  });

  it("fingerprints author state, ignoring camera/selection and sub-millimetre noise", () => {
    const a = base(), b = structuredClone(a);
    b.camera.position = [9, 9, 9]; b.selection = "a"; b.objects[0]!.position = [0.00001, 0, 0];
    expect(sceneAuthorFingerprint(a)).toBe(sceneAuthorFingerprint(b));
    b.objects[0]!.visible = false;
    expect(sceneAuthorFingerprint(a)).not.toBe(sceneAuthorFingerprint(b));
  });

  it("reads state from an engine-shaped source", () => {
    const state = readSceneState({
      listModels: () => [{ id: "a", name: "A", kind: "primitive", visible: true }],
      getModelTransform: () => ({ position: { x: 1, y: 2, z: 3 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }),
      getModelMaterialState: () => ({ color: "#ABC", roughness: 0.5 }),
      getCameraState: () => ({ position: { x: 0, y: 0, z: 5 }, target: { x: 0, y: 0, z: 0 } }),
      getWeather: () => "fog", getSelected: () => ({ id: "a" }), isModelLocked: () => true,
    }, "s");
    expect(state.objects[0]).toMatchObject({ position: [1, 2, 3], color: "#aabbcc", roughness: 0.5, locked: true });
    expect(state).toMatchObject({ selection: "a", environment: { weather: "fog" } });
  });
});
