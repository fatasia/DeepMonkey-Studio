import { validateSceneCommand, type SceneCommand } from "@bim-studio/scene-sdk";
import type { SceneCheck, SceneDiff, SceneStateSnapshot } from "./sceneEditState";
import type { ViewportMetrics } from "./sceneViewportObservation";

/** 提议/裁决的提示词与响应解析。模型输出一律不可信:逐条走 scene-sdk 校验器。 */
export const SCENE_EDIT_MAX_COMMANDS = 12;
const MAX_CONTEXT_OBJECTS = 80;

const CONTRACT = [
  "你是三维场景编辑 Agent。只输出一个 JSON 对象,不要输出其它文字或 Markdown 围栏:",
  '{"summary":"一句话说明本批改动","commands":[SceneCommand,...]}',
  `commands 至多 ${SCENE_EDIT_MAX_COMMANDS} 条,每条含 id(唯一字符串)与 type。可用 type:`,
  "object.create-primitive{target:{kind:'object',objectId},name,kind:box|sphere|cylinder|cone|torus|plane|capsule,color:'#rrggbb'};",
  "object.delete-primitive{target};object.set-visibility{target,visible};",
  "object.set-transform{target,position?:[x,y,z],rotation?:[x,y,z](弧度),scale?:[x,y,z]};",
  "material.set{target,patch:{color?,emissive?,emissiveIntensity?,roughness?,metalness?}};",
  "camera.set{position,target};lighting.set{patch:{enabled?,intensity?,shadowsEnabled?}};",
  "environment.set{patch:{backgroundColor?,weather?:sunny|cloudy|rain|snow|fog|storm,environmentIntensity?}};selection.set{targets:[]}。",
  "target 形如 {kind:'object',sceneId,objectId};sceneId 使用上下文中的 sceneId。只能引用上下文 objects 中存在的对象或本批新建的对象;坐标单位为场景单位。",
  "无法用上述命令完成时返回 commands:[] 并在 summary 说明原因。需要让改动出现在验证截图里时,可附带 camera.set 把相机对准改动区域。",
].join("\n");

const round = (value: number) => Math.round(value * 1000) / 1000;
const compactState = (state: SceneStateSnapshot) => ({
  sceneId: state.sceneId,
  objects: state.objects.slice(0, MAX_CONTEXT_OBJECTS).map(object => ({
    id: object.id, name: object.name, kind: object.kind, visible: object.visible,
    position: object.position.map(round), rotation: object.rotation.map(round), scale: object.scale.map(round),
    ...(object.color ? { color: object.color } : {}), ...(object.locked ? { locked: true } : {}),
  })),
  ...(state.objects.length > MAX_CONTEXT_OBJECTS ? { objectsTruncated: state.objects.length } : {}),
  camera: state.camera, lighting: state.lighting, environment: state.environment,
  ...(state.selection ? { selection: state.selection } : {}),
});

export function buildProposalPrompt(input: { objective: string; state: SceneStateSnapshot; correction?: { summary: string; reason: string; failedChecks: string[] } }) {
  const question = input.correction
    ? `${CONTRACT}\n\n上一批改动已应用但未达成目标。目标:${input.objective}\n上一批:${input.correction.summary}\n未达成原因:${input.correction.reason}\n${input.correction.failedChecks.length ? `核对失败:${input.correction.failedChecks.join(";")}\n` : ""}请基于当前场景状态给出修正批(只含还需要的改动)。`
    : `${CONTRACT}\n\n目标:${input.objective}`;
  return { question, context: { sceneEdit: compactState(input.state) } };
}

export interface VerdictInput {
  objective: string; summary: string; diff: SceneDiff; checks: SceneCheck[];
  state: SceneStateSnapshot; touchedIds: string[]; viewport?: ViewportMetrics;
  /** 剩余可用修正轮次;为 0 时不得要求 correction。 */
  correctionsLeft: number;
}

