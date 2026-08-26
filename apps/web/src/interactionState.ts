import type {
  SceneInteractionActionState,
  SceneInteractionActionType,
  SceneInteractionScriptState,
  SceneInteractionTarget,
  SceneInteractionTrigger
} from "@bim-studio/contracts";

export const INTERACTION_TRIGGERS: SceneInteractionTrigger[] = [
  "load",
  "click",
  "doubleClick",
  "contextMenu",
  "pointerEnter",
  "pointerLeave",
  "animationStart",
  "animationEnd"
];

export const OBJECT_INTERACTION_ACTIONS: SceneInteractionActionType[] = ["visibility", "color", "opacity", "focus", "animation", "cameraView", "navigateScene", "message", "dashboard", "setData", "openUrl"];
export const WIDGET_INTERACTION_ACTIONS: SceneInteractionActionType[] = ["navigateScene", "cameraView", "message", "dashboard", "setData", "openUrl"];

export function createInteractionAction(type: SceneInteractionActionType): SceneInteractionActionState {
  const defaults: Partial<Record<SceneInteractionActionType, Partial<SceneInteractionActionState>>> = {
    visibility: { value: "toggle" },
    color: { value: "#ff4057" },
    opacity: { value: 0.5 },
    animation: { value: "toggle" },
    message: { message: "操作完成" },
    setData: { dataKey: "value", value: 0 },
    openUrl: { url: "https://example.com", newTab: true }
  };
  return { id: crypto.randomUUID(), type, enabled: true, ...defaults[type] };
}

export function createInteractionScript(target: SceneInteractionTarget, trigger: SceneInteractionTrigger): SceneInteractionScriptState {
  return {
    id: crypto.randomUUID(),
    name: "默认事件",
    target: { ...target },
    trigger,
    enabled: true,
    actions: [],
    code: defaultInteractionCode(trigger, target.kind)
  };
}

export function normalizeInteractionScripts(value: unknown): SceneInteractionScriptState[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((candidate, index) => {
    if (!candidate || typeof candidate !== "object") return [];
    const item = candidate as Partial<SceneInteractionScriptState>;
    const target = item.target;
    if (!target || (target.kind !== "object" && target.kind !== "widget")) return [];
    if (target.kind === "object" && (typeof target.modelId !== "string" || !target.modelId.trim())) return [];
    if (target.kind === "widget" && (typeof target.widgetId !== "string" || !target.widgetId.trim())) return [];
    if (!INTERACTION_TRIGGERS.includes(item.trigger as SceneInteractionTrigger)) return [];
    let id = typeof item.id === "string" && item.id.trim() ? item.id : `interaction-${index}`;
    while (seen.has(id)) id = `${id}-${index}`;
    seen.add(id);
    const normalizedTarget: SceneInteractionTarget = target.kind === "widget"
      ? { kind: "widget", widgetId: target.widgetId }
      : { kind: "object", modelId: target.modelId, ...(typeof target.layerId === "string" && target.layerId ? { layerId: target.layerId } : {}) };
    return [{
      id,
      name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : "默认事件",
      target: normalizedTarget,
      trigger: item.trigger!,
      enabled: item.enabled !== false,
      actions: normalizeInteractionActions(item.actions, normalizedTarget.kind),
      code: typeof item.code === "string" ? item.code : defaultInteractionCode(item.trigger!, normalizedTarget.kind)
    }];
  }).slice(0, 500);
}

