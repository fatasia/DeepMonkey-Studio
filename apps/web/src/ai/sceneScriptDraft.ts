import type { ApplicationScriptLifecycle, ApplicationScriptPermission, ScriptModule } from "@bim-studio/contracts";
import {
  validateSceneCommand,
  type SceneBehaviorModule,
  type SceneCapability,
  type SceneCommand,
} from "@bim-studio/scene-sdk";
import { authorizeSceneCommands } from "../behavior/sceneCommandPolicy";
import { analyzeSceneScript, applySceneScriptDeclarations, type SceneScriptAnalysis } from "../studio/sceneScriptAnalysis";
import type { SceneScriptIntelligenceContext, SceneScriptTarget } from "../studio/sceneScriptContext";
import { createEvidenceFingerprint, EVIDENCE_FINGERPRINT_ALGORITHM } from "@bim-studio/studio-core";
import {
  buildSceneScriptDiff,
  mergeSceneScriptLifecycle,
  sceneScriptLifecycleFragment,
  type SceneScriptDraftDiff,
} from "./sceneScriptDraftMerge";

export type AiSceneScriptDraftStatus = "ready" | "needs-input" | "blocked";
export type AiSceneScriptRisk = "low" | "medium" | "high";

export interface AiSceneScriptDraftInput {
  intent: string;
  sceneId: string;
  target: SceneScriptTarget;
  intelligence: SceneScriptIntelligenceContext;
  existingScript?: ScriptModule;
}

export interface AiSceneScriptDraftIssue {
  code: "ambiguous-intent" | "missing-input" | "unknown-target" | "unsafe-existing-script" | "static-check" | "command-policy";
  severity: "error" | "warning";
  message: string;
}

export interface AiSceneScriptDraftResult {
  status: AiSceneScriptDraftStatus;
  risk: AiSceneScriptRisk;
  requiresConfirmation: true;
  target: SceneScriptTarget;
  lifecycle: ApplicationScriptLifecycle;
  actionLabels: string[];
  codeFragment: string;
  draftScript?: ScriptModule;
  analysis?: SceneScriptAnalysis;
  commandTypes: SceneCommand["type"][];
  diff: SceneScriptDraftDiff;
  issues: AiSceneScriptDraftIssue[];
  evidenceFingerprint: string;
  fingerprintAlgorithm: typeof EVIDENCE_FINGERPRINT_ALGORITHM;
}

interface CompiledAction {
  label: string;
  statement: string;
  command: SceneCommand;
  capabilities: SceneCapability[];
  permissions: ApplicationScriptPermission[];
  risk: AiSceneScriptRisk;
  offset: number;
}

interface TriggerPlan {
  lifecycle: ApplicationScriptLifecycle;
  prelude: string[];
  capabilities: SceneCapability[];
  permissions: ApplicationScriptPermission[];
  issues: AiSceneScriptDraftIssue[];
}

const EMPTY_DIFF = { summary: "没有生成可应用差异", addedLines: 0, removedLines: 0, preview: [], declarationsAdded: [] };

/**
 * 把自然语言意图编译为有限动作模板。这里不执行脚本，也不接受任意 API 名称；
 * 草稿必须同时通过脚本分析、SceneCommand 结构校验和命令授权策略。
 */
export function createAiSceneScriptDraft(input: AiSceneScriptDraftInput): AiSceneScriptDraftResult {
  const result = createDraft(input);
  return {
    ...result,
    evidenceFingerprint: createEvidenceFingerprint({ input, result }),
    fingerprintAlgorithm: EVIDENCE_FINGERPRINT_ALGORITHM,
  };
}

