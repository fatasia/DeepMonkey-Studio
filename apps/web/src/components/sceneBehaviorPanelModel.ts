import type { ApplicationScriptTarget } from "@bim-studio/contracts";
import type { SceneCapability } from "@bim-studio/scene-sdk";
import type { SceneBehaviorManagerEntry } from "../behavior/SceneBehaviorManager";
import { translate as tr, type AppLocale } from "../i18n";
import type { SceneScriptTarget } from "../studio/sceneScriptContext";

export type SceneScriptResourceSnippetKind = "data-read" | "data-write" | "event-listen" | "event-condition" | "event-emit";

export function sceneScriptResourceSnippet(kind: SceneScriptResourceSnippetKind, value: string): string {
  const literal = JSON.stringify(value);
  const variable = safeIdentifier(value.split(/[./:-]/).at(-1) ?? "value", "value");
  if (kind === "data-read") return `const ${variable} = ctx.getData(${literal});\nctx.log(${literal}, ${variable});`;
  if (kind === "data-write") return `ctx.setData(${literal}, 0);`;
  if (kind === "event-emit") return `ctx.emit(${literal}, { source: ctx.sceneId });`;
  const condition = `if (ctx.event?.name === ${literal}) {\n  ctx.log(${literal}, ctx.event.data);\n}`;
  return kind === "event-condition" ? condition : `function onEvent(ctx) {\n  ${condition.replaceAll("\n", "\n  ")}\n}`;
}

export function safeIdentifier(name: string, fallback: string): string {
  const normalized = name
    .trim()
    .replace(/[^A-Za-z0-9_$]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
  if (!normalized) return fallback;
  return /^[A-Za-z_$]/.test(normalized) ? normalized : `_${normalized}`;
}

export function capabilitySnippet(capability: SceneCapability): string {
  const snippets: Record<SceneCapability, string> = {
    "studio.scene": "const sceneState = studio.scene.statistics();",
    "studio.object": 'const selectedObject = studio.object("object-id");\nselectedObject?.focus();',
    "studio.component": 'const component = studio.component("component-id");\ncomponent?.update({ visible: true });',
    "studio.unity": 'const unity = studio.unity("unity-component-id");\nunity.setProperties({ lightIntensity: 1.5 });',
    "studio.mesh": 'const mesh = studio.raw.scene?.getObjectByName("mesh-name");',
    "studio.material": 'const materialOwner = studio.object("object-id");\nmaterialOwner?.setColor("#35a7ff");',
    "studio.camera": "studio.camera.setPose([12, 6, 12], [0, 1, 0], { near: 0.05, far: 100000 });",
    "studio.controls": 'studio.camera.setMode("firstPerson");\nstudio.camera.setCollision(true, 0.32);',
    "studio.animation": 'studio.object("object-id")?.playAnimation();',
    "studio.timeline": "studio.animation.seek(0);\nstudio.animation.play();",
    "studio.input": "// Handle input through onEvent(ctx) and inspect ctx.event.",
    "studio.data": 'const value = studio.getData("data.key");\nstudio.log("data.key", value);',
    "studio.ai": 'const result = await studio.ai.invoke("capability.id", { value: 1 });\nstudio.log("AI capability result", result);',
    "studio.runtime": 'studio.log("Runtime ready", { version: studio.version });',
  };
  return snippets[capability];
}

export function runtimeStatus(status: SceneBehaviorManagerEntry["diagnostics"]["status"], locale: AppLocale): string {
  const labels = {
    idle: ["空闲", "Idle"], initializing: ["初始化", "Initializing"], running: ["运行中", "Running"],
    paused: ["已暂停", "Paused"], disposing: ["停止中", "Stopping"], disposed: ["已停止", "Stopped"], error: ["错误", "Error"],
  } as const;
  const pair = labels[status];
  return locale === "zh-CN" ? pair[0] : pair[1];
}

export function defaultBehaviorCode(target?: ApplicationScriptTarget): string {
  const attachedExample = target && target.kind !== "scene" ? '\n  ctx.self?.show();' : "";
  return `function onStart(ctx) {
  ctx.log("Behavior started", { sceneId: ctx.sceneId });${attachedExample}
}

function onUpdate(ctx) {
  // 通过稳定对象句柄和生命周期编辑场景；高级用户也可使用 THREE。
  // studio.object("AGV-01").setPosition(0, 0, ctx.elapsedTime);
}

function onDispose(ctx) {
  ctx.log("Behavior stopped");
}`;
}

export function targetMatches(target: ApplicationScriptTarget | undefined, preferred: SceneScriptTarget | undefined): boolean {
  return Boolean(preferred && target && target.kind !== "scene" && target.kind === preferred.kind && target.id === preferred.id);
}

export function scriptTargetLabel(target: ApplicationScriptTarget | undefined, targets: readonly SceneScriptTarget[], locale: AppLocale): string {
  if (!target || target.kind === "scene") return tr(locale, "整个场景", "Whole scene");
  return targets.find((candidate) => candidate.kind === target.kind && candidate.id === target.id)?.name ?? target.id;
}