export function normalizeInteractionActions(value: unknown, targetKind: SceneInteractionTarget["kind"]): SceneInteractionActionState[] {
  if (!Array.isArray(value)) return [];
  const allowed = new Set(targetKind === "widget" ? WIDGET_INTERACTION_ACTIONS : OBJECT_INTERACTION_ACTIONS);
  return value.flatMap((candidate, index) => {
    if (!candidate || typeof candidate !== "object") return [];
    const item = candidate as Partial<SceneInteractionActionState>;
    if (!item.type || !allowed.has(item.type)) return [];
    const action = createInteractionAction(item.type);
    action.id = typeof item.id === "string" && item.id ? item.id : `interaction-action-${index}`;
    action.enabled = item.enabled !== false;
    if (typeof item.value === "string" || typeof item.value === "number" || typeof item.value === "boolean") action.value = item.value;
    if (typeof item.url === "string") action.url = item.url.slice(0, 2048);
    if (typeof item.newTab === "boolean") action.newTab = item.newTab;
    if (item.target?.kind === "object" && typeof item.target.modelId === "string" && item.target.modelId) action.target = { kind: "object", modelId: item.target.modelId, ...(typeof item.target.layerId === "string" && item.target.layerId ? { layerId: item.target.layerId } : {}) };
    if (typeof item.sceneId === "string") action.sceneId = item.sceneId;
    if (typeof item.dashboardPageId === "string") action.dashboardPageId = item.dashboardPageId;
    if (typeof item.cameraViewId === "string") action.cameraViewId = item.cameraViewId;
    if (typeof item.message === "string") action.message = item.message.slice(0, 500);
    if (typeof item.dataKey === "string") action.dataKey = item.dataKey.slice(0, 200);
    return [action];
  }).slice(0, 20);
}

export function interactionActionLabel(type: SceneInteractionActionType, locale: "zh-CN" | "en-US"): string {
  const labels: Record<SceneInteractionActionType, [string, string]> = {
    visibility: ["显示 / 隐藏", "Show / hide"],
    color: ["改变颜色", "Change color"],
    opacity: ["调整透明度", "Set opacity"],
    focus: ["定位对象", "Focus object"],
    animation: ["模型动画", "Model animation"],
    openUrl: ["打开网页", "Open web page"],
    navigateScene: ["跳转场景", "Navigate scene"],
    cameraView: ["切换相机视角", "Switch camera view"],
    message: ["显示提示", "Show message"],
    dashboard: ["打开二维页面", "Open dashboard page"],
    setData: ["设置数据值", "Set data value"]
  };
  return labels[type][locale === "zh-CN" ? 0 : 1];
}

export function defaultInteractionCode(trigger: SceneInteractionTrigger, targetKind: SceneInteractionTarget["kind"] = "object"): string {
  return `/**
 * ${triggerLabel(trigger, "zh-CN")}
 * ctx.target   ${targetKind === "widget" ? "当前二维看板组件及组件配置" : "当前模型、图层和 Three.js Object3D"}
 * ctx.event    当前事件、坐标和原始浏览器事件
 * ctx.engine   ViewerEngine 完整实例
 * ctx.scene    THREE.Scene
 * ctx.camera   THREE.PerspectiveCamera
 * ctx.renderer Three.js Renderer
 * ctx.controls orbit / pointer / transform 控制器
 * ctx.objects  场景中的模型、标注、灯光和 Fragments 集合
 * THREE        Three.js 完整命名空间
 */

// 示例：console.log("${triggerLabel(trigger, "zh-CN")}", ctx.target, ctx.event);
`;
}

export function triggerLabel(trigger: SceneInteractionTrigger, locale: "zh-CN" | "en-US"): string {
  const labels: Record<SceneInteractionTrigger, [string, string]> = {
    load: ["加载完成", "Loaded"],
    click: ["点击", "Click"],
    doubleClick: ["双击", "Double click"],
    contextMenu: ["右键", "Context menu"],
    pointerEnter: ["鼠标进入", "Pointer enter"],
    pointerLeave: ["鼠标离开", "Pointer leave"],
    animationStart: ["动画开始", "Animation start"],
    animationEnd: ["动画结束", "Animation end"]
  };
  return labels[trigger][locale === "zh-CN" ? 0 : 1];
}

export function sameInteractionTarget(left: SceneInteractionTarget, right: SceneInteractionTarget): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "widget" && right.kind === "widget") return left.widgetId === right.widgetId;
  if (left.kind === "object" && right.kind === "object") return left.modelId === right.modelId && (left.layerId ?? "") === (right.layerId ?? "");
  return false;
}
