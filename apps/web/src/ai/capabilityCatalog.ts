import type { CapabilityDescriptor } from "../api";

export interface CapabilityCatalogSummary {
  total: number;
  visible: CapabilityDescriptor[];
  hiddenCount: number;
  readOnlyCount: number;
  actionCount: number;
}

export type AiWorkspaceTask =
  | {
      workspace: "operations";
      tab: "maintenance" | "commissioning" | "battery" | "logistics" | "energy" | "whatif";
    }
  | { workspace: "ask-data" };

/**
 * 将运行时能力目录压缩成适合侧栏展示的摘要。
 * 按命名空间轮询取样，避免同一插件的一组能力占满侧栏，也不维护领域白名单。
 */
export function summarizeCapabilityCatalog(
  capabilities: CapabilityDescriptor[],
  visibleLimit = 8,
): CapabilityCatalogSummary {
  const unique = capabilities.filter(
    (capability, index, source) =>
      capability.id.trim().length > 0 &&
      capability.label.trim().length > 0 &&
      source.findIndex((item) => item.id === capability.id) === index,
  );
  const limit = Math.max(0, Math.floor(visibleLimit));
  return {
    total: unique.length,
    visible: takeAcrossNamespaces(unique, limit),
    hiddenCount: Math.max(0, unique.length - limit),
    readOnlyCount: unique.filter((capability) => capability.kind !== "action").length,
    actionCount: unique.filter((capability) => capability.kind === "action").length,
  };
}

/** action 表示可能改变业务状态，其余能力默认只读执行并返回证据。 */
export function capabilityWritePolicy(kind: string): "read-only" | "confirm-required" {
  return kind === "action" ? "confirm-required" : "read-only";
}

export interface CapabilityOntologyBinding {
  /** 绑定的本体对象 key；未声明 = 能力尚未接入本体目录。 */
  boundObject?: string;
  riskLevel: "low" | "medium" | "high" | "critical";
  approvalRequired: boolean;
}

/**
 * H-C4-P0 能力 ↔ 本体行动的桥：读声明字段，缺省按 kind 派生
 * （action 型能力缺省 medium 风险 + 需审批，与 capabilityWritePolicy 同一口径）。
 * 本体只负责业务语义与风险契约；技术调用入口仍是能力目录。
 */
export function capabilityOntologyBinding(
  capability: Pick<CapabilityDescriptor, "kind"> & Partial<Pick<CapabilityDescriptor, "boundObject" | "riskLevel" | "approvalRequired">>,
): CapabilityOntologyBinding {
  return {
    ...(capability.boundObject ? { boundObject: capability.boundObject } : {}),
    riskLevel: capability.riskLevel ?? (capability.kind === "action" ? "medium" : "low"),
    approvalRequired: capability.approvalRequired ?? capability.kind === "action",
  };
}

function takeAcrossNamespaces(capabilities: CapabilityDescriptor[], limit: number): CapabilityDescriptor[] {
  const groups = new Map<string, CapabilityDescriptor[]>();
  for (const capability of capabilities) {
    const namespace = capability.id.split(".")[0] ?? capability.id;
    groups.set(namespace, [...(groups.get(namespace) ?? []), capability]);
  }
  const visible: CapabilityDescriptor[] = [];
  for (let depth = 0; visible.length < limit; depth += 1) {
    let appended = false;
    for (const group of groups.values()) {
      const capability = group[depth];
      if (!capability) continue;
      visible.push(capability);
      appended = true;
      if (visible.length === limit) break;
    }
    if (!appended) break;
  }
  return visible;
}

/** 把领域能力映射到现有任务工作台；没有成熟工作流的能力只展示，不制造空入口。 */
export function capabilityWorkspaceTask(capabilityId: string): AiWorkspaceTask | undefined {
  if (capabilityId.startsWith("data.query.")) return { workspace: "ask-data" };
  if (capabilityId.startsWith("battery.")) return { workspace: "operations", tab: "battery" };
  if (capabilityId === "simulation.virtual-debug.run" || capabilityId.startsWith("manufacturing.workcell.")) {
    return { workspace: "operations", tab: "commissioning" };
  }
  if (capabilityId.startsWith("operations.maintenance.") || capabilityId.startsWith("industrial.ai.diagnosis.")) {
    return { workspace: "operations", tab: "maintenance" };
  }
  if (capabilityId.startsWith("operations.energy.")) return { workspace: "operations", tab: "energy" };
  if (capabilityId.startsWith("operations.logistics.")) return { workspace: "operations", tab: "logistics" };
  return undefined;
}
