import type { ApplicationDocument, ApplicationObjectRef } from "@bim-studio/contracts";

export interface SceneScriptTarget {
  id: string;
  name: string;
  kind: "object" | "component";
  context: string;
  runtime?: "unity";
}

export interface SceneScriptIntelligenceContext {
  targets: SceneScriptTarget[];
  references: SceneScriptReference[];
  dataKeys: string[];
  eventNames: string[];
}

export interface SceneScriptReference {
  id: string;
  name: string;
  kind: "scene" | "page" | "cameraView";
  context: string;
}

/**
 * 根据当前工作区选择解析脚本首选目标。
 * 二维组件优先于三维回退目标，未找到对应上下文时保留回退值，避免打开脚本时丢失语境。
 */
export function resolvePreferredScriptTarget(
  targets: readonly SceneScriptTarget[],
  selection: readonly ApplicationObjectRef[],
  fallback?: SceneScriptTarget,
): SceneScriptTarget | undefined {
  const selectedWidget = selection.find((item) => item.kind === "widget");
  if (selectedWidget) {
    const target = targets.find((item) => item.kind === "component" && item.id === selectedWidget.id);
    if (target) return target;
  }
  return fallback;
}

const BUILTIN_EVENTS = [
  "click", "doubleClick", "pointerEnter", "pointerLeave", "dataChange",
  "sceneReady", "animationStart", "animationEnd",
  // B3-c 物理可观测性：碰撞事件由物理运行时派发，payload.other 为对端对象 id（地面为 null）。
  "collisionStart", "collisionEnd"
];

/**
 * One authoring context shared by the script library and Monaco intelligence.
 * Runtime objects remain identified by stable ids; display names are only labels.
 */
export function buildSceneScriptContext(application: ApplicationDocument | undefined): SceneScriptIntelligenceContext {
  if (!application) return { targets: [], references: [], dataKeys: [], eventNames: [...BUILTIN_EVENTS] };
  const targets: SceneScriptTarget[] = [];
  const references: SceneScriptReference[] = [];
  const dataKeys = new Set(application.data.variables.map((variable) => variable.id).filter(Boolean));
  const eventNames = new Set(BUILTIN_EVENTS);

  for (const scene of application.scenes) {
    references.push({ id: scene.id, name: scene.name, kind: "scene", context: scene.name });
    for (const view of scene.cameraViews ?? []) references.push({ id: view.id, name: view.name, kind: "cameraView", context: scene.name });
    for (const model of [...scene.models, ...scene.primitives]) {
      targets.push({ id: model.modelId, name: model.name, kind: "object", context: scene.name });
    }
  }
  for (const page of application.pages) {
    references.push({ id: page.id, name: page.name, kind: "page", context: page.name });
    for (const node of page.nodes) {
      const name = node.name || (node.kind === "data-widget" ? node.widget.title : "3D viewport") || node.id;
      targets.push({
        id: node.id, name, kind: "component", context: page.name,
        ...(node.kind === "data-widget" && node.widget.type === "unity" ? { runtime: "unity" as const } : {}),
      });
      if (node.kind !== "data-widget") continue;
      if (node.widget.key) dataKeys.add(node.widget.key);
      if (node.widget.field) dataKeys.add(node.widget.field);
      for (const eventName of node.widget.unityEventNames ?? []) {
        if (!eventName) continue;
        eventNames.add(eventName);
        if (node.widget.key) dataKeys.add(`unity.${node.widget.key}.${eventName}`);
      }
    }
  }
  for (const flow of application.interactions) eventNames.add(flow.trigger);

  return {
    targets: dedupeTargets(targets),
    references: dedupeReferences(references),
    dataKeys: [...dataKeys].sort(naturalCompare),
    eventNames: [...eventNames].sort(naturalCompare)
  };
}

/** Monaco extra-lib declarations generated from the same context used by completion lists. */
export function buildSceneScriptTypeDeclarations(context: SceneScriptIntelligenceContext): string {
  const byKind = (kind: SceneScriptTarget["kind"]) => literalUnion(context.targets.filter((item) => item.kind === kind).map((item) => item.id));
  const references = (kind: SceneScriptReference["kind"]) => literalUnion(context.references.filter((item) => item.kind === kind).map((item) => item.id));
  return `
interface StudioProjectIdentifiers {
  object: ${byKind("object")};
  component: ${byKind("component")};
  unityComponent: ${literalUnion(context.targets.filter((item) => item.runtime === "unity").map((item) => item.id))};
  dataKey: ${literalUnion(context.dataKeys)};
  scene: ${references("scene")};
  page: ${references("page")};
  cameraView: ${references("cameraView")};
}
interface StudioProjectEventNames { ${literalKeyMap(context.eventNames)} }
`;
}

function dedupeReferences(references: SceneScriptReference[]): SceneScriptReference[] {
  const seen = new Set<string>();
  return references.filter((reference) => {
    const key = `${reference.kind}:${reference.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((left, right) => naturalCompare(left.name, right.name));
}

function dedupeTargets(targets: SceneScriptTarget[]): SceneScriptTarget[] {
  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = `${target.kind}:${target.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((left, right) => naturalCompare(left.name, right.name));
}

function naturalCompare(left: string, right: string): number {
  return left.localeCompare(right, "zh-CN", { numeric: true, sensitivity: "base" });
}

function literalUnion(values: readonly string[]): string {
  const unique = [...new Set(values.filter(Boolean))];
  return unique.length ? unique.map((value) => JSON.stringify(value)).join(" | ") : "string";
}

function literalKeyMap(values: readonly string[]): string {
  return [...new Set(values.filter(Boolean))].map((value) => `${JSON.stringify(value)}: true;`).join(" ");
}
