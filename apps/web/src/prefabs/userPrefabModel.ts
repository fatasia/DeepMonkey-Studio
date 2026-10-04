import type {
  JsonValue,
  PrimitiveKind,
  SceneModelState,
  UserPrefabObjectState as UserPrefabObjectStateContract,
  UserPrefabDefinition,
  UserPrefabInstanceRecord,
  UserPrefabObjectSnapshot,
  UserPrefabObjectState,
  UserPrefabPropertyChange,
  UserPrefabUpdateDiff,
  Vector3Value,
} from "@bim-studio/contracts";
import type { PrimitiveState } from "@bim-studio/contracts";

/**
 * 用户组合预制体核心逻辑（T0 刀 2）——全部纯函数，引擎与 React 不进入本文件。
 *
 * 职责：采集（场景对象 → 原型定义）、实例化计划（原型 → 创建计划）、
 * 应用更新 diff（结构变化 + 属性变化，区分实例覆盖）、覆盖检测与合并。
 * 属性 diff 走白名单路径，序列保证原型升级只影响未覆盖属性。
 */

/** 可 diff / 可覆盖的属性路径白名单；material/effects 作为整体对象比较。 */
const USER_PREFAB_SCALAR_PATHS = ["name", "visible", "opacity", "color", "colorOverride"] as const;
const USER_PREFAB_TRANSFORM_GROUPS = ["position", "rotation", "scale"] as const;
const USER_PREFAB_OBJECT_PATHS = ["material", "effects"] as const;

export type { UserPrefabObjectStateContract as UserPrefabObjectState };

export interface PrefabCapturedObject {
  /** 采集时的场景对象 ID（成为 sourceId）。 */
  objectId: string;
  name: string;
  kind: "model" | "primitive";
  state: SceneModelState & Partial<PrimitiveState>;
}

/** 从场景对象状态提取原型可序列化子集；丢弃引擎私有字段，避免双口径。 */
export function prefabStateFromSceneModel(state: SceneModelState & Partial<PrimitiveState>): UserPrefabObjectState {
  return {
    ...(typeof state.assetModelId === "string" ? { assetModelId: state.assetModelId } : {}),
    name: state.name,
    visible: state.visible,
    ...(state.locked ? { locked: true } : {}),
    opacity: state.opacity,
    ...(typeof state.color === "string" ? { color: state.color } : {}),
    ...(typeof state.colorOverride === "string" ? { colorOverride: state.colorOverride } : {}),
    transform: {
      position: { ...state.transform.position },
      rotation: { ...state.transform.rotation },
      scale: { ...state.transform.scale },
    },
    ...(state.material ? { material: structuredClone(state.material) } : {}),
    ...(state.effects ? { effects: structuredClone(state.effects) } : {}),
    ...(state.physics ? { physics: structuredClone(state.physics) } : {}),
    ...(state.kind ? { kind: state.kind } : {}),
  };
}

function positionOf(state: UserPrefabObjectState): Vector3Value {
  return state.transform.position;
}

/**
 * 以选择集位置质心为锚点采集原型定义；显式传 anchor 时以它为原点
 * （更新原型必须传实例锚点，否则实例升级会让其他实例整体平移）。
 */
export function captureUserPrefabObjects(entries: readonly PrefabCapturedObject[], anchor?: Vector3Value): UserPrefabObjectSnapshot[] {
  if (!entries.length) return [];
  const origin = anchor ?? entries
    .map((entry) => positionOf(prefabStateFromSceneModel(entry.state)))
    .reduce((accumulator, position) => ({ x: accumulator.x + position.x / entries.length, y: accumulator.y + position.y / entries.length, z: accumulator.z + position.z / entries.length }), { x: 0, y: 0, z: 0 });
  return entries.map((entry) => {
    const state = prefabStateFromSceneModel(entry.state);
    const position = positionOf(state);
    const offset = { x: position.x - origin.x, y: position.y - origin.y, z: position.z - origin.z };
    // 原型位置统一存锚点相对坐标：diff/覆盖/应用更新与实例锚点无关。
    state.transform.position = { ...offset };
    return {
      sourceId: entry.objectId,
      name: entry.name,
      kind: entry.kind,
      state,
      offset: { ...offset },
    };
  });
}

/** 实例化创建计划：单个成员的落位状态；modelId 换成新实例对象 ID。 */
export interface UserPrefabMemberPlan {
  objectId: string;
  sourceId: string;
  name: string;
  kind: "model" | "primitive";
  primitiveKind?: PrimitiveKind;
  color?: string;
  state: UserPrefabObjectState;
}

