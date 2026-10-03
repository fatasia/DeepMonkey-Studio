import type { SceneCommand, SceneObjectRef } from "@bim-studio/scene-sdk";

/**
 * 场景改动闭环的纯数据层:可序列化的场景状态快照、命令仿真(产出字段级前后值差异)、
 * 以及应用后的"期望 vs 实际"确定性核对。不依赖 React/Three,执行与撤销由宿主端口负责。
 */
export type Vec3 = [number, number, number];

export interface SceneObjectState {
  id: string;
  name: string;
  kind: "model" | "primitive";
  visible: boolean;
  locked?: boolean;
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
  color?: string;
  roughness?: number;
  metalness?: number;
  emissive?: string;
  emissiveIntensity?: number;
}

export interface SceneStateSnapshot {
  sceneId: string;
  objects: SceneObjectState[];
  camera: { position: Vec3; target: Vec3 };
  lighting: { enabled?: boolean; intensity?: number; shadowsEnabled?: boolean; globalIlluminationEnabled?: boolean; globalIlluminationIntensity?: number };
  environment: { backgroundColor?: string; environmentIntensity?: number; weather?: string };
  selection?: string;
}

/** 与 ViewerEngine 结构兼容的只读读取面(测试可注入伪实现)。 */
export interface SceneStateSource {
  listModels(): readonly { id: string; name: string; kind: "model" | "primitive"; visible: boolean }[];
  getModelTransform(id: string): { position: { x: number; y: number; z: number }; rotation: { x: number; y: number; z: number }; scale: { x: number; y: number; z: number } } | undefined;
  getModelMaterialState(id: string): { color?: string; roughness?: number; metalness?: number; emissive?: string; emissiveIntensity?: number } | undefined;
  getCameraState(): { position: { x: number; y: number; z: number }; target: { x: number; y: number; z: number } };
  getGlobalLighting?(): SceneStateSnapshot["lighting"];
  getSceneEnvironment?(): { backgroundColor?: string; environmentIntensity?: number };
  getWeather?(): string;
  getSelected(): { id: string } | undefined;
  isModelLocked?(id: string): boolean;
}

const vec = (value: { x: number; y: number; z: number }): Vec3 => [value.x, value.y, value.z];

export function readSceneState(source: SceneStateSource, sceneId: string): SceneStateSnapshot {
  const objects: SceneObjectState[] = source.listModels().map((model) => {
    const transform = source.getModelTransform(model.id);
    const material = source.getModelMaterialState(model.id);
    return {
      id: model.id, name: model.name, kind: model.kind, visible: model.visible,
      ...(source.isModelLocked?.(model.id) ? { locked: true } : {}),
      position: transform ? vec(transform.position) : [0, 0, 0],
      rotation: transform ? vec(transform.rotation) : [0, 0, 0],
      scale: transform ? vec(transform.scale) : [1, 1, 1],
      ...(material?.color ? { color: normalizeColor(material.color) } : {}),
      ...(material?.roughness !== undefined ? { roughness: material.roughness } : {}),
      ...(material?.metalness !== undefined ? { metalness: material.metalness } : {}),
      ...(material?.emissive ? { emissive: normalizeColor(material.emissive) } : {}),
      ...(material?.emissiveIntensity !== undefined ? { emissiveIntensity: material.emissiveIntensity } : {}),
    };
  });
  const camera = source.getCameraState();
  const environment = source.getSceneEnvironment?.();
  const lighting = source.getGlobalLighting?.();
  const weather = source.getWeather?.();
  const selected = source.getSelected();
  return {
    sceneId, objects,
    camera: { position: vec(camera.position), target: vec(camera.target) },
    lighting: lighting ? {
      ...(lighting.enabled !== undefined ? { enabled: lighting.enabled } : {}),
      ...(lighting.intensity !== undefined ? { intensity: lighting.intensity } : {}),
      ...(lighting.shadowsEnabled !== undefined ? { shadowsEnabled: lighting.shadowsEnabled } : {}),
      ...(lighting.globalIlluminationEnabled !== undefined ? { globalIlluminationEnabled: lighting.globalIlluminationEnabled } : {}),
      ...(lighting.globalIlluminationIntensity !== undefined ? { globalIlluminationIntensity: lighting.globalIlluminationIntensity } : {}),
    } : {},
    environment: {
      ...(environment?.backgroundColor ? { backgroundColor: normalizeColor(environment.backgroundColor) } : {}),
      ...(environment?.environmentIntensity !== undefined ? { environmentIntensity: environment.environmentIntensity } : {}),
      ...(weather ? { weather } : {}),
    },
    ...(selected ? { selection: selected.id } : {}),
  };
}