export function buildVerdictPrompt(input: VerdictInput) {
  const state = compactState(input.state);
  const touched = new Set(input.touchedIds);
  const question = [
    "你是三维场景改动的验收员。依据确定性核对结果、应用后的对象状态与视口数值观测判断目标是否达成。",
    '只输出一个 JSON 对象:{"achieved":true|false,"reason":"一句话原因","correction":{"summary":"...","commands":[...]}}。',
    input.correctionsLeft > 0 ? `未达成时可附 correction(格式同提议,至多 ${SCENE_EDIT_MAX_COMMANDS} 条命令,只含还需要的改动);已达成或无法修正时省略。` : "不允许提出修正,correction 必须省略。",
    "核对失败(checks 中 ok=false)说明命令没有按预期生效,此时 achieved 必须为 false。视口观测只有数值(无图像),不得编造画面细节。",
    `目标:${input.objective}\n本批改动:${input.summary}`,
  ].join("\n");
  return {
    question,
    context: {
      sceneVerify: {
        sceneId: input.state.sceneId, checks: input.checks.map(check => ({ item: check.label, expected: check.expected, actual: check.actual, ok: check.ok })),
        diff: input.diff.entries.map(entry => ({ type: entry.type, subject: entry.subject, changes: entry.fields.map(field => `${field.label}:${field.before ?? "—"}→${field.after}`) })),
        objectsAfter: state.objects.filter(object => touched.has(object.id)), totalObjects: input.state.objects.length,
        ...(input.viewport ? { viewport: input.viewport } : { viewport: "unavailable" }),
      },
    },
  };
}

function extractJson(text: string): unknown {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(stripped); } catch { /* 回退到平衡花括号截取 */ }
  const start = stripped.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0, inString = false, escaped = false;
  for (let index = start; index < stripped.length; index += 1) {
    const char = stripped[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) { try { return JSON.parse(stripped.slice(start, index + 1)); } catch { return undefined; } }
  }
  return undefined;
}

export type ParsedProposal = { ok: true; summary: string; commands: SceneCommand[] } | { ok: false; error: string };

function pinScene(value: unknown, sceneId: string): void {
  if (value && typeof value === "object" && "sceneId" in value) (value as { sceneId: unknown }).sceneId = sceneId;
}

/** 活动场景是唯一写入面:模型给出的 sceneId 一律钉到活动场景,其余字段仍由 SDK 校验器把关。 */
export function normalizeProposal(raw: unknown, sceneId: string, idPrefix: string): ParsedProposal {
  if (!raw || typeof raw !== "object") return { ok: false, error: "模型输出不是 JSON 对象" };
  const record = raw as { summary?: unknown; commands?: unknown };
  const summary = typeof record.summary === "string" && record.summary.trim() ? record.summary.trim() : "场景改动";
  if (!Array.isArray(record.commands)) return { ok: false, error: "缺少 commands 数组" };
  if (record.commands.length > SCENE_EDIT_MAX_COMMANDS) return { ok: false, error: `命令数 ${record.commands.length} 超过上限 ${SCENE_EDIT_MAX_COMMANDS}` };
  const commands: SceneCommand[] = [];
  const problems: string[] = [];
  record.commands.forEach((item, index) => {
    const draft = item && typeof item === "object" ? structuredClone(item) as Record<string, unknown> : item;
    if (draft && typeof draft === "object") {
      const command = draft as Record<string, unknown>;
      command.id = typeof command.id === "string" && command.id ? `${idPrefix}${command.id}` : `${idPrefix}c${index + 1}`;
      pinScene(command, sceneId); pinScene(command.target, sceneId);
      if (Array.isArray(command.targets)) command.targets.forEach(target => pinScene(target, sceneId));
    }
    const result = validateSceneCommand(draft);
    if (result.valid) commands.push(result.command);
    else problems.push(`#${index + 1} ${result.issues.map(issue => `${issue.path} ${issue.message}`).join(";")}`);
  });
  return problems.length ? { ok: false, error: `命令未通过校验:${problems.join(" | ")}` } : { ok: true, summary, commands };
}

export function parseProposal(text: string, sceneId: string, idPrefix: string): ParsedProposal {
  const raw = extractJson(text);
  return raw === undefined ? { ok: false, error: "模型输出不是合法 JSON" } : normalizeProposal(raw, sceneId, idPrefix);
}

export interface ParsedVerdict { achieved: boolean; reason: string; correction?: ParsedProposal }

export function parseVerdict(text: string, sceneId: string, idPrefix: string): ParsedVerdict | undefined {
  const raw = extractJson(text) as { achieved?: unknown; reason?: unknown; correction?: unknown } | undefined;
  if (!raw || typeof raw !== "object" || typeof raw.achieved !== "boolean") return undefined;
  const reason = typeof raw.reason === "string" ? raw.reason.trim() : "";
  const hasCorrection = raw.correction && typeof raw.correction === "object";
  return { achieved: raw.achieved, reason: reason || (raw.achieved ? "模型判定已达成" : "模型判定未达成"),
    ...(hasCorrection && !raw.achieved ? { correction: normalizeProposal(raw.correction, sceneId, idPrefix) } : {}) };
}
