import type { AgentAutonomySettings, AgentDiscoveryMode, AgentExecutionMode } from "@bim-studio/contracts";
import type { MetadataStore } from "../metadataStore.js";

/**
 * H-autonomy：授权范围/执行模式设置。模式同 `aiSettings`：saved 全量覆盖、未知值 fail-closed
 * 拒绝、密钥面不存在（本配置无秘密字段）。autoApproveToolIds / generalDevelopmentDeniedToolIds
 * 是授权面的一部分：去空白、去重、限量，防止膨胀条目静默扩大自主执行面。
 */

export const MAX_AGENT_AUTONOMY_TOOL_LIST = 200;

export class AgentAutonomySettingsError extends Error {
  public constructor(public readonly code: "invalid-mode" | "invalid-tool-list" | "invalid-flag" | "unknown-field") {
    super({
      "invalid-mode": "执行模式只支持 confirm（逐条确认）或 autonomous（授权内自主执行）",
      "invalid-tool-list": "工具清单必须是字符串数组（每项为已注册能力 ID）",
      "invalid-flag": "通用开发模式开关必须是布尔值",
      "unknown-field": "设置包含未声明字段（fail-closed）",
    }[code]);
    this.name = "AgentAutonomySettingsError";
  }
}

export function defaultAgentAutonomySettings(): AgentAutonomySettings {
  return { mode: "confirm", generalDevelopment: false };
}

export function resolveAgentAutonomySettings(store?: Pick<MetadataStore, "getAgentSettings">): AgentAutonomySettings {
  const saved = store?.getAgentSettings();
  if (!saved) return defaultAgentAutonomySettings();
  return {
    mode: saved.mode === "autonomous" ? "autonomous" : "confirm",
    ...(Array.isArray(saved.autoApproveToolIds) ? { autoApproveToolIds: sanitizeToolList(saved.autoApproveToolIds) } : {}),
    generalDevelopment: saved.generalDevelopment === true,
    ...(Array.isArray(saved.generalDevelopmentDeniedToolIds) ? { generalDevelopmentDeniedToolIds: sanitizeToolList(saved.generalDevelopmentDeniedToolIds) } : {}),
    ...(saved.updatedAt ? { updatedAt: saved.updatedAt } : {}),
    ...(saved.updatedBy ? { updatedBy: saved.updatedBy } : {}),
  };
}

/** 读回净化：手改持久档不放大授权面（去非字符串、去空白、去重、限量），不抛错不阻断启动。 */
function sanitizeToolList(value: readonly unknown[]): string[] {
  const strings = value.filter((item): item is string => typeof item === "string");
  const normalized = [...new Set(strings.map((item) => item.trim()).filter(Boolean))];
  return normalized.slice(0, MAX_AGENT_AUTONOMY_TOOL_LIST);
}

/**
 * 合并管理面草案；非法取值抛 AgentAutonomySettingsError（路由转 400，理由码透传）。
 * 未知字段一律拒绝，与 aiSettings 的 fail-closed 纪律一致。
 */
export function mergeAgentAutonomySettingsDraft(
  current: AgentAutonomySettings,
  draft: Partial<AgentAutonomySettings>,
  updatedBy?: string,
): AgentAutonomySettings {
  const known = new Set(["mode", "autoApproveToolIds", "generalDevelopment", "generalDevelopmentDeniedToolIds"]);
  const unknown = Object.keys(draft).filter((key) => !known.has(key));
  if (unknown.length) throw new AgentAutonomySettingsError("unknown-field");
  const mode: AgentExecutionMode = draft.mode === undefined ? current.mode
    : draft.mode === "confirm" || draft.mode === "autonomous" ? draft.mode
      : (() => { throw new AgentAutonomySettingsError("invalid-mode"); })();
  const generalDevelopment = draft.generalDevelopment === undefined ? (current.generalDevelopment === true)
    : typeof draft.generalDevelopment === "boolean" ? draft.generalDevelopment
      : (() => { throw new AgentAutonomySettingsError("invalid-flag"); })();
  return {
    mode,
    ...(draft.autoApproveToolIds !== undefined || current.autoApproveToolIds
      ? { autoApproveToolIds: normalizeToolList(draft.autoApproveToolIds ?? current.autoApproveToolIds ?? []) }
      : {}),
    generalDevelopment,
    ...(draft.generalDevelopmentDeniedToolIds !== undefined || current.generalDevelopmentDeniedToolIds
      ? { generalDevelopmentDeniedToolIds: normalizeToolList(draft.generalDevelopmentDeniedToolIds ?? current.generalDevelopmentDeniedToolIds ?? []) }
      : {}),
    updatedAt: new Date().toISOString(),
    ...(updatedBy?.trim() ? { updatedBy: updatedBy.trim().slice(0, 200) } : {}),
  };
}

function normalizeToolList(value: readonly string[]): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new AgentAutonomySettingsError("invalid-tool-list");
  }
  const normalized = [...new Set(value.map((item) => item.trim()).filter(Boolean))];
  if (normalized.length > MAX_AGENT_AUTONOMY_TOOL_LIST) throw new AgentAutonomySettingsError("invalid-tool-list");
  return normalized;
}

/** 运行启动的执行模式覆盖：请求显式给值时校验，缺省回落持久化默认。 */
export function resolveRunExecutionMode(
  requested: unknown,
  settings: AgentAutonomySettings,
): AgentExecutionMode {
  if (requested === undefined) return settings.mode === "autonomous" ? "autonomous" : "confirm";
  if (requested === "confirm" || requested === "autonomous") return requested;
  throw new AgentAutonomySettingsError("invalid-mode");
}

/** 通用开发发现面门控：开关关闭时 general 请求 fail-closed 拒绝（理由码透传给 UI）。 */
export function resolveDiscoveryMode(
  requested: unknown,
  settings: AgentAutonomySettings,
): AgentDiscoveryMode {
  if (requested === undefined || requested === "curated") return "curated";
  if (requested === "general") {
    if (settings.generalDevelopment !== true) throw new AgentAutonomySettingsError("invalid-flag");
    return "general";
  }
  throw new AgentAutonomySettingsError("invalid-flag");
}

/** general 发现面的授权收口：显式拒绝清单优先于注册表可见性（策划环工具也可被显式排除）。 */
export function applyGeneralDenyList(toolIds: readonly string[], settings: AgentAutonomySettings): string[] {
  const denied = new Set(settings.generalDevelopmentDeniedToolIds ?? []);
  return toolIds.filter((id) => !denied.has(id));
}