export type SceneDiffKind = "add" | "modify" | "delete" | "action";
export interface SceneDiffField { key: string; label: string; before?: string; after: string }
export interface SceneDiffEntry {
  commandId: string;
  type: SceneCommand["type"];
  kind: SceneDiffKind;
  subject: string;
  fields: SceneDiffField[];
  /** 运行时效果(动画/数据推送/组件)没有可靠逆算子,撤销不会还原。 */
  irreversible?: boolean;
  /** 命令不会改变任何值。 */
  noop?: boolean;
}
export interface SceneDiff {
  entries: SceneDiffEntry[];
  counts: Record<SceneDiffKind, number>;
  /** 非空即不可应用:目标不存在、已锁定、宿主未开放等。 */
  blockers: string[];
  irreversibleCount: number;
}
export type FactValue = string | number | boolean | number[];
export interface SceneSimulation { after: SceneStateSnapshot; diff: SceneDiff; expected: Record<string, FactValue> }

export function normalizeColor(value: string): string {
  const text = value.trim().toLowerCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(text);
  return short ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}` : text;
}

export function formatNumber(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}
const deg = (rad: number) => Math.round(rad * 1800 / Math.PI) / 10;
const fmtVec = (value: Vec3) => `(${value.map(formatNumber).join(", ")})`;
const fmtRot = (value: Vec3) => `(${value.map(item => `${deg(item)}°`).join(", ")})`;
const same = (a: readonly number[], b: readonly number[]) => a.every((item, index) => Math.abs(item - b[index]!) < 1e-6);

/** 逐条仿真命令:后一条看到前一条的结果;同时记录触碰过的事实用于应用后核对。 */
export function simulateSceneCommands(commands: readonly SceneCommand[], before: SceneStateSnapshot): SceneSimulation {
  const state: SceneStateSnapshot = structuredClone(before);
  const touched = new Set<string>();
  const entries: SceneDiffEntry[] = [];
  const bySubject = new Map<string, SceneDiffEntry>();
  const blockers: string[] = [];
  const find = (id: string) => state.objects.find(object => object.id === id);
  const label = (id: string) => { const object = find(id); return object ? `${object.name} (${id})` : id; };
  const missing = (command: SceneCommand, id: string) => { blockers.push(`${command.type}: 对象 ${id} 不存在`); };

  for (const command of commands) {
    const entry: SceneDiffEntry = { commandId: command.id, type: command.type, kind: "modify", subject: "", fields: [] };
    switch (command.type) {
      case "object.create-primitive": {
        const id = command.target.objectId;
        if (find(id)) { blockers.push(`${command.type}: 对象 ${id} 已存在`); break; }
        state.objects.push({ id, name: command.name, kind: "primitive", visible: true, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], color: normalizeColor(command.color) });
        touched.add(`o:${id}:exists`).add(`o:${id}:color`);
        Object.assign(entry, { kind: "add", subject: `${command.name} (${id})`, fields: [
          { key: "kind", label: "形状", after: command.kind }, { key: "color", label: "颜色", after: normalizeColor(command.color) }] });
        break;
      }
      case "object.delete-primitive": {
        const id = command.target.objectId, object = find(id);
        if (!object) { missing(command, id); break; }
        if (object.kind !== "primitive") blockers.push(`${command.type}: ${label(id)} 不是作者图元,不可删除`);
        if (object.locked) blockers.push(`${command.type}: ${label(id)} 已锁定`);
        state.objects = state.objects.filter(item => item.id !== id);
        touched.add(`o:${id}:exists`);
        Object.assign(entry, { kind: "delete", subject: label(id), fields: [{ key: "exists", label: "对象", before: "存在", after: "已删除" }] });
        break;
      }
      case "object.set-visibility": {
        const targets = visibilityTargets(command.target, state);
        if (!targets) { missing(command, (command.target as { objectId?: string }).objectId ?? "?"); break; }
        entry.subject = command.target.kind === "scene" ? "场景内全部对象" : command.target.kind === "mesh" ? `${label(command.target.objectId)} · 网格 ${command.target.meshId}` : label(command.target.objectId);
        entry.fields.push({ key: "visible", label: "可见性", ...(command.target.kind === "object" ? { before: targets[0]!.visible ? "可见" : "隐藏" } : {}), after: command.visible ? "可见" : "隐藏" });
        if (command.target.kind !== "mesh") for (const object of targets) { object.visible = command.visible; touched.add(`o:${object.id}:visible`); }
        break;
      }
      case "object.set-transform": {
        if (command.target.kind !== "object") { blockers.push(`${command.type}: 仅支持模型对象级变换`); break; }
        const object = find(command.target.objectId);
        if (!object) { missing(command, command.target.objectId); break; }
        entry.subject = label(object.id);
        for (const [key, name, fmt] of [["position", "位置", fmtVec], ["rotation", "旋转", fmtRot], ["scale", "缩放", fmtVec]] as const) {
          const next = command[key];
          if (!next || same(next, object[key])) continue;
          entry.fields.push({ key, label: name, before: fmt(object[key]), after: fmt(next) });
          object[key] = [...next] as Vec3;
          touched.add(`o:${object.id}:${key}`);
        }
        break;
      }
      case "material.set": {
        if (command.target.kind !== "object") { blockers.push(`${command.type}: 仅支持模型对象级材质`); break; }
        const object = find(command.target.objectId);
        if (!object) { missing(command, command.target.objectId); break; }
        if (object.locked) blockers.push(`${command.type}: ${label(object.id)} 已锁定`);
        entry.subject = label(object.id);
        const patch = command.patch as Record<string, unknown>;
        for (const [key, name] of [["color", "颜色"], ["emissive", "自发光色"], ["roughness", "粗糙度"], ["metalness", "金属度"], ["emissiveIntensity", "自发光强度"]] as const) {
          const next = patch[key];
          if (next === undefined) continue;
          const value = typeof next === "string" ? normalizeColor(next) : next as number;
          const current = object[key];
          if (current === value) continue;
          entry.fields.push({ key, label: name, ...(current !== undefined ? { before: String(typeof current === "number" ? formatNumber(current) : current) } : {}), after: String(typeof value === "number" ? formatNumber(value) : value) });
          (object as unknown as Record<string, unknown>)[key] = value;
          touched.add(`o:${object.id}:${key}`);
        }
        for (const key of Object.keys(patch)) if (!["color", "emissive", "roughness", "metalness", "emissiveIntensity"].includes(key)) entry.fields.push({ key, label: key, after: JSON.stringify(patch[key]) });
        break;
      }
      case "object.set-parent":
        entry.subject = label(command.target.objectId);
        if (!find(command.target.objectId)) { missing(command, command.target.objectId); break; }
        entry.fields.push({ key: "parent", label: "父级", after: command.parentId ?? "(场景根)" });
        break;
      case "selection.set":
        entry.subject = "选择";
        entry.fields.push({ key: "selection", label: "选中", ...(state.selection ? { before: label(state.selection) } : {}), after: command.targets.map(target => "objectId" in target ? label(target.objectId) : "场景").join("、") || "(清空)" });
        break;
      case "camera.set":
        entry.subject = "相机";
        entry.fields.push({ key: "position", label: "位置", before: fmtVec(state.camera.position), after: fmtVec(command.position) }, { key: "target", label: "目标", before: fmtVec(state.camera.target), after: fmtVec(command.target) });
        state.camera = { position: [...command.position], target: [...command.target] };
        break;
      case "camera.fly-to":
        entry.subject = "相机";
        entry.fields.push({ key: "fly", label: "飞向", after: "objectId" in command.target ? label(command.target.objectId) : "position" in command.target ? fmtVec(command.target.position) : "场景" });
        break;
      case "lighting.set":
        entry.subject = "全局光照";
        for (const [key, value] of Object.entries(command.patch)) {
          const current = (state.lighting as Record<string, unknown>)[key];
          entry.fields.push({ key, label: lightingLabels[key] ?? key, ...(current !== undefined ? { before: fmtValue(current) } : {}), after: fmtValue(value) });
          (state.lighting as Record<string, unknown>)[key] = value;
          if (key === "enabled" || key === "intensity") touched.add(`lighting:${key}`);
        }
        break;
      case "environment.set":
        entry.subject = "场景环境";
        for (const [key, value] of Object.entries(command.patch)) {
          const current = (state.environment as Record<string, unknown>)[key];
          entry.fields.push({ key, label: environmentLabels[key] ?? key, ...(current !== undefined ? { before: fmtValue(current) } : {}), after: fmtValue(value) });
          (state.environment as Record<string, unknown>)[key] = key === "backgroundColor" && typeof value === "string" ? normalizeColor(value) : value;
          if (key === "weather") touched.add("environment:weather");
        }
        break;
      case "animation.control":
        Object.assign(entry, { kind: "action", subject: "动画", irreversible: true, fields: [{ key: "action", label: "动作", after: `${command.action}${command.clipId ? ` · ${command.clipId}` : ""}${command.time !== undefined ? ` @${formatNumber(command.time)}s` : ""}` }] });
        break;
      case "animation.set-anchor":
        Object.assign(entry, { subject: "状态机锚", fields: Object.entries(command.anchor).map(([key, value]) => ({ key, label: key === "initialStateId" ? "初始状态" : "活动状态", after: String(value) })) });
        break;
      case "data.apply":
        Object.assign(entry, { kind: "action", subject: "对象数据", irreversible: true, fields: [{ key: "values", label: "数据", after: Object.keys(command.values).join("、") }] });
        break;
      case "component.update":
        Object.assign(entry, { kind: "action", subject: `组件 ${command.componentId}`, irreversible: true, fields: Object.keys(command.patch).map(key => ({ key, label: key, after: JSON.stringify(command.patch[key]) })) });
        break;
      default:
        blockers.push(`${command.type}: 编辑器视口不支持该命令`);
    }
    if (!entry.subject) continue;
    const merge = entry.kind === "modify" && command.type !== "object.set-parent" ? bySubject.get(entry.subject) : undefined;
    if (merge) {
      for (const field of entry.fields) {
        const at = merge.fields.findIndex(item => item.key === field.key);
        const { before, ...rest } = field;
        const keep = merge.kind === "add" ? rest : at >= 0 && merge.fields[at]!.before !== undefined ? { ...rest, before: merge.fields[at]!.before! } : field;
        if (at >= 0) merge.fields[at] = keep; else merge.fields.push(keep);
      }
      merge.noop = merge.fields.length === 0;
      continue;
    }
    if (entry.kind === "modify" && entry.fields.length === 0) entry.noop = true;
    if ((entry.kind === "add" || entry.kind === "modify") && command.type !== "object.set-parent") bySubject.set(entry.subject, entry);
    entries.push(entry);
  }

  const counts: Record<SceneDiffKind, number> = { add: 0, modify: 0, delete: 0, action: 0 };
  for (const entry of entries) counts[entry.kind] += 1;
  return {
    after: state,
    diff: { entries, counts, blockers, irreversibleCount: entries.filter(entry => entry.irreversible).length },
    expected: factsFor(state, touched),
  };
}

const lightingLabels: Record<string, string> = { enabled: "启用", intensity: "强度", shadowsEnabled: "阴影", globalIlluminationEnabled: "全局光照", globalIlluminationIntensity: "全局光照强度" };
const environmentLabels: Record<string, string> = { backgroundColor: "背景色", weather: "天气", environmentIntensity: "环境强度" };
const fmtValue = (value: unknown) => typeof value === "number" ? formatNumber(value) : typeof value === "boolean" ? (value ? "开" : "关") : String(value);

function visibilityTargets(target: SceneObjectRef, state: SceneStateSnapshot): SceneObjectState[] | undefined {
  if (target.kind === "scene") return state.objects;
  const object = state.objects.find(item => item.id === target.objectId);
  return object ? [object] : undefined;
}

/** 把快照中被触碰的字段展平为可比较的事实;对象删除以 exists=false 表达。 */
export function factsFor(state: SceneStateSnapshot, keys: ReadonlySet<string>): Record<string, FactValue> {
  const facts: Record<string, FactValue> = {};
  for (const key of keys) {
    if (key.startsWith("o:")) {
      const [, id, field] = key.split(":") as [string, string, string];
      const object = state.objects.find(item => item.id === id);
      if (field === "exists") facts[key] = Boolean(object);
      else if (object) { const value = (object as unknown as Record<string, FactValue | undefined>)[field]; if (value !== undefined) facts[key] = value; }
    } else if (key.startsWith("lighting:")) {
      const value = (state.lighting as Record<string, FactValue | undefined>)[key.slice(9)];
      if (value !== undefined) facts[key] = value;
    } else if (key === "environment:weather" && state.environment.weather) facts[key] = state.environment.weather;
  }
  return facts;
}

export interface SceneCheck { key: string; label: string; expected: string; actual: string; ok: boolean }

const factLabel = (key: string, state: SceneStateSnapshot): string => {
  if (!key.startsWith("o:")) return key.startsWith("lighting:") ? `光照 · ${lightingLabels[key.slice(9)] ?? key}` : "环境 · 天气";
  const [, id, field] = key.split(":") as [string, string, string];
  const names: Record<string, string> = { exists: "存在", visible: "可见性", position: "位置", rotation: "旋转", scale: "缩放", color: "颜色", roughness: "粗糙度", metalness: "金属度", emissive: "自发光色", emissiveIntensity: "自发光强度" };
  return `${state.objects.find(item => item.id === id)?.name ?? id} · ${names[field] ?? field}`;
};
const fmtFact = (value: FactValue | undefined, key: string): string => value === undefined ? "(缺失)"
  : Array.isArray(value) ? (key.endsWith(":rotation") ? fmtRot(value as Vec3) : fmtVec(value as Vec3)) : typeof value === "number" ? formatNumber(value) : typeof value === "boolean" ? (value ? "是" : "否") : value;

/** 应用后核对:仿真预期 vs 引擎实际读回;不依赖模型判断。 */
export function verifyExpectedFacts(expected: Record<string, FactValue>, actual: SceneStateSnapshot, labelState: SceneStateSnapshot): SceneCheck[] {
  const actualFacts = factsFor(actual, new Set(Object.keys(expected)));
  return Object.entries(expected).map(([key, want]) => {
    const got = actualFacts[key];
    const ok = got !== undefined && (Array.isArray(want) ? Array.isArray(got) && same(want, got) : typeof want === "number" ? typeof got === "number" && Math.abs(want - got) < 1e-3 : want === got);
    return { key, label: factLabel(key, labelState), expected: fmtFact(want, key), actual: fmtFact(got, key), ok };
  });
}

/** 撤销还原校验:忽略选择与相机,只比较作者状态。 */
export function sceneAuthorFingerprint(state: SceneStateSnapshot): string {
  return JSON.stringify({ o: [...state.objects].sort((a, b) => a.id.localeCompare(b.id)).map(object => ({ ...object, position: object.position.map(round), rotation: object.rotation.map(round), scale: object.scale.map(round) })), l: state.lighting, e: state.environment });
}
const round = (value: number) => Math.round(value * 1000) / 1000;
