/**
 * 类库实例化与传播(西门子 Class Library 语义的运行时层)。
 * 职责边界:实例化在模型构建层把类模板物化为完整平面节点/资源,产物进 PlantLiteModel
 * 走既有校验与求解——本文件不改 runtime.ts 的任何求解语义。
 * 语义(docs/reports/siemens-pps-deep-dive-2026-09-26.md 第 1.2 节):
 * - instantiateClass:按继承链合并(子类属性覆写父类同 id 实体)生成实例;内部引用
 *   (resourceId/workerResourceId/routes.to)仅当指向同类模板实体时映射为实例 id,
 *   指向模型级共享资源的引用原样保留(多实例可共享一台设备);
 * - setInstanceOverride:实例改 → 该属性自动断继承(写入 propertyOverrides);
 * - propagateClassChange:类改 → 重算链上全部实例的未覆写属性,引用属性经同一
 *   内部映射规则落回各实例(传播不会踩掉实例化产生的实例级引用);
 *   affectedInstances 只计属性值实际发生变化的实例(计数即断继承生效的直接证据)。
 */

import type {
  PlantClassDefinition,
  PlantClassMutation,
  PlantClassPropagationResult,
  PlantClassPropertyValue,
  PlantLiteModel,
  PlantLiteNode,
  PlantLiteResource,
} from "./modelTypes.js";

/** 实例身份字段:永不参与继承传播,也不允许被实例覆写或类变更触碰。 */
const IDENTITY_PROPS = new Set(["id", "name", "kind", "inheritedFromClassId", "propertyOverrides"]);

/** 继承链合并后的类模板;nodes/resources 均为深拷贝,调用方可安全改写。 */
export interface PlantClassTemplate {
  classIds: string[];
  nodes: PlantLiteNode[];
  resources: PlantLiteResource[];
}

/** 内部引用映射上下文:类内实体在实例里统一映射为 `${classId}.${序号}.${模板实体id}`。 */
interface ReferenceContext {
  classId: string;
  ordinal: number;
  templateIds: Set<string>;
}

/** 自根至 classId 的继承链;未知类与继承环显式抛错。 */
export function resolveClassChain(library: PlantClassDefinition[], classId: string): PlantClassDefinition[] {
  const byId = new Map<string, PlantClassDefinition>(library.map((definition) => [definition.classId, definition]));
  const chain: PlantClassDefinition[] = [];
  const onStack = new Set<string>();
  let current: string | undefined = classId;
  while (current !== undefined) {
    const definition = byId.get(current);
    if (!definition) throw new Error(`未知类: ${current}`);
    if (onStack.has(current)) throw new Error(`继承链存在环: ${[...chain.map((entry) => entry.classId), current].join(" -> ")}`);
    onStack.add(current);
    chain.unshift(definition);
    current = definition.extendsClassId;
  }
  return chain;
}

/** 合并继承链:同 id 实体按顶层属性逐项合并(子类声明覆写、未声明继承,须同 kind),子类独有实体追加。 */
export function resolveClassTemplate(library: PlantClassDefinition[], classId: string): PlantClassTemplate {
  const chain = resolveClassChain(library, classId);
  const nodes = mergeEntities(chain.map((definition) => definition.nodes));
  const resources = mergeEntities(chain.map((definition) => definition.resources ?? []));
  return { classIds: chain.map((definition) => definition.classId), nodes: nodes as unknown as PlantLiteNode[], resources: resources as unknown as PlantLiteResource[] };
}

/** 把类实例物化进模型(非破坏):原模型不变,返回追加实例节点/资源后的新模型。 */
export function instantiateClass(model: PlantLiteModel, classId: string): PlantLiteModel {
  const library = model.classLibrary;
  if (!library?.length) throw new Error("模型未配置 classLibrary,无法实例化");
  const template = resolveClassTemplate(library, classId);
  if (!template.nodes.length && !template.resources.length) throw new Error(`类 ${classId} 模板为空`);
  const ordinal = nextInstanceOrdinal(model, classId);
  const nodeIds = new Map(template.nodes.map((node) => [node.id, `${classId}.${ordinal}.${node.id}`]));
  const resourceIds = new Map(template.resources.map((resource) => [resource.id, `${classId}.${ordinal}.${resource.id}`]));
  const existing = new Set([...model.nodes, ...(model.resources ?? [])].map((entity) => entity.id));
  for (const id of [...nodeIds.values(), ...resourceIds.values()]) {
    if (existing.has(id)) throw new Error(`实例 ID 冲突: ${id}`);
  }
  const context: ReferenceContext = { classId, ordinal, templateIds: new Set([...nodeIds.keys(), ...resourceIds.keys()]) };
  const instanceNodes = template.nodes.map((entity) => instantiateEntity(entity, nodeIds.get(entity.id)!, classId, context)) as PlantLiteNode[];
  const instanceResources = template.resources.map((entity) => instantiateEntity(entity, resourceIds.get(entity.id)!, classId, context)) as PlantLiteResource[];
  return {
    ...model,
    nodes: [...model.nodes, ...instanceNodes],
    ...(instanceResources.length ? { resources: [...(model.resources ?? []), ...instanceResources] } : {}),
  };
}

