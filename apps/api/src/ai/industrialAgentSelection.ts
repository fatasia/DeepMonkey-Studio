import { parseAgentDecision, type AgentCheckpoint } from "@bim-studio/industrial-agent-orchestrator";
import type { OntologyPackage } from "@bim-studio/contracts";
import type { industrialAgentDatasetCatalog } from "./industrialAgentDatasetCatalog.js";

type Catalog = ReturnType<typeof industrialAgentDatasetCatalog>;

/** T2（审计 §二 2.1 / P1-9）：澄清候选统一形状——数据集目录项或已发布本体对象。 */
export interface AgentClarificationCandidate {
  id: string;
  label: string;
  description?: string;
}

/**
 * T2：已发布本体包 → 澄清候选。只有 published 包中的 published 对象可被提名，
 * ID 带 ontology: 前缀 + 包 ID 防跨包重名；候选名单由服务端构建，模型只能回提名。
 */
export function ontologyClarificationCandidates(packages: readonly OntologyPackage[]): AgentClarificationCandidate[] {
  const candidates: AgentClarificationCandidate[] = [];
  for (const pkg of packages) {
    if (pkg.status !== "published") continue;
    for (const object of pkg.objects) {
      if (object.status !== "published") continue;
      // 包名+域兜底：没有对象描述时用户仍能看出候选来自哪个本体域。
      const description = [pkg.name, object.domain, object.description].filter(Boolean).join(" · ").slice(0, 400);
      candidates.push({
        id: `ontology:${pkg.id}:${object.key}`,
        label: object.label.slice(0, 200),
        ...(description ? { description } : {}),
      });
      // 与数据集目录同界（50 项）：上下文预算不因本体规模失控。
      if (candidates.length >= 50) return candidates;
    }
  }
  return candidates;
}

/** 模型只能提名服务端目录或本体候选 ID；显示名称和字段信息不采信模型生成值。 */
export function validateAgentDatasetSelection(value: unknown, catalog: Catalog, ontologyCandidates: readonly AgentClarificationCandidate[] = []) {
  const decision = parseAgentDecision(value);
  if (decision.kind !== "request-input") return decision;
  return { ...decision, options: decision.options.map(option => {
    // T2：本体对象候选合法化——此前任何非数据集 ID 都会杀死整轮运行。
    const candidate = ontologyCandidates.find(item => item.id === option.id);
    if (candidate) return { id: candidate.id, label: candidate.label, ...(candidate.description ? { description: candidate.description } : {}) };
    const dataset = catalog.datasets.find(item => item.id === option.id);
    if (!dataset) throw new Error("Agent 提名了当前项目目录以外的数据源");
    return { id: dataset.id, label: dataset.name.slice(0, 200), description: dataset.fields.slice(0, 5).map(field => field.label || field.key).join(" · ").slice(0, 400) };
  }) };
}

export function selectedAgentDatasets(checkpoint: AgentCheckpoint, catalog: Catalog, ontologyCandidates: readonly AgentClarificationCandidate[] = []) {
  const selected = checkpoint.selections?.at(-1);
  if (!selected) return [];
  // T2：本体对象选择返回对象范围声明；数据集选择保持原合同，不因扩展破坏既有上下文形状。
  const candidate = ontologyCandidates.find(item => item.id === selected.option.id);
  if (candidate) return [{ kind: "ontology" as const, id: candidate.id, name: candidate.label, selectedBy: selected.selectedBy, selectedAt: selected.selectedAt }];
  const dataset = catalog.datasets.find(item => item.id === selected.option.id);
  if (!dataset) throw new Error("已选择的数据源已删除或不在当前目录中，请刷新数据后开始新任务");
  return [{ kind: "dataset" as const, id: dataset.id, name: dataset.name, selectedBy: selected.selectedBy, selectedAt: selected.selectedAt }];
}