/** 生成实例化计划：保持原型层级顺序与相对偏移，锚点为用户指定落点。 */
export function planUserPrefabInstance(
  definition: UserPrefabDefinition,
  anchor: Vector3Value,
  createId: () => string = () => crypto.randomUUID(),
): UserPrefabMemberPlan[] {
  return definition.objects.map((object) => {
    const objectId = `prefabinst-${createId()}`;
    const relative = object.state.transform.position;
    const state: UserPrefabObjectState = {
      ...structuredClone(object.state),
      modelId: objectId,
      name: object.name,
      locked: false,
      visible: true,
      transform: {
        position: { x: anchor.x + relative.x, y: anchor.y + relative.y, z: anchor.z + relative.z },
        rotation: { ...object.state.transform.rotation },
        scale: { ...object.state.transform.scale },
      },
    };
    return {
      objectId,
      sourceId: object.sourceId,
      name: object.name,
      kind: object.kind,
      ...(object.state.kind ? { primitiveKind: object.state.kind } : {}),
      ...(object.state.color ? { color: object.state.color } : {}),
      state,
    };
  });
}

function flattenPrefabState(state: UserPrefabObjectState, sink: Map<string, JsonValue>): void {
  for (const key of USER_PREFAB_SCALAR_PATHS) {
    const value = state[key];
    if (value !== undefined) sink.set(key, value as JsonValue);
  }
  for (const group of USER_PREFAB_TRANSFORM_GROUPS) {
    for (const axis of ["x", "y", "z"] as const) sink.set(`transform.${group}.${axis}`, state.transform[group][axis]);
  }
  for (const key of USER_PREFAB_OBJECT_PATHS) {
    const value = state[key];
    if (value !== undefined) sink.set(key, structuredClone(value) as JsonValue);
  }
}

function jsonEquals(a: JsonValue, b: JsonValue): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 路径级状态 diff；键在任一侧出现而另一侧缺失时如实报 from/to=null。 */
export function diffPrefabStates(current: UserPrefabObjectState, target: UserPrefabObjectState): Array<{ path: string; from: JsonValue; to: JsonValue }> {
  const left = new Map<string, JsonValue>();
  const right = new Map<string, JsonValue>();
  flattenPrefabState(current, left);
  flattenPrefabState(target, right);
  const changes: Array<{ path: string; from: JsonValue; to: JsonValue }> = [];
  for (const [path, to] of right) {
    const from = left.get(path);
    if (from === undefined || !jsonEquals(from, to)) changes.push({ path, ...(from === undefined ? { from: null } : { from }), to });
  }
  for (const [path, from] of left) {
    if (!right.has(path)) changes.push({ path, from, to: null });
  }
  return changes;
}

/** 把场景绝对状态换算为实例相对状态（position 减实例锚点）；diff/覆盖检测统一入口。 */
export function prefabStateRelativeToInstance(state: UserPrefabObjectState, anchor: Vector3Value): UserPrefabObjectState {
  return {
    ...state,
    transform: {
      ...state.transform,
      position: {
        x: state.transform.position.x - anchor.x,
        y: state.transform.position.y - anchor.y,
        z: state.transform.position.z - anchor.z,
      },
    },
  };
}

/** 把原型相对状态还原为实例落位状态（position 加实例锚点）；应用更新写回前调用。 */
export function prefabStateAtAnchor(state: UserPrefabObjectState, anchor: Vector3Value): UserPrefabObjectState {
  return prefabStateRelativeToInstance(state, { x: -anchor.x, y: -anchor.y, z: -anchor.z });
}

export function hasUserPrefabUpdate(instance: UserPrefabInstanceRecord, definition: UserPrefabDefinition): boolean {
  return instance.prefabVersion < definition.version;
}

/** 实例成员当前状态读取口径：缺失返回 undefined（对象已被删除）。 */
export type PrefabMemberStateReader = (sceneObjectId: string) => (SceneModelState & Partial<PrimitiveState>) | undefined;

/**
 * 检测实例级覆盖：成员当前状态与原型状态的路径级差异即覆盖值。
 * 与原型一致（无差异）的成员不产生覆盖记录。
 */