/** 实例改 → 该属性断继承:写入属性值并登记覆写开关;身份字段与未知属性显式拒绝。 */
export function setInstanceOverride(
  target: PlantLiteNode | PlantLiteResource,
  propertyName: string,
  value: PlantClassPropertyValue,
): void {
  if (!propertyName || IDENTITY_PROPS.has(propertyName)) {
    throw new Error(`属性 ${propertyName} 是实例身份字段,不允许覆写`);
  }
  if (!(propertyName in target)) throw new Error(`override 路径不存在: ${propertyName}`);
  if (!isJsonSafe(value)) throw new Error(`属性 ${propertyName} 的覆写值必须是 JSON 安全值`);
  const record = target as unknown as Record<string, unknown>;
  record[propertyName] = structuredClone(value);
  target.propertyOverrides = { ...target.propertyOverrides, [propertyName]: structuredClone(value) };
}

/** 类改 → 实例传播:先把 set 补丁落到类模板,再重算链上全部实例的未覆写属性(原地变更)。 */
export function propagateClassChange(model: PlantLiteModel, classId: string, mutation: PlantClassMutation): PlantClassPropagationResult {
  const library = model.classLibrary;
  if (!library?.length) throw new Error("模型未配置 classLibrary,无法传播");
  const definition = library.find((entry) => entry.classId === classId);
  if (!definition) throw new Error(`未知类: ${classId}`);
  applyMutation(definition, mutation);
  const contextByClass = new Map<string, { template: PlantClassTemplate; context: ReferenceContext }>();
  let affectedInstances = 0;
  for (const entity of [...model.nodes, ...(model.resources ?? [])]) {
    const inheritedFrom = entity.inheritedFromClassId;
    if (!inheritedFrom) continue;
    let resolved = contextByClass.get(inheritedFrom);
    if (!resolved) {
      const template = resolveClassTemplate(library, inheritedFrom);
      const ordinal = instanceOrdinalOf(entity.id, inheritedFrom);
      resolved = { template, context: { classId: inheritedFrom, ordinal, templateIds: new Set([...template.nodes, ...template.resources].map((entry) => entry.id)) } };
      contextByClass.set(inheritedFrom, resolved);
    }
    if (!resolved.template.classIds.includes(classId)) continue;
    const templateId = templateEntityIdOf(entity);
    const templateEntity = findTemplateEntity(resolved.template, templateId);
    if (!templateEntity) throw new Error(`类实例 ${entity.id} 缺少模板实体 ${templateId ?? ""}`);
    if (recomputeInstance(entity, templateEntity, resolved.context)) affectedInstances += 1;
  }
  return { classId, affectedInstances };
}

/** 实例 id 的三段式为 `${classId}.${序号}.${模板实体id}`;反解出模板实体 id,非类实例返回 undefined。 */
export function templateEntityIdOf(entity: { id: string; inheritedFromClassId?: string }): string | undefined {
  const classId = entity.inheritedFromClassId;
  if (!classId || !entity.id.startsWith(`${classId}.`)) return undefined;
  return /^(\d+)\.(.+)$/.exec(entity.id.slice(classId.length + 1))?.[2];
}

function instanceOrdinalOf(instanceId: string, classId: string): number {
  return Number(/^(\d+)\./.exec(instanceId.slice(classId.length + 1))?.[1] ?? 0);
}

function applyMutation(definition: PlantClassDefinition, mutation: PlantClassMutation): void {
  for (const [key, value] of Object.entries(mutation.set)) {
    const separator = key.indexOf(".");
    const entityId = separator > 0 ? key.slice(0, separator) : "";
    const propertyName = separator > 0 ? key.slice(separator + 1) : "";
    if (!entityId || !propertyName) throw new Error(`变更键必须是 "<模板实体id>.<属性名>": ${key}`);
    if (IDENTITY_PROPS.has(propertyName)) throw new Error(`属性 ${propertyName} 是身份字段,不允许通过类变更修改`);
    const entity = definition.nodes.find((node) => node.id === entityId) ?? definition.resources?.find((resource) => resource.id === entityId);
    if (!entity) throw new Error(`类 ${definition.classId} 不存在实体 ${entityId}`);
    if (!isJsonSafe(value)) throw new Error(`变更值必须是 JSON 安全值: ${key}`);
    (entity as unknown as Record<string, unknown>)[propertyName] = structuredClone(value);
  }
}

