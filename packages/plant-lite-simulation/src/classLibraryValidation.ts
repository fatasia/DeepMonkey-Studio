/**
 * 类库与类实例的模型校验(最小增量,挂接在 validatePlantLiteModel 内)。
 * 结构问题(继承环、未知父类、kind 冲突、路径不安全)一律阻塞;实例覆写用与传播
 * 同一套合并规则核对属性存在性,保证"校验通过的覆写必然可被传播重算"。
 * 模板实体只做结构级检查(id/kind/路径安全),属性域的完整校验由实例化后的
 * 平面模型走既有 validateNode/validateResource 兜底。
 */

import type { PlantClassDefinition, PlantLiteModelIssue } from "./modelTypes.js";
import { isJsonSafe, templateEntityIdOf } from "./classLibraryRuntime.js";

const NODE_KINDS = new Set(["source", "station", "transport", "buffer", "queue-buffer", "split", "sink"]);
const RESOURCE_KINDS = new Set(["agv", "transport", "equipment", "worker"]);
const FORBIDDEN_OVERRIDE_PROPS = new Set(["id", "name", "kind", "inheritedFromClassId", "propertyOverrides"]);
/** classId 出现在实例 id 三段式首段,必须路径安全;模板实体 id 出现在末段,同样禁止点号。 */
const PATH_SAFE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function validateClassLibrary(input: Record<string, unknown>, issues: PlantLiteModelIssue[]): void {
  if (input.classLibrary === undefined) return;
  if (!Array.isArray(input.classLibrary)) {
    issues.push({ path: "$.classLibrary", message: "必须是数组" });
    return;
  }
  const definitions = collectDefinitions(input.classLibrary, issues);
  const broken = collectStructuralIssues(definitions, issues);
  const merged = collectMergedTemplates(definitions, broken, issues);
  validateInstances(input, definitions, merged, issues);
}

function collectDefinitions(entries: unknown[], issues: PlantLiteModelIssue[]): PlantClassDefinition[] {
  const definitions: PlantClassDefinition[] = [];
  const classIds = new Set<string>();
  entries.forEach((entry, index) => {
    const path = `$.classLibrary[${index}]`;
    if (!isRecord(entry)) return void issues.push({ path, message: "必须是对象" });
    validatePathSafeText(entry.classId, `${path}.classId`, issues);
    validateText(entry.name, `${path}.name`, issues);
    if (typeof entry.classId === "string" && entry.classId) {
      if (classIds.has(entry.classId)) issues.push({ path: `${path}.classId`, message: "classId 重复" });
      classIds.add(entry.classId);
    }
    validateTemplateEntities(entry.nodes, `${path}.nodes`, NODE_KINDS, issues);
    if (entry.resources !== undefined) validateTemplateEntities(entry.resources, `${path}.resources`, RESOURCE_KINDS, issues);
    definitions.push(entry as unknown as PlantClassDefinition);
  });
  definitions.forEach((definition, index) => {
    if (definition.extendsClassId === undefined) return;
    const path = `$.classLibrary[${index}].extendsClassId`;
    validateText(definition.extendsClassId, path, issues);
    if (typeof definition.extendsClassId === "string" && !classIds.has(definition.extendsClassId)) {
      issues.push({ path, message: "未知父类" });
    }
  });
  return definitions;
}

/** 继承环与"父类缺失"标记:被标记的类不可安全合并,其上的实例检查跳过(类本身已阻塞)。 */
function collectStructuralIssues(definitions: PlantClassDefinition[], issues: PlantLiteModelIssue[]): Set<string> {
  const broken = new Set<string>();
  const byId = new Map<string, PlantClassDefinition>(definitions.map((definition) => [definition.classId, definition]));
  for (const definition of definitions) {
    const visiting = new Set<string>();
    let current: string | undefined = definition.classId;
    while (current !== undefined) {
      if (visiting.has(current)) {
        issues.push({ path: `$.classLibrary.${definition.classId}.extendsClassId`, message: "继承链存在环" });
        broken.add(definition.classId);
        break;
      }
      visiting.add(current);
      const parent: string | undefined = byId.get(current)?.extendsClassId;
      if (parent !== undefined && !byId.has(parent)) {
        broken.add(definition.classId);
        break;
      }
      current = parent;
    }
  }
  return broken;
}