export function collectUserPrefabOverrides(
  instance: UserPrefabInstanceRecord,
  definition: UserPrefabDefinition,
  readState: PrefabMemberStateReader,
): Record<string, Record<string, JsonValue>> {
  const definitionBySource = new Map(definition.objects.map((object) => [object.sourceId, object]));
  const overrides: Record<string, Record<string, JsonValue>> = {};
  for (const [sourceId, sceneObjectId] of Object.entries(instance.memberObjectIds)) {
    const prototype = definitionBySource.get(sourceId);
    const current = readState(sceneObjectId);
    if (!prototype || !current) continue;
    const memberOverrides: Record<string, JsonValue> = {};
    for (const { path, from } of diffPrefabStates(prefabStateRelativeToInstance(prefabStateFromSceneModel(current), instance.anchor), prototype.state)) {
      memberOverrides[path] = from;
    }
    if (Object.keys(memberOverrides).length > 0) overrides[sceneObjectId] = memberOverrides;
  }
  return overrides;
}

/**
 * 应用更新 diff 预览（不落任何写操作）。
 * - added：原型新增、实例尚未创建的成员；
 * - removed：原型已不含的实例成员（含场景对象已被删除的情况，应用时清理映射）；
 * - changed：共同成员的属性变化；from=实例当前值，to=原型新值，overridden=true 的
 *   条目应用更新时保留实例值。
 */
export function diffUserPrefabUpdate(
  instance: UserPrefabInstanceRecord,
  definition: UserPrefabDefinition,
  readState: PrefabMemberStateReader,
): UserPrefabUpdateDiff {
  const definitionBySource = new Map(definition.objects.map((object) => [object.sourceId, object]));
  const added = definition.objects
    .filter((object) => !instance.memberObjectIds[object.sourceId])
    .map((object) => ({ sourceId: object.sourceId, name: object.name, kind: object.kind }));
  const removed: UserPrefabUpdateDiff["removed"] = Object.entries(instance.memberObjectIds)
    .filter(([sourceId]) => !definitionBySource.has(sourceId))
    .map(([sourceId, sceneObjectId]) => ({ sceneObjectId, sourceId, name: readState(sceneObjectId)?.name ?? sourceId, reason: "prototype" as const }));
  // 场景对象已被删除、但原型仍含该成员：应用更新时清理映射，不产生场景写操作。
  for (const [sourceId, sceneObjectId] of Object.entries(instance.memberObjectIds)) {
    if (definitionBySource.has(sourceId) && !readState(sceneObjectId)) {
      removed.push({ sceneObjectId, sourceId, name: sourceId, reason: "missing-in-scene" });
    }
  }
  const changed: UserPrefabPropertyChange[] = [];
  for (const [sourceId, sceneObjectId] of Object.entries(instance.memberObjectIds)) {
    const prototype = definitionBySource.get(sourceId);
    const current = readState(sceneObjectId);
    if (!prototype || !current) continue;
    const memberOverrides = instance.overrides?.[sceneObjectId] ?? {};
    // diff 用实例世界坐标展示：原型相对状态先落到实例锚点，位置 from/to 均为绝对值。
    for (const { path, from, to } of diffPrefabStates(prefabStateFromSceneModel(current), prefabStateAtAnchor(prototype.state, instance.anchor))) {
      changed.push({
        sceneObjectId,
        sourceId,
        name: current.name ?? prototype.name,
        path,
        from,
        to,
        overridden: Object.hasOwn(memberOverrides, path),
      });
    }
  }
  changed.sort((a, b) => a.sceneObjectId.localeCompare(b.sceneObjectId) || a.path.localeCompare(b.path));
  return {
    prefabId: definition.id,
    fromVersion: instance.prefabVersion,
    toVersion: definition.version,
    added,
    removed,
    changed,
  };
}

/**
 * 应用更新时的成员最终状态：原型值为基线，实例覆盖路径保留覆盖值。
 * 返回 undefined 表示该成员无需写回（与原型完全一致且无覆盖）。
 */
export function mergePrototypeWithOverrides(prototypeState: UserPrefabObjectState, overrides?: Record<string, JsonValue>): UserPrefabObjectState {
  const merged = structuredClone(prototypeState);
  if (overrides) {
    for (const [path, value] of Object.entries(overrides)) {
      if (applyPrefabPath(merged, path, value)) continue;
      // 未知路径（原型字段收窄等）静默保留在 overrides 中，不阻断应用。
    }
  }
  return merged;
}