/** 只把未断继承的行为属性从模板同步到实例;返回是否有属性值实际变化。 */
function recomputeInstance(entity: PlantLiteNode | PlantLiteResource, templateEntity: Record<string, unknown>, context: ReferenceContext): boolean {
  const record = entity as unknown as Record<string, unknown>;
  const overrides = record.propertyOverrides as Record<string, unknown> | undefined;
  let changed = false;
  for (const [propertyName, templateValue] of Object.entries(templateEntity)) {
    if (IDENTITY_PROPS.has(propertyName)) continue;
    if (overrides && propertyName in overrides) continue;
    const nextValue = resolveInheritedValue(propertyName, templateValue, record.kind, context);
    if (!jsonEquals(record[propertyName], nextValue)) {
      record[propertyName] = nextValue;
      changed = true;
    }
  }
  return changed;
}

/** 模板值落到实例前的解析:引用属性按内部映射改写,其余深拷贝(传播不得踩掉实例级引用)。 */
function resolveInheritedValue(propertyName: string, templateValue: unknown, kind: unknown, context: ReferenceContext): unknown {
  if ((kind === "station" || kind === "transport") && (propertyName === "resourceId" || propertyName === "workerResourceId")) {
    return mapInternalReference(templateValue, context);
  }
  if (kind === "split" && propertyName === "routes" && Array.isArray(templateValue)) {
    return templateValue.map((route) => route !== null && typeof route === "object" && "to" in route
      ? { ...(route as Record<string, unknown>), to: mapInternalReference((route as Record<string, unknown>).to, context) }
      : structuredClone(route));
  }
  return structuredClone(templateValue);
}

function mapInternalReference(value: unknown, context: ReferenceContext): unknown {
  if (typeof value !== "string") return value;
  return context.templateIds.has(value) ? `${context.classId}.${context.ordinal}.${value}` : value;
}

function findTemplateEntity(template: PlantClassTemplate, templateId: string | undefined): Record<string, unknown> | undefined {
  if (!templateId) return undefined;
  const entity = template.nodes.find((node) => node.id === templateId) ?? template.resources.find((resource) => resource.id === templateId);
  return entity ? (entity as unknown as Record<string, unknown>) : undefined;
}

function mergeEntities(layers: Array<Array<PlantLiteNode | PlantLiteResource>>): Array<Record<string, unknown>> {
  const byId = new Map<string, Record<string, unknown>>();
  const order: string[] = [];
  for (const layer of layers) {
    for (const entity of layer) {
      const record = entity as unknown as Record<string, unknown>;
      const entityId = record.id as string;
      const existing = byId.get(entityId);
      if (!existing) {
        byId.set(entityId, structuredClone(record));
        order.push(entityId);
        continue;
      }
      if (existing.kind !== record.kind) throw new Error(`实体 ${entityId} 在继承链上 kind 不一致`);
      const merged = { ...structuredClone(existing) };
      for (const [propertyName, value] of Object.entries(record)) merged[propertyName] = structuredClone(value);
      byId.set(entityId, merged);
    }
  }
  return order.map((id) => byId.get(id)!);
}

function instantiateEntity(entity: PlantLiteNode | PlantLiteResource, nextId: string, classId: string, context: ReferenceContext): PlantLiteNode | PlantLiteResource {
  const clone = structuredClone(entity) as unknown as Record<string, unknown>;
  delete clone.propertyOverrides;
  clone.id = nextId;
  clone.inheritedFromClassId = classId;
  if (clone.kind === "station" || clone.kind === "transport") {
    for (const propertyName of ["resourceId", "workerResourceId"]) {
      if (clone[propertyName] !== undefined) clone[propertyName] = mapInternalReference(clone[propertyName], context);
    }
  }
  if (clone.kind === "split" && Array.isArray(clone.routes)) {
    clone.routes = clone.routes.map((route: Record<string, unknown>) =>
      "to" in route ? { ...route, to: mapInternalReference(route.to, context) } : route);
  }
  return clone as unknown as PlantLiteNode | PlantLiteResource;
}

function nextInstanceOrdinal(model: PlantLiteModel, classId: string): number {
  const pattern = new RegExp(`^${escapeRegExp(classId)}\\.(\\d+)\\.`);
  let maximum = 0;
  for (const entity of [...model.nodes, ...(model.resources ?? [])]) {
    if (entity.inheritedFromClassId !== classId) continue;
    const match = pattern.exec(entity.id);
    if (match) maximum = Math.max(maximum, Number(match[1]));
  }
  return maximum + 1;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** JSON 安全值域检查(标量/纯对象/数组递归);校验层与覆写共用同一口径。 */
export function isJsonSafe(value: unknown): boolean {
  if (value === null) return false;
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "object") {
    return Array.isArray(value) ? value.every(isJsonSafe) : Object.values(value as object).every(isJsonSafe);
  }
  return false;
}

function jsonEquals(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => jsonEquals(item, right[index]));
  }
  if (typeof left === "object") {
    const leftKeys = Object.keys(left as object);
    const rightKeys = Object.keys(right as object);
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key) => key in (right as object) && jsonEquals((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
  }
  return false;
}
