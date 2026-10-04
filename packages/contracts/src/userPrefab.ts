import type { JsonValue } from "./application.js";
import type { Vector3Value } from "./geometry.js";
import type { PrimitiveKind, SceneModelState } from "./scene.js";

/**
 * 用户组合预制体（T0 刀 2）：把作者在场景里摆好的多对象组合存为可复用模板。
 *
 * 与工业预制体（IndustrialPrefabDefinition，参数化单设备）正交：这里序列化的是
 * 场景快照对象（SceneModelState 兼容子集），实例是普通场景对象 + 场景级登记记录。
 */

/** 预制体内单个对象的序列化快照；offset 为相对锚点（采集时位置质心）的偏移。 */
export interface UserPrefabObjectSnapshot {
  /** 采集时的场景对象 ID；实例 diff 与原型更新的稳定映射键。 */
  sourceId: string;
  name: string;
  kind: "model" | "primitive";
  /** 原型属性基线；结构兼容 SceneModelState（primitive 另含 kind/color）。 */
  state: UserPrefabObjectState;
  /** 相对锚点的位置偏移；实例化时加到用户指定锚点上。 */
  offset: Vector3Value;
}

/** 原型对象的可序列化状态子集；与 SceneModelState 字段同名，避免双口径。 */
export interface UserPrefabObjectState {
  modelId?: string;
  assetModelId?: string;
  name?: string;
  visible: boolean;
  locked?: boolean;
  opacity: number;
  color?: string;
  colorOverride?: string;
  transform: {
    position: Vector3Value;
    rotation: Vector3Value;
    scale: Vector3Value;
  };
  material?: SceneModelState["material"];
  effects?: SceneModelState["effects"];
  physics?: SceneModelState["physics"];
  /** primitive 专属：几何种类；model 成员不带。 */
  kind?: PrimitiveKind;
}

export interface UserPrefabDefinition {
  /** 形如 `userprefab:<uuid>`；跨场景导出/导入保持稳定。 */
  id: string;
  name: string;
  category: string;
  /** 结构版本；"更新原型"递增，实例按此判定待更新。 */
  version: number;
  /** 保存时抓取的视口缩略图（JPEG data URL）。 */
  thumbnail?: string;
  createdAt: string;
  updatedAt: string;
  objects: UserPrefabObjectSnapshot[];
}

/** 场景内一个预制体实例的登记记录；成员对象仍是普通场景对象。 */
export interface UserPrefabInstanceRecord {
  instanceId: string;
  prefabId: string;
  /** 实例当前对齐的原型版本；小于 definition.version 即有待应用更新。 */
  prefabVersion: number;
  /** 实例化落点（锚点）；成员覆盖检测以此为参照做相对化。 */
  anchor: import("./geometry.js").Vector3Value;
  /** sourceId → 当前场景对象 ID 映射；成员被删除后键保留，diff 如实报缺失。 */
  memberObjectIds: Record<string, string>;
  /** sceneObjectId → { 属性路径 → 实例覆盖值 }；空/缺省即完全跟随原型。 */
  overrides?: Record<string, Record<string, JsonValue>>;
}

/** 应用更新 diff 的单条属性变化。 */
export interface UserPrefabPropertyChange {
  sceneObjectId: string;
  sourceId: string;
  name: string;
  path: string;
  from: JsonValue;
  to: JsonValue;
  /** true = 该属性存在实例覆盖，应用更新时保留覆盖值不写原型值。 */
  overridden: boolean;
}

/** 应用更新 diff 预览；added/removed 为结构变化，changed 为属性变化。 */
export interface UserPrefabUpdateDiff {
  prefabId: string;
  fromVersion: number;
  toVersion: number;
  added: Array<{ sourceId: string; name: string; kind: "model" | "primitive" }>;
  removed: Array<{
    sceneObjectId: string;
    sourceId: string;
    name: string;
    /** prototype = 原型已不含该成员；missing-in-scene = 场景对象已被删除，仅清理映射。 */
    reason: "prototype" | "missing-in-scene";
  }>;
  changed: UserPrefabPropertyChange[];
}