function applyPrefabPath(state: UserPrefabObjectState, path: string, value: JsonValue): boolean {
  const segments = path.split(".");
  if (segments.length === 1) {
    const key = segments[0]!;
    if (!["name", "visible", "opacity", "color", "colorOverride"].includes(key)) {
      if (!USER_PREFAB_OBJECT_PATHS.some((candidate) => candidate === key)) return false;
    }
    (state as unknown as Record<string, JsonValue>)[key] = value;
    return true;
  }
  if (segments.length === 2 && segments[0] === "transform") {
    const group = segments[1]!;
    if (group !== "position" && group !== "rotation" && group !== "scale") return false;
    (state.transform as unknown as Record<string, JsonValue>)[group] = value;
    return true;
  }
  if (segments.length === 3 && segments[0] === "transform") {
    const group = segments[1]!;
    const axis = segments[2]!;
    if ((group !== "position" && group !== "rotation" && group !== "scale") || (axis !== "x" && axis !== "y" && axis !== "z")) return false;
    (state.transform[group] as unknown as Record<string, JsonValue>)[axis] = value;
    return true;
  }
  return false;
}

/** 实例记录清洗：清掉场景中已不存在的成员映射与对应覆盖。 */
export function pruneUserPrefabInstance(instance: UserPrefabInstanceRecord, exists: (sceneObjectId: string) => boolean): UserPrefabInstanceRecord {
  const memberObjectIds: Record<string, string> = {};
  const aliveSceneIds = new Set<string>();
  for (const [sourceId, sceneObjectId] of Object.entries(instance.memberObjectIds)) {
    if (exists(sceneObjectId)) {
      memberObjectIds[sourceId] = sceneObjectId;
      aliveSceneIds.add(sceneObjectId);
    }
  }
  const overrides = instance.overrides
    ? Object.fromEntries(Object.entries(instance.overrides).filter(([sceneObjectId]) => aliveSceneIds.has(sceneObjectId)))
    : undefined;
  const { overrides: _droppedOverrides, ...rest } = instance;
  return { ...rest, memberObjectIds, ...(overrides && Object.keys(overrides).length ? { overrides } : {}) };
}

/** 移除单个成员的实例覆盖（重置为原型使用）。 */
export function clearUserPrefabMemberOverrides(instance: UserPrefabInstanceRecord, sceneObjectId: string): UserPrefabInstanceRecord {
  if (!instance.overrides || !Object.hasOwn(instance.overrides, sceneObjectId)) return instance;
  const overrides = { ...instance.overrides };
  delete overrides[sceneObjectId];
  const { overrides: _droppedOverrides, ...rest } = instance;
  return { ...rest, ...(Object.keys(overrides).length ? { overrides } : {}) };
}

export function instanceMemberSceneIds(instance: UserPrefabInstanceRecord): Set<string> {
  return new Set(Object.values(instance.memberObjectIds));
}

/**
 * 场景树标记：成员 → 实例/覆盖/待更新。
 * 覆盖以 instance.overrides 登记记录为准（由"检测覆盖/应用更新"显式刷新），
 * 不对当前原型重 diff——否则原型升级会把待更新属性误标为实例覆盖。
 */
export interface UserPrefabTreeMarks {
  /** 成员对象 ID 集合（实例图标）。 */
  members: Set<string>;
  /** 存在实例覆盖的成员对象 ID 集合（覆盖徽章）。 */
  overridden: Set<string>;
  /** 原型有更新未应用的实例主成员（首个成员）ID 集合。 */
  pending: Set<string>;
}

export function buildUserPrefabTreeMarks(
  instances: readonly UserPrefabInstanceRecord[],
  definitions: readonly UserPrefabDefinition[],
): UserPrefabTreeMarks {
  const marks: UserPrefabTreeMarks = { members: new Set(), overridden: new Set(), pending: new Set() };
  const definitionsById = new Map(definitions.map((definition) => [definition.id, definition]));
  for (const instance of instances) {
    const definition = definitionsById.get(instance.prefabId);
    const entries = Object.entries(instance.memberObjectIds);
    const hasUpdate = definition ? hasUserPrefabUpdate(instance, definition) : false;
    entries.forEach(([, sceneObjectId], index) => {
      marks.members.add(sceneObjectId);
      if (instance.overrides && Object.keys(instance.overrides[sceneObjectId] ?? {}).length > 0) marks.overridden.add(sceneObjectId);
      if (hasUpdate && index === 0) marks.pending.add(sceneObjectId);
    });
  }
  return marks;
}
