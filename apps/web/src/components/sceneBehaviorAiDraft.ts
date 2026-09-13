import type { ScriptModule } from "@bim-studio/contracts";
import type { AiSceneScriptDraftResult } from "../ai/sceneScriptDraft";

/**
 * AI 审查结果只能成为当前编辑器的本地草稿。
 * 这里再次核对脚本身份，防止用户切换脚本后把旧审查结果写入新脚本。
 */
export function acceptAiSceneScriptDraft(
  current: ScriptModule,
  result: AiSceneScriptDraftResult,
): ScriptModule {
  if (result.status !== "ready" || !result.draftScript) {
    throw new Error("动作草稿尚未通过静态检查");
  }
  if (result.draftScript.id !== current.id) {
    throw new Error("当前脚本已切换，请重新生成动作草稿");
  }
  if (!sameTarget(result.draftScript.target, current.target)) {
    throw new Error("脚本挂载目标已变化，请重新生成动作草稿");
  }

  // 返回副本而不是审查对象本身，避免后续编辑污染审查记录。
  return structuredClone(result.draftScript);
}

function sameTarget(left: ScriptModule["target"], right: ScriptModule["target"]): boolean {
  if (!left || left.kind === "scene") return !right || right.kind === "scene";
  if (!right || right.kind === "scene" || left.kind !== right.kind) return false;
  return left.id === right.id;
}
