import type { ApplicationScriptLifecycle, ApplicationScriptPermission, ScriptModule } from "@bim-studio/contracts";
import type { SceneCapability } from "@bim-studio/scene-sdk";
import type { SceneScriptIntelligenceContext } from "./sceneScriptContext";

export interface SceneScriptIssue {
  code: "missing-lifecycle" | "missing-capability" | "missing-permission" | "unknown-reference" | "unsupported-api" | "runtime-error";
  severity: "error" | "warning";
  message: string;
  line: number;
  column: number;
  endColumn: number;
}

export interface SceneScriptAnalysis {
  lifecycle: ApplicationScriptLifecycle[];
  capabilities: SceneCapability[];
  permissions: ApplicationScriptPermission[];
  missingCapabilities: SceneCapability[];
  missingPermissions: ApplicationScriptPermission[];
  issues: SceneScriptIssue[];
}

const LIFECYCLE_NAMES: ApplicationScriptLifecycle[] = ["onStart", "onUpdate", "onFixedUpdate", "onData", "onEvent", "onStop", "onDispose"];
const CAPABILITY_RULES: ReadonlyArray<{ pattern: RegExp; capability: SceneCapability }> = [
  { pattern: /\b(?:studio|ctx)\.objects?\s*\(/, capability: "studio.object" },
  { pattern: /\bstudio\.component\s*\(/, capability: "studio.component" },
  { pattern: /\bstudio\.unity\s*\(/, capability: "studio.unity" },
  { pattern: /\bstudio\.camera\b/, capability: "studio.camera" },
  { pattern: /\bstudio\.scene\b/, capability: "studio.scene" },
  { pattern: /\bstudio\.animation\b/, capability: "studio.animation" },
  { pattern: /\.(?:playAnimation|pauseAnimation|stopAnimation|seekAnimation)\s*\(/, capability: "studio.animation" },
  { pattern: /\b(?:studio|ctx)\.(?:getData|setData)\s*\(/, capability: "studio.data" },
  { pattern: /\bstudio\.ai\.invoke\s*\(/, capability: "studio.ai" },
  { pattern: /\b(?:studio|ctx)\.(?:log|emit)\s*\(/, capability: "studio.runtime" }
];
const PERMISSION_RULES: ReadonlyArray<{ pattern: RegExp; permission: ApplicationScriptPermission }> = [
  { pattern: /\b(?:studio|ctx)\.(?:objects?|component|unity|camera|scene|animation|command)\b/, permission: "scene.write" },
  { pattern: /\b(?:studio|ctx)\.getData\s*\(/, permission: "data.read" },
  { pattern: /\b(?:studio|ctx)\.setData\s*\(/, permission: "data.write" },
  { pattern: /\bstudio\.ai\.invoke\s*\(/, permission: "ai.invoke" },
  { pattern: /\b(?:studio\.net|net)\.(?:fetch|request)\s*\(|\bfetch\s*\(/, permission: "network.connect" }
];
const WORKER_UNSUPPORTED_API: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /\bstudio\.(?:scene|page|animation)\b/g, label: "该 API 目前只在可信交互脚本中开放" },
  { pattern: /\bstudio\.camera\.(?:getState|setMode|setClip|setCollision|setStandardView|applyView)\b/g, label: "Worker 相机当前只开放 setPose 和 focus" },
  { pattern: /\bstudio\.(?:raw|objects|query|components|updateComponent|action)\b/g, label: "该 API 需要可信主线程上下文" },
  { pattern: /\b(?:app|engine)\b/g, label: "Worker 不暴露应用或渲染引擎对象" }
];

/** Static, project-aware checks for the small public Scene SDK surface. */
export function analyzeSceneScript(
  code: string,
  script: Pick<ScriptModule, "lifecycle" | "capabilities" | "permissions" | "target">,
  context: SceneScriptIntelligenceContext,
): SceneScriptAnalysis {
  const executableCode = maskJavaScriptComments(code);
  const lifecycle = LIFECYCLE_NAMES.filter((name) => new RegExp(`\\b(?:async\\s+)?function\\s+${name}\\s*\\(|\\b(?:const|let|var)\\s+${name}\\s*=`).test(executableCode));
  const capabilities = CAPABILITY_RULES.filter((rule) => rule.pattern.test(executableCode)).map((rule) => rule.capability);
  const permissions = PERMISSION_RULES.filter((rule) => rule.pattern.test(executableCode)).map((rule) => rule.permission);
  const usesAttachedTarget = /\bctx\.self\b/.test(executableCode);
  if (usesAttachedTarget && script.target?.kind === "object") capabilities.push("studio.object");
  if (usesAttachedTarget && script.target?.kind === "component") capabilities.push("studio.component");
  if (usesAttachedTarget && script.target && script.target.kind !== "scene") permissions.push("scene.write");
  const uniqueCapabilities = unique(capabilities);
  const uniquePermissions = unique(permissions);
  const missingCapabilities = uniqueCapabilities.filter((item) => !script.capabilities.includes(item));
  const missingPermissions = uniquePermissions.filter((item) => !script.permissions.includes(item));
  const issues: SceneScriptIssue[] = [];

  if (!lifecycle.length) issues.push({ code: "missing-lifecycle", severity: "error", message: "没有找到可运行的生命周期函数（例如 onStart 或 onUpdate）", line: 1, column: 1, endColumn: 1 });
  for (const capability of missingCapabilities) issues.push({ code: "missing-capability", severity: "warning", message: `代码使用了 ${capability}，但脚本尚未声明该能力`, line: 1, column: 1, endColumn: 1 });
  for (const permission of missingPermissions) issues.push({ code: "missing-permission", severity: "warning", message: `代码需要 ${permission} 权限，运行前请补齐`, line: 1, column: 1, endColumn: 1 });

  const objectIds = new Set(context.targets.filter((item) => item.kind === "object").map((item) => item.id));
  const componentIds = new Set(context.targets.filter((item) => item.kind === "component").map((item) => item.id));
  const sceneIds = new Set(context.references.filter((item) => item.kind === "scene").map((item) => item.id));
  const pageIds = new Set(context.references.filter((item) => item.kind === "page").map((item) => item.id));
  const cameraViewIds = new Set(context.references.filter((item) => item.kind === "cameraView").map((item) => item.id));
  if (script.target && script.target.kind !== "scene") {
    const attachedTargetExists = context.targets.some((item) => item.kind === script.target?.kind && item.id === script.target.id);
    if (!attachedTargetExists) {
      issues.push({
        code: "unknown-reference",
        severity: "error",
        message: `脚本挂载目标“${script.target.id}”不存在，请重新选择对象或资源`,
        line: 1,
        column: 1,
        endColumn: 1,
      });
    }
  }
  if (usesAttachedTarget && (!script.target || script.target.kind === "scene")) {
    issues.push({
      code: "unsupported-api",
      severity: "error",
      message: "ctx.self 仅在脚本挂载到三维对象或二维资源时可用",
      line: 1,
      column: 1,
      endColumn: 9,
    });
  }
  collectUnknownCalls(executableCode, /\b(?:studio|ctx)\.object\s*\(\s*(["'])([^"']+)\1/g, objectIds, "场景对象", issues);
  collectUnknownCalls(executableCode, /\bstudio\.component\s*\(\s*(["'])([^"']+)\1/g, componentIds, "页面组件", issues);
  collectUnknownCalls(executableCode, /\bstudio\.unity\s*\(\s*(["'])([^"']+)\1/g, new Set(context.targets.filter((item) => item.runtime === "unity").map((item) => item.id)), "Unity 组件", issues);
  collectUnknownCalls(executableCode, /\bstudio\.scene\.open\s*\(\s*(["'])([^"']+)\1/g, sceneIds, "场景", issues);
  collectUnknownCalls(executableCode, /\bstudio\.page\.open\s*\(\s*(["'])([^"']+)\1/g, pageIds, "页面", issues);
  collectUnknownCalls(executableCode, /\bstudio\.camera\.applyView\s*\(\s*(["'])([^"']+)\1/g, cameraViewIds, "相机视角", issues);
  collectUnknownCalls(executableCode, /\b(?:studio|ctx)\.getData\s*\(\s*(["'])([^"']+)\1/g, new Set(context.dataKeys), "数据键", issues);
  collectUnknownCalls(executableCode, /\b(?:studio|ctx)\.setData\s*\(\s*(["'])([^"']+)\1/g, new Set(context.dataKeys), "数据键", issues);
  collectUnknownCalls(executableCode, /\b(?:studio|ctx)\.emit\s*\(\s*(["'])([^"']+)\1/g, new Set(context.eventNames), "事件", issues);
  collectUnknownCalls(executableCode, /\bctx\.event\?*\.name\s*={2,3}\s*(["'])([^"']+)\1/g, new Set(context.eventNames), "事件", issues);
  collectUnsupportedWorkerApis(executableCode, issues);

  return { lifecycle, capabilities: uniqueCapabilities, permissions: uniquePermissions, missingCapabilities, missingPermissions, issues };
}

function collectUnsupportedWorkerApis(code: string, issues: SceneScriptIssue[]): void {
  for (const rule of WORKER_UNSUPPORTED_API) {
    for (const match of code.matchAll(rule.pattern)) {
      const expression = match[0];
      if (!expression) continue;
      const position = sourcePosition(code, match.index ?? 0);
      issues.push({
        code: "unsupported-api",
        severity: "error",
        message: `${expression}：${rule.label}`,
        line: position.line,
        column: position.column,
        endColumn: position.column + expression.length
      });
    }
  }
}

export function applySceneScriptDeclarations(script: ScriptModule, analysis: SceneScriptAnalysis): ScriptModule {
  return {
    ...script,
    lifecycle: unique([...script.lifecycle, ...analysis.lifecycle]),
    capabilities: unique([...script.capabilities, ...analysis.capabilities]),
    permissions: unique([...script.permissions, ...analysis.permissions])
  };
}

function collectUnknownCalls(code: string, pattern: RegExp, known: ReadonlySet<string>, label: string, issues: SceneScriptIssue[]): void {
  if (!known.size) return;
  for (const match of code.matchAll(pattern)) {
    const value = match[2];
    if (!value || known.has(value)) continue;
    const literalOffset = (match.index ?? 0) + (match[0]?.indexOf(value) ?? 0);
    const position = sourcePosition(code, literalOffset);
    issues.push({
      code: "unknown-reference",
      severity: "warning",
      message: `${label}“${value}”不在当前项目中，可能已重命名或删除`,
      line: position.line,
      column: position.column,
      endColumn: position.column + value.length
    });
  }
}

function sourcePosition(source: string, offset: number): { line: number; column: number } {
  const before = source.slice(0, Math.max(0, offset));
  const lines = before.split("\n");
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

function unique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/** 用空格遮蔽注释并保留换行与字符位置，确保诊断行列仍对应原始源码。 */
function maskJavaScriptComments(source: string): string {
  const output = [...source];
  let quote: "'" | '"' | "`" | undefined;
  let escaped = false;
  for (let index = 0; index < output.length; index += 1) {
    const current = output[index];
    const next = output[index + 1];
    if (quote) {
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === quote) quote = undefined;
      continue;
    }
    if (current === "'" || current === '"' || current === "`") {
      quote = current;
      continue;
    }
    if (current === "/" && next === "/") {
      while (index < output.length && output[index] !== "\n") output[index++] = " ";
      index -= 1;
      continue;
    }
    if (current === "/" && next === "*") {
      output[index] = " ";
      output[index + 1] = " ";
      index += 2;
      while (index < output.length) {
        if (output[index] === "*" && output[index + 1] === "/") {
          output[index] = " ";
          output[index + 1] = " ";
          index += 1;
          break;
        }
        if (output[index] !== "\n") output[index] = " ";
        index += 1;
      }
    }
  }
  return output.join("");
}
