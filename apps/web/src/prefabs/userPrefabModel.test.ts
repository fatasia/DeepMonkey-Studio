import { describe, expect, it } from "vitest";
import type { SceneModelState, UserPrefabDefinition, UserPrefabInstanceRecord } from "@bim-studio/contracts";
import type { PrimitiveState } from "@bim-studio/contracts";
import {
  buildUserPrefabTreeMarks,
  captureUserPrefabObjects,
  clearUserPrefabMemberOverrides,
  collectUserPrefabOverrides,
  type UserPrefabObjectState,
  diffPrefabStates,
  diffUserPrefabUpdate,
  hasUserPrefabUpdate,
  mergePrototypeWithOverrides,
  planUserPrefabInstance,
  pruneUserPrefabInstance,
  type PrefabCapturedObject,
} from "./userPrefabModel";

const transformAt = (x: number): SceneModelState["transform"] => ({
  position: { x, y: 0.4, z: 0 },
  rotation: { x: 0, y: 0, z: 0 },
  scale: { x: 0.5, y: 0.5, z: 0.5 },
});

function primitiveState(objectId: string, name: string, x: number, color = "#2f80ed"): SceneModelState & Partial<PrimitiveState> {
  return {
    modelId: objectId,
    name,
    visible: true,
    opacity: 1,
    color,
    kind: "box",
    transform: transformAt(x),
  };
}

function pumpDefinition(version = 1): UserPrefabDefinition {
  const objects = captureUserPrefabObjects([
    { objectId: "pump", name: "泵体", kind: "primitive", state: primitiveState("pump", "泵体", 0) },
    { objectId: "motor", name: "电机", kind: "primitive", state: primitiveState("motor", "电机", 2, "#278f83") },
  ]);
  return {
    id: "userprefab:pump",
    name: "卧式泵组",
    category: "泵/风机",
    version,
    createdAt: "2026-10-04T00:00:00.000Z",
    updatedAt: "2026-10-04T00:00:00.000Z",
    objects,
  };
}

function instanceRecord(definition: UserPrefabDefinition, overrides?: UserPrefabInstanceRecord["overrides"]): UserPrefabInstanceRecord {
  return {
    instanceId: "inst-1",
    prefabId: definition.id,
    prefabVersion: definition.version,
    anchor: { x: 10, y: 0.4, z: 0 },
    memberObjectIds: Object.fromEntries(definition.objects.map((object) => [object.sourceId, `scene-${object.sourceId}`])),
    ...(overrides ? { overrides } : {}),
  };
}

describe("user prefab capture", () => {
  it("computes centroid anchor and relative offsets preserving hierarchy order", () => {
    const objects = captureUserPrefabObjects([
      { objectId: "pump", name: "泵体", kind: "primitive", state: primitiveState("pump", "泵体", 0) },
      { objectId: "motor", name: "电机", kind: "primitive", state: primitiveState("motor", "电机", 2) },
    ]);
    expect(objects.map((object) => object.sourceId)).toEqual(["pump", "motor"]);
    expect(objects[0]!.offset).toEqual({ x: -1, y: 0, z: 0 });
    expect(objects[1]!.offset).toEqual({ x: 1, y: 0, z: 0 });
  });

  it("returns empty capture for empty selection", () => {
    expect(captureUserPrefabObjects([] as PrefabCapturedObject[])).toEqual([]);
  });

  it("supports explicit anchor so prototype updates do not shift other instances", () => {
    const objects = captureUserPrefabObjects([
      { objectId: "pump", name: "泵体", kind: "primitive", state: primitiveState("pump", "泵体", 1.6) },
      { objectId: "motor", name: "电机", kind: "primitive", state: primitiveState("motor", "电机", 3, "#278f83") },
    ], { x: 2, y: 0.4, z: 0 });
    expect(objects[0]!.offset.x).toBeCloseTo(-0.4, 9);
    expect(objects[0]!.state.transform.position.x).toBeCloseTo(-0.4, 9);
    expect(objects[1]!.offset.x).toBeCloseTo(1, 9);
  });
});