function createDraft(input: AiSceneScriptDraftInput): Omit<AiSceneScriptDraftResult, "evidenceFingerprint" | "fingerprintAlgorithm"> {
  const intent = input.intent.trim();
  const base = input.existingScript ?? newDraftScript(input.target);
  const initial: Omit<AiSceneScriptDraftResult, "evidenceFingerprint" | "fingerprintAlgorithm"> = {
    status: "needs-input",
    risk: "low",
    requiresConfirmation: true,
    target: input.target,
    lifecycle: "onStart",
    actionLabels: [],
    codeFragment: "",
    commandTypes: [],
    diff: EMPTY_DIFF,
    issues: [],
  };
  if (!intent) return { ...initial, issues: [issue("missing-input", "请描述希望对象发生什么变化")] };
  const identityIssue = validateIdentity(input, base);
  if (identityIssue) return { ...initial, status: "blocked", issues: [identityIssue] };

  const compiled = compileActions(input);
  const trigger = compileTrigger(input);
  const issues = [...compiled.issues, ...trigger.issues];
  if (compiled.actions.length === 0 || issues.some((item) => item.severity === "error")) {
    return { ...initial, lifecycle: trigger.lifecycle, status: "needs-input", issues };
  }
  if (/\b(?:ctx|studio)\.command\s*\(/.test(base.code)) {
    return {
      ...initial,
      lifecycle: trigger.lifecycle,
      status: "blocked",
      issues: [issue("unsafe-existing-script", "现有脚本包含原始 command 调用，动作草稿无法静态证明其参数安全；请先人工审查")],
    };
  }

  const body = [...trigger.prelude, targetDeclaration(input.target), ...compiled.actions.map((action) => action.statement)];
  const codeFragment = sceneScriptLifecycleFragment(trigger.lifecycle, body);
  const merged = mergeSceneScriptLifecycle(base.code, trigger.lifecycle, body);
  if (!merged.code) {
    return {
      ...initial,
      lifecycle: trigger.lifecycle,
      status: "blocked",
      codeFragment,
      issues: [issue("unsafe-existing-script", merged.error ?? "无法安全合并现有生命周期")],
    };
  }

  const requiredCapabilities = unique([...trigger.capabilities, ...compiled.actions.flatMap((action) => action.capabilities)]);
  const requiredPermissions = unique([...trigger.permissions, ...compiled.actions.flatMap((action) => action.permissions), "scene.write"]);
  let draft: ScriptModule = {
    ...base,
    code: merged.code,
    runtime: "worker-sandbox",
    lifecycle: unique([...base.lifecycle, trigger.lifecycle]),
    capabilities: unique([...base.capabilities, ...requiredCapabilities]),
    permissions: unique([...base.permissions, ...requiredPermissions]),
  };
  const inferredAnalysis = analyzeSceneScript(draft.code, draft, input.intelligence);
  draft = applySceneScriptDeclarations(draft, inferredAnalysis);
  const analysis = analyzeSceneScript(draft.code, draft, input.intelligence);
  const policyIssues = validateCommands(draft, compiled.actions.map((action) => action.command));
  const staticIssues = analysis.issues
    .filter((item) => item.severity === "error")
    .map((item) => issue("static-check", `${item.message}（${item.line}:${item.column}）`));
  const allIssues = [...issues, ...staticIssues, ...policyIssues];
  const declarationsAdded = [
    ...requiredCapabilities.filter((item) => !base.capabilities.includes(item)),
    ...requiredPermissions.filter((item) => !base.permissions.includes(item)),
    ...(!base.lifecycle.includes(trigger.lifecycle) ? [trigger.lifecycle] : []),
  ];
  return {
    status: allIssues.some((item) => item.severity === "error") ? "blocked" : "ready",
    risk: maxRisk(compiled.actions.map((action) => action.risk)),
    requiresConfirmation: true,
    target: input.target,
    lifecycle: trigger.lifecycle,
    actionLabels: compiled.actions.map((action) => action.label),
    codeFragment,
    draftScript: draft,
    analysis,
    commandTypes: compiled.actions.map((action) => action.command.type),
    diff: buildSceneScriptDiff(base.code, draft.code, declarationsAdded),
    issues: allIssues,
  };
}

function compileActions(input: AiSceneScriptDraftInput): { actions: CompiledAction[]; issues: AiSceneScriptDraftIssue[] } {
  const intent = input.intent;
  const objectRef = { kind: "object" as const, sceneId: input.sceneId, objectId: input.target.id };
  const actions: CompiledAction[] = [];
  const add = (pattern: RegExp, create: (offset: number) => CompiledAction | undefined) => {
    const match = pattern.exec(intent);
    if (match?.index !== undefined) {
      const action = create(match.index);
      if (action) actions.push(action);
    }
  };

  if (input.target.kind === "object") {
    add(/隐藏|hide|不可见/i, (offset) => objectAction("隐藏对象", "target?.hide();", "object.set-visibility", { target: objectRef, visible: false }, ["studio.object"], "low", offset));
    add(/显示|show|可见/i, (offset) => objectAction("显示对象", "target?.show();", "object.set-visibility", { target: objectRef, visible: true }, ["studio.object"], "low", offset));
    add(/定位|聚焦|focus|飞到/i, (offset) => objectAction("定位对象", "target?.focus();", "camera.fly-to", { sceneId: input.sceneId, target: objectRef, durationMs: 650 }, ["studio.object", "studio.camera"], "low", offset));
    add(/选中|select/i, (offset) => objectAction("选中对象", "target?.select();", "selection.set", { targets: [objectRef] }, ["studio.object", "studio.scene"], "low", offset));
    add(/播放(?:\S{0,6})动画|启动(?:\S{0,6})动画|play(?:\s+\w+)?\s+animation/i, (offset) => objectAction("播放动画", "target?.playAnimation();", "animation.control", { target: objectRef, action: "play" }, ["studio.object", "studio.animation"], "medium", offset));
    add(/暂停(?:\S{0,6})动画|pause(?:\s+\w+)?\s+animation/i, (offset) => objectAction("暂停动画", "target?.pauseAnimation();", "animation.control", { target: objectRef, action: "pause" }, ["studio.object", "studio.animation"], "medium", offset));
    add(/停止(?:\S{0,6})动画|stop(?:\s+\w+)?\s+animation/i, (offset) => objectAction("停止动画", "target?.stopAnimation();", "animation.control", { target: objectRef, action: "stop" }, ["studio.object", "studio.animation"], "medium", offset));
    add(/移动到|move\s+to|position(?:\s+to)?/i, (offset) => transformAction(intent, objectRef, offset));
    add(/颜色|color/i, (offset) => colorAction(intent, objectRef, offset));
    add(/透明度|opacity/i, (offset) => opacityAction(intent, objectRef, offset));
  } else if (input.target.runtime === "unity") {
    add(/灯光强度|light\s+intensity/i, (offset) => unityLightAction(intent, input.target.id, offset));
  } else {
    add(/隐藏|hide|不可见/i, (offset) => componentAction("隐藏二维组件", "target?.hide();", input.target.id, false, offset));
    add(/显示|show|可见/i, (offset) => componentAction("显示二维组件", "target?.show();", input.target.id, true, offset));
  }

  actions.sort((left, right) => left.offset - right.offset);
  const visibility = actions.filter((action) => action.command.type === "object.set-visibility" || action.command.type === "component.update");
  const conflictingVisibility = visibility.length > 1 && new Set(visibility.map((action) => action.label.startsWith("显示"))).size > 1;
  const issues: AiSceneScriptDraftIssue[] = [];
  if (conflictingVisibility) issues.push(issue("ambiguous-intent", "同时识别到显示和隐藏，请只保留一个目标状态"));
  if (actions.length === 0) issues.push(issue("missing-input", supportedIntentMessage(input.target)));
  if (/移动到|move\s+to|position/i.test(intent) && !actions.some((action) => action.command.type === "object.set-transform")) {
    issues.push(issue("missing-input", "移动动作需要明确三个有限坐标，例如：移动到 12, 0, 6"));
  }
  if (/颜色|color/i.test(intent) && !actions.some((action) => action.label === "设置颜色")) {
    issues.push(issue("missing-input", "颜色动作需要六位十六进制色值，例如 #22c55e"));
  }
  return { actions, issues };
}

function compileTrigger(input: AiSceneScriptDraftInput): TriggerPlan {
  const matchedEvent = input.intelligence.eventNames.find((name) => input.intent.toLocaleLowerCase().includes(name.toLocaleLowerCase()));
  const clickIntent = /点击|click/i.test(input.intent);
  const dataKey = input.intelligence.dataKeys.find((key) => input.intent.includes(key));
  const condition = input.intent.match(/(>=|<=|>|<|==|等于|大于|小于)\s*(-?\d+(?:\.\d+)?)/);
  if ((dataKey || /当.*(?:数据|温度|压力|SOC|SOH)/i.test(input.intent)) && !condition) {
    return { lifecycle: "onData", prelude: [], capabilities: [], permissions: [], issues: [issue("missing-input", "数据触发需要真实数据键、比较符和阈值，例如：当 pump.temperature > 80 时变为 #ef4444")] };
  }
  if (dataKey && condition) {
    const operator = normalizeOperator(condition[1]!);
    return {
      lifecycle: "onData",
      prelude: [`const value = ctx.getData(${JSON.stringify(dataKey)});`, `if (typeof value !== "number" || !(value ${operator} ${condition[2]})) return;`],
      capabilities: ["studio.data"],
      permissions: ["data.read"],
      issues: [],
    };
  }
  const eventName = matchedEvent ?? (clickIntent ? "click" : undefined);
  return eventName
    ? { lifecycle: "onEvent", prelude: [`if (ctx.event?.name !== ${JSON.stringify(eventName)}) return;`], capabilities: [], permissions: [], issues: [] }
    : { lifecycle: "onStart", prelude: [], capabilities: [], permissions: [], issues: [] };
}

function objectAction(
  label: string,
  statement: string,
  type: SceneCommand["type"],
  fields: Record<string, unknown>,
  capabilities: SceneCapability[],
  risk: AiSceneScriptRisk,
  offset: number,
): CompiledAction {
  return { label, statement, command: { id: `ai-${offset}`, type, ...fields } as SceneCommand, capabilities, permissions: ["scene.write"], risk, offset };
}

function transformAction(intent: string, target: Extract<SceneCommand, { type: "object.set-transform" }>["target"], offset: number): CompiledAction | undefined {
  const values = intent.match(/(?:移动到|move\s+to|position(?:\s+to)?)[^\d+\-]*([+\-]?\d+(?:\.\d+)?)\s*[,，\s]\s*([+\-]?\d+(?:\.\d+)?)\s*[,，\s]\s*([+\-]?\d+(?:\.\d+)?)/i);
  const position = values?.slice(1, 4).map(Number) as [number, number, number] | undefined;
  if (!position || position.some((value) => !Number.isFinite(value))) return undefined;
  return objectAction("移动对象", `target?.setPosition(${position.join(", ")});`, "object.set-transform", { target, position }, ["studio.object"], "high", offset);
}

function colorAction(intent: string, target: Extract<SceneCommand, { type: "data.apply" }>["target"], offset: number): CompiledAction | undefined {
  const color = intent.match(/#[0-9a-f]{6}\b/i)?.[0];
  if (!color) return undefined;
  return objectAction("设置颜色", `target?.setColor(${JSON.stringify(color)});`, "data.apply", { target, values: { color }, timestamp: "2000-01-01T00:00:00.000Z" }, ["studio.object", "studio.data"], "medium", offset);
}

function opacityAction(intent: string, target: Extract<SceneCommand, { type: "data.apply" }>["target"], offset: number): CompiledAction | undefined {
  const match = intent.match(/(?:透明度|opacity)\s*(?:设为|为|to|=|:)?\s*(\d+(?:\.\d+)?)\s*(%)?/i);
  if (!match) return undefined;
  const value = Number(match[1]) / (match[2] ? 100 : 1);
  if (!Number.isFinite(value) || value < 0 || value > 1) return undefined;
  return objectAction("设置透明度", `target?.setOpacity(${value});`, "data.apply", { target, values: { opacity: value }, timestamp: "2000-01-01T00:00:00.000Z" }, ["studio.object", "studio.data"], "medium", offset);
}

function componentAction(label: string, statement: string, componentId: string, visible: boolean, offset: number): CompiledAction {
  return objectAction(label, statement, "component.update", { componentId, patch: { visible } }, ["studio.component"], "low", offset);
}

function unityLightAction(intent: string, componentId: string, offset: number): CompiledAction | undefined {
  const match = intent.match(/(?:灯光强度|light\s+intensity)\s*(?:设为|为|to|=|:)?\s*(\d+(?:\.\d+)?)/i);
  const value = Number(match?.[1]);
  if (!Number.isFinite(value) || value < 0 || value > 100) return undefined;
  return objectAction("设置 Unity 灯光强度", `target.setProperty("lightIntensity", ${value});`, "unity.properties.set", { componentId, values: { lightIntensity: value } }, ["studio.unity"], "medium", offset);
}

function validateIdentity(input: AiSceneScriptDraftInput, base: ScriptModule): AiSceneScriptDraftIssue | undefined {
  const knownTarget = input.intelligence.targets.some((target) => target.kind === input.target.kind && target.id === input.target.id && target.runtime === input.target.runtime);
  if (!knownTarget) return issue("unknown-target", `对象“${input.target.id}”不在当前脚本上下文中`);
  const knownScene = input.intelligence.references.some((reference) => reference.kind === "scene" && reference.id === input.sceneId);
  if (input.intelligence.references.some((reference) => reference.kind === "scene") && !knownScene) return issue("unknown-target", `场景“${input.sceneId}”不在当前项目中`);
  if (base.runtime !== "worker-sandbox") return issue("unsafe-existing-script", "不能把动作草稿合并到 legacy trusted 主线程脚本");
  if (base.target && base.target.kind !== "scene" && (base.target.kind !== input.target.kind || base.target.id !== input.target.id)) {
    return issue("unknown-target", "现有脚本挂载目标与当前对象不同，请新建脚本或切换正确对象");
  }
  return undefined;
}

function validateCommands(script: ScriptModule, commands: SceneCommand[]): AiSceneScriptDraftIssue[] {
  const behavior: SceneBehaviorModule = {
    id: script.id,
    name: script.name,
    apiVersion: "1.0",
    code: script.code,
    lifecycle: script.lifecycle,
    capabilities: script.capabilities as SceneCapability[],
    permissions: script.permissions,
    ...(script.target ? { target: script.target } : {}),
  };
  const issues: AiSceneScriptDraftIssue[] = [];
  const validCommands: SceneCommand[] = [];
  for (const command of commands) {
    const validation = validateSceneCommand(command);
    if (validation.valid) validCommands.push(validation.command);
    else issues.push(issue("command-policy", `${command.type} 未通过 SceneCommand 结构校验`));
  }
  const authorization = authorizeSceneCommands(behavior, validCommands);
  for (const rejected of authorization.rejected) issues.push(issue("command-policy", `${rejected.command.type}：${rejected.message}`));
  return issues;
}

function targetDeclaration(target: SceneScriptTarget): string {
  if (target.runtime === "unity") return `const target = studio.unity(${JSON.stringify(target.id)});`;
  if (target.kind === "component") return `const target = studio.component(${JSON.stringify(target.id)});`;
  return `const target = ctx.object(${JSON.stringify(target.id)});`;
}

function newDraftScript(target: SceneScriptTarget): ScriptModule {
  return {
    id: `ai-draft:${target.kind}:${target.id}`,
    name: `动作草稿 · ${target.name}`,
    enabled: false,
    apiVersion: "1.0",
    entrypoint: "behavior",
    runtime: "worker-sandbox",
    code: "",
    lifecycle: [],
    capabilities: [],
    permissions: ["scene.read"],
    target: { kind: target.kind, id: target.id },
  };
}

function supportedIntentMessage(target: SceneScriptTarget): string {
  if (target.runtime === "unity") return "当前 Unity 草稿支持设置灯光强度，请给出 0–100 的数值";
  if (target.kind === "component") return "当前二维组件草稿支持显示或隐藏";
  return "当前对象草稿支持显示、隐藏、定位、选中、动画、移动、颜色和透明度";
}

function normalizeOperator(operator: string): string {
  if (operator === "等于") return "===";
  if (operator === "大于") return ">";
  if (operator === "小于") return "<";
  return operator === "==" ? "===" : operator;
}

function maxRisk(values: AiSceneScriptRisk[]): AiSceneScriptRisk {
  return values.includes("high") ? "high" : values.includes("medium") ? "medium" : "low";
}

function issue(code: AiSceneScriptDraftIssue["code"], message: string): AiSceneScriptDraftIssue {
  return { code, severity: "error", message };
}

function unique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
