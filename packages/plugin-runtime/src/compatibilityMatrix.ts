import {
  resolvePluginCompatibility, type PluginCompatibilityReason,
  type PluginCompatibilityReasonCode, type PluginHostPolicy,
} from "./compatibility.js";

/**
 * F6 收口：插件 × 宿主策略兼容矩阵。对给定 manifest 集合与宿主策略集合逐对调用既有
 * resolvePluginCompatibility（单一判定权威，不重复实现任何规则），输出排序确定、可序列化
 * 的矩阵与原因汇总——供 SDK 文档、门禁脚本与宿主诊断展示同一份事实。矩阵只读，不注册、
 * 不启用任何插件；启停生命周期仍由 PluginRegistry 独占。
 */

export interface PluginCompatibilityMatrixEntry {
  readonly pluginId: string;
  readonly pluginVersion: string;
  readonly host: string;
  readonly compatible: boolean;
  readonly reasons: readonly PluginCompatibilityReason[];
}

export interface PluginCompatibilityMatrixSummary {
  readonly manifests: number;
  readonly hosts: number;
  readonly pairs: number;
  readonly compatible: number;
  readonly incompatible: number;
  readonly byReasonCode: Readonly<Record<PluginCompatibilityReasonCode | "unknown", number>>;
}

export interface PluginCompatibilityMatrix {
  readonly entries: readonly PluginCompatibilityMatrixEntry[];
  readonly summary: PluginCompatibilityMatrixSummary;
}

const UNKNOWN_PLUGIN_ID = "(unparseable-manifest)";

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function buildPluginCompatibilityMatrix(manifests: readonly unknown[],
  hosts: readonly PluginHostPolicy[]): PluginCompatibilityMatrix {
  const entries: PluginCompatibilityMatrixEntry[] = [];
  for (const manifest of manifests) {
    for (const host of hosts) {
      const resolved = resolvePluginCompatibility(manifest, host);
      const manifestId = resolved.manifest?.id ?? UNKNOWN_PLUGIN_ID;
      entries.push({
        pluginId: manifestId,
        pluginVersion: resolved.manifest?.version ?? "",
        host: `${host.host}/${host.renderer}`,
        compatible: resolved.compatible,
        reasons: resolved.reasons,
      });
    }
  }
  // Deterministic order: plugin id, then host key; equal pairs keep first-seen host order.
  entries.sort((left, right) => compareStrings(left.pluginId, right.pluginId)
    || compareStrings(left.host, right.host));
  const byReasonCode: Record<PluginCompatibilityReasonCode | "unknown", number> =
    {} as Record<PluginCompatibilityReasonCode | "unknown", number>;
  let compatible = 0;
  for (const entry of entries) {
    if (entry.compatible) { compatible++; continue; }
    for (const reason of entry.reasons) {
      const code = (PLUGIN_REASON_CODES as readonly string[]).includes(reason.code)
        ? reason.code as PluginCompatibilityReasonCode : "unknown";
      byReasonCode[code] = (byReasonCode[code] ?? 0) + 1;
    }
  }
  return {
    entries,
    summary: {
      manifests: manifests.length,
      hosts: hosts.length,
      pairs: entries.length,
      compatible,
      incompatible: entries.length - compatible,
      byReasonCode,
    },
  };
}

const PLUGIN_REASON_CODES = [
  "invalid-manifest", "invalid-host-policy", "plugin-api-major-mismatch",
  "plugin-api-minor-unsupported", "host-unsupported", "extension-point-unsupported",
  "capability-unsupported", "permission-denied", "scene-extension-incompatible",
] as const;