/** 对结构可信的类沿链(根→叶)合并实体属性名;同 id 实体 kind 冲突记为问题并放弃该类。 */
function collectMergedTemplates(
  definitions: PlantClassDefinition[],
  broken: Set<string>,
  issues: PlantLiteModelIssue[],
): Map<string, Map<string, Set<string>>> {
  const merged = new Map<string, Map<string, Set<string>>>();
  const byId = new Map<string, PlantClassDefinition>(definitions.map((definition) => [definition.classId, definition]));
  for (const definition of definitions) {
    if (broken.has(definition.classId)) continue;
    const chain: PlantClassDefinition[] = [];
    let current: PlantClassDefinition | undefined = definition;
    while (current !== undefined) {
      chain.unshift(current);
      current = current.extendsClassId !== undefined ? byId.get(current.extendsClassId) : undefined;
    }
    const kinds = new Map<string, string>();
    const props = new Map<string, Set<string>>();
    let sound = true;
    for (const entry of chain) {
      for (const entity of [...entry.nodes, ...(entry.resources ?? [])]) {
        const kind = String(entity.kind ?? "");
        const knownKind = kinds.get(entity.id);
        if (knownKind === undefined) {
          kinds.set(entity.id, kind);
          props.set(entity.id, new Set(Object.keys(entity)));
          continue;
        }
        if (knownKind !== kind) {
          issues.push({ path: `$.classLibrary.${definition.classId}.nodes.${entity.id}.kind`, message: "同 id 实体在继承链上 kind 不一致" });
          broken.add(definition.classId);
          sound = false;
          break;
        }
        for (const propertyName of Object.keys(entity)) props.get(entity.id)!.add(propertyName);
      }
      if (!sound) break;
    }
    if (sound) merged.set(definition.classId, props);
  }
  return merged;
}

function validateTemplateEntities(value: unknown, path: string, kinds: Set<string>, issues: PlantLiteModelIssue[]): void {
  if (!Array.isArray(value)) return void issues.push({ path, message: "必须是数组" });
  const ids = new Set<string>();
  value.forEach((entity, index) => {
    const entityPath = `${path}[${index}]`;
    if (!isRecord(entity)) return void issues.push({ path: entityPath, message: "必须是对象" });
    validatePathSafeText(entity.id, `${entityPath}.id`, issues);
    validateText(entity.name, `${entityPath}.name`, issues);
    if (typeof entity.id === "string" && entity.id) {
      if (ids.has(entity.id)) issues.push({ path: `${entityPath}.id`, message: "实体 id 重复" });
      ids.add(entity.id);
    }
    if (typeof entity.kind !== "string" || !kinds.has(entity.kind)) {
      issues.push({ path: `${entityPath}.kind`, message: "未知实体类型" });
    }
    if (entity.inheritedFromClassId !== undefined || entity.propertyOverrides !== undefined) {
      issues.push({ path: entityPath, message: "类模板实体不得携带实例簿记字段(inheritedFromClassId/propertyOverrides)" });
    }
  });
}

function validateInstances(
  input: Record<string, unknown>,
  definitions: PlantClassDefinition[],
  merged: Map<string, Map<string, Set<string>>>,
  issues: PlantLiteModelIssue[],
): void {
  const known = new Set(definitions.map((definition) => definition.classId));
  for (const collection of ["nodes", "resources"] as const) {
    const entries = input[collection];
    if (!Array.isArray(entries)) continue;
    for (const entity of entries) {
      if (!isRecord(entity) || entity.inheritedFromClassId === undefined) continue;
      const id = typeof entity.id === "string" ? entity.id : "?";
      const inheritedFrom = entity.inheritedFromClassId;
      const path = `$.${collection}.${id}`;
      if (typeof inheritedFrom !== "string" || !known.has(inheritedFrom)) {
        issues.push({ path: `${path}.inheritedFromClassId`, message: "未知类" });
        continue;
      }
      const templateProps = merged.get(inheritedFrom);
      if (!templateProps) continue;
      const templateId = templateEntityIdOf({ id, inheritedFromClassId: inheritedFrom });
      const entityProps = templateId !== undefined ? templateProps.get(templateId) : undefined;
      if (!entityProps) {
        issues.push({ path: `${path}.id`, message: "实例 id 必须采用 classId.序号.模板实体id 三段式且模板实体存在" });
        continue;
      }
      validateInstanceOverrides(entity.propertyOverrides, `${path}.propertyOverrides`, entityProps, issues);
    }
  }
}

function validateInstanceOverrides(value: unknown, path: string, templateProps: Set<string>, issues: PlantLiteModelIssue[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) return void issues.push({ path, message: "必须是对象" });
  for (const [propertyName, overrideValue] of Object.entries(value)) {
    if (FORBIDDEN_OVERRIDE_PROPS.has(propertyName)) {
      issues.push({ path: `${path}.${propertyName}`, message: "身份字段不允许覆写" });
      continue;
    }
    if (!templateProps.has(propertyName)) {
      issues.push({ path: `${path}.${propertyName}`, message: `override 路径不存在: ${propertyName}` });
      continue;
    }
    if (!isJsonSafe(overrideValue)) issues.push({ path: `${path}.${propertyName}`, message: "覆写值必须是 JSON 安全值" });
  }
}

function validateText(value: unknown, path: string, issues: PlantLiteModelIssue[]): void {
  if (typeof value !== "string" || !value.trim() || value.length > 120) {
    issues.push({ path, message: "必须是 1 到 120 个字符的文本" });
  }
}

function validatePathSafeText(value: unknown, path: string, issues: PlantLiteModelIssue[]): void {
  validateText(value, path, issues);
  if (typeof value === "string" && !PATH_SAFE.test(value)) {
    issues.push({ path, message: "只能包含字母、数字、下划线与连字符,且以字母或数字开头" });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
