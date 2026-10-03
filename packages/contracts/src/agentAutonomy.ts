/**
 * H-autonomy：工业 Agent 授权范围/执行模式合同。
 *
 * 执行模式（mode）：
 * - `confirm`：现行默认——高风险（write/control）工具逐条等人审批；
 * - `autonomous`：授权范围内自主执行——在 autoApproveToolIds 授权面内的高风险工具由运行时
 *   以策略身份签发审批直接执行（下游审批指纹与时效硬校验照常），范围外仍逐条审批。
 *
 * 通用开发模式（generalDevelopment）：工具发现面从工业策划清单（CURATED_TOOL_IDS）放宽为
 * 插件注册表全量已注册能力；仍受运行级 allowedToolIds 授权与 generalDevelopmentDeniedToolIds
 * 显式排除收口。注册表之外不存在任何工具来源（无动态命令/shell/文件工具）。
 */
export type AgentExecutionMode = "confirm" | "autonomous";

export type AgentDiscoveryMode = "curated" | "general";

export interface AgentAutonomySettings {
  /** 新运行的默认执行模式；运行启动仍可逐次覆盖（服务端校验）。 */
  mode: AgentExecutionMode;
  /** 自主模式免逐条审批的工具白名单；缺省/空 = 授权面内全部高风险工具。 */
  autoApproveToolIds?: string[];
  /** 通用开发模式开关：false 时 general 发现请求 fail-closed 拒绝。 */
  generalDevelopment?: boolean;
  /** 通用开发模式显式排除清单（fail-closed 兜底，优先级高于注册表可见性）。 */
  generalDevelopmentDeniedToolIds?: string[];
  updatedAt?: string;
  updatedBy?: string;
}

export const DEFAULT_AGENT_AUTONOMY_MODE: AgentExecutionMode = "confirm";

export function isAgentExecutionMode(value: unknown): value is AgentExecutionMode {
  return value === "confirm" || value === "autonomous";
}

export function isAgentDiscoveryMode(value: unknown): value is AgentDiscoveryMode {
  return value === "curated" || value === "general";
}