describe("user prefab instantiation plan", () => {
  it("places members at anchor plus offset with fresh unique ids", () => {
    const definition = pumpDefinition();
    const ids = ["aaa", "bbb"];
    let cursor = 0;
    const plans = planUserPrefabInstance(definition, { x: 10, y: 1, z: 5 }, () => ids[cursor++] ?? "fallback");
    expect(plans).toHaveLength(2);
    expect(plans[0]!.objectId).toBe("prefabinst-aaa");
    expect(plans[1]!.objectId).toBe("prefabinst-bbb");
    expect(plans[0]!.state.transform.position).toEqual({ x: 9, y: 1, z: 5 });
    expect(plans[1]!.state.transform.position).toEqual({ x: 11, y: 1, z: 5 });
    expect(plans[0]!.state.modelId).toBe("prefabinst-aaa");
    expect(plans[0]!.kind).toBe("primitive");
    expect(plans[0]!.primitiveKind).toBe("box");
  });

  it("keeps rotation and scale from prototype", () => {
    const definition = pumpDefinition();
    definition.objects[0]!.state.transform.rotation = { x: 0.2, y: 0.4, z: 0 };
    definition.objects[0]!.state.transform.scale = { x: 2, y: 1, z: 1 };
    const [plan] = planUserPrefabInstance(definition, { x: 0, y: 0, z: 0 });
    expect(plan!.state.transform.rotation).toEqual({ x: 0.2, y: 0.4, z: 0 });
    expect(plan!.state.transform.scale).toEqual({ x: 2, y: 1, z: 1 });
  });
});

describe("user prefab overrides", () => {
  it("collects path-level overrides only for properties that differ from prototype", () => {
    const definition = pumpDefinition();
    const instance = instanceRecord(definition);
    const overrides = collectUserPrefabOverrides(instance, definition, (sceneObjectId) =>
      // 锚点 {10,0.4,0}：泵体原型相对位 -1 → 场景位 9；挪到 13 并改色 = 相对位 3 与颜色两项覆盖。
      sceneObjectId === "scene-pump" ? primitiveState("scene-pump", "泵体", 13, "#ff6a22") : primitiveState("scene-motor", "电机", 11, "#278f83"));
    expect(overrides).toEqual({
      "scene-pump": {
        "transform.position.x": 3,
        color: "#ff6a22",
      },
    });
  });

  it("merge keeps prototype values and wins for overridden paths", () => {
    const definition = pumpDefinition();
    const [prototype] = definition.objects;
    const merged = mergePrototypeWithOverrides(prototype!.state, { "transform.position.x": 42, "visible": false });
    expect(merged.transform.position.x).toBe(42);
    expect(merged.visible).toBe(false);
    expect(merged.transform.position.y).toBeCloseTo(prototype!.state.transform.position.y);
  });

  it("clearing overrides for one member keeps other members", () => {
    const definition = pumpDefinition();
    const instance = instanceRecord(definition, {
      "scene-pump": { opacity: 0.5 },
      "scene-motor": { "transform.position.x": 7 },
    });
    const cleared = clearUserPrefabMemberOverrides(instance, "scene-pump");
    expect(cleared.overrides).toEqual({ "scene-motor": { "transform.position.x": 7 } });
    expect(clearUserPrefabMemberOverrides(cleared, "scene-motor").overrides).toBeUndefined();
  });

  it("prunes mappings and overrides for deleted scene objects", () => {
    const definition = pumpDefinition();
    const instance = instanceRecord(definition, { "scene-motor": { opacity: 0.5 } });
    const pruned = pruneUserPrefabInstance(instance, (id) => id !== "scene-motor");
    expect(Object.keys(pruned.memberObjectIds)).toEqual(["pump"]);
    expect(pruned.overrides).toBeUndefined();
  });
});

describe("user prefab update diff", () => {
  it("detects no-op when instance is aligned", () => {
    const definition = pumpDefinition();
    const instance = instanceRecord(definition);
    const states = new Map([
      ["scene-pump", primitiveState("scene-pump", "泵体", 9, "#2f80ed")],
      ["scene-motor", primitiveState("scene-motor", "电机", 11, "#278f83")],
    ]);
    const diff = diffUserPrefabUpdate(instance, definition, (id) => states.get(id));
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(hasUserPrefabUpdate(instance, definition)).toBe(false);
  });

  it("lists added, removed and property changes after prototype upgrade", () => {
    const definition = pumpDefinition(2);
    definition.objects = [
      { ...definition.objects[1]!, state: { ...definition.objects[1]!.state, opacity: 0.8, color: "#ff6a22" } },
      { sourceId: "gauge", name: "压力表", kind: "primitive", offset: { x: 0, y: 1, z: 0 },
        state: { visible: true, opacity: 1, kind: "sphere", color: "#35b7a2", transform: transformAt(0) } },
    ]; // 原型 v2 删除了"泵体"成员，升级了电机，新增压力表
    const instance = instanceRecord(pumpDefinition(1));
    const states = new Map([
      ["scene-pump", primitiveState("scene-pump", "泵体", 9)],
      ["scene-motor", primitiveState("scene-motor", "电机", 11, "#278f83")],
    ]);
    const diff = diffUserPrefabUpdate(instance, definition, (id) => states.get(id));
    expect(diff.fromVersion).toBe(1);
    expect(diff.toVersion).toBe(2);
    expect(diff.added).toEqual([{ sourceId: "gauge", name: "压力表", kind: "primitive" }]);
    expect(diff.removed).toEqual([{ sceneObjectId: "scene-pump", sourceId: "pump", name: "泵体", reason: "prototype" }]);
    expect(diff.changed).toHaveLength(2);
    expect(diff.changed.map((change) => `${change.path}:${change.from}->${change.to}`).sort())
      .toEqual(["color:#278f83->#ff6a22", "opacity:1->0.8"]);
    expect(diff.changed.every((change) => !change.overridden)).toBe(true);
    expect(hasUserPrefabUpdate(instance, definition)).toBe(true);
  });

  it("marks overridden paths so apply keeps instance values", () => {
    const definition = pumpDefinition(2);
    definition.objects = [
      { ...definition.objects[0]!, state: { ...definition.objects[0]!.state, opacity: 0.6 } },
      definition.objects[1]!,
    ];
    const instance = instanceRecord(pumpDefinition(1), { "scene-pump": { opacity: 0.4 } });
    const states = new Map([
      ["scene-pump", { ...primitiveState("scene-pump", "泵体", -1), opacity: 0.4 }],
      ["scene-motor", primitiveState("scene-motor", "电机", 1)],
    ]);
    const diff = diffUserPrefabUpdate(instance, definition, (id) => states.get(id));
    const opacityChange = diff.changed.find((change) => change.path === "opacity");
    expect(opacityChange?.overridden).toBe(true);
    expect(opacityChange?.from).toBe(0.4);
    expect(opacityChange?.to).toBe(0.6);
  });

  it("reports missing scene objects as removed for mapping cleanup", () => {
    const definition = pumpDefinition();
    const instance = instanceRecord(definition);
    const diff = diffUserPrefabUpdate(instance, definition, (id) => (id === "scene-pump" ? primitiveState("scene-pump", "泵体", 9) : undefined));
    expect(diff.removed).toEqual([{ sceneObjectId: "scene-motor", sourceId: "motor", name: "motor", reason: "missing-in-scene" }]);
  });
});

describe("user prefab tree marks", () => {
  it("flags members, overridden members and pending root from recorded overrides", () => {
    const definition = pumpDefinition(2);
    const instance = instanceRecord(pumpDefinition(1), { "scene-motor": { opacity: 0.3 } });
    const marks = buildUserPrefabTreeMarks([instance], [definition]);
    expect(marks.members).toEqual(new Set(["scene-pump", "scene-motor"]));
    expect(marks.overridden).toEqual(new Set(["scene-motor"]));
    expect(marks.pending).toEqual(new Set(["scene-pump"]));
  });

  it("no marks without recorded overrides and pending update", () => {
    const definition = pumpDefinition();
    const instance = instanceRecord(definition);
    const marks = buildUserPrefabTreeMarks([instance], [definition]);
    expect(marks.overridden.size).toBe(0);
    expect(marks.pending.size).toBe(0);
    expect(marks.members).toEqual(new Set(["scene-pump", "scene-motor"]));
  });
});

describe("prefab state path diff", () => {
  it("compares material as a whole and skips absent optional keys", () => {
    const base: UserPrefabObjectState = { visible: true, opacity: 1, transform: transformAt(0) };
    const withMaterial: UserPrefabObjectState = { ...base, material: { baseColor: "#ffffff" } as never };
    expect(diffPrefabStates(base, withMaterial)).toEqual([{ path: "material", from: null, to: { baseColor: "#ffffff" } }]);
    expect(diffPrefabStates(withMaterial, base)).toEqual([{ path: "material", from: { baseColor: "#ffffff" }, to: null }]);
  });
});
