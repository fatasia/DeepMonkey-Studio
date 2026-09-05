import { parseAgentDecision, type AgentCheckpoint } from "@bim-studio/industrial-agent-orchestrator";
import type { industrialAgentDatasetCatalog } from "./industrialAgentDatasetCatalog.js";

type Catalog = ReturnType<typeof industrialAgentDatasetCatalog>;

/** 模型只能提名服务端目录 ID；显示名称和字段信息不采信模型生成值。 */
export function validateAgentDatasetSelection(value: unknown, catalog: Catalog) {
  const decision = parseAgentDecision(value);
  if (decision.kind !== "request-input") return decision;
  return { ...decision, options: decision.options.map(option => {
    const dataset = catalog.datasets.find(item => item.id === option.id);
    if (!dataset) throw new Error("Agent 提名了当前项目目录以外的数据源");
    return { id: dataset.id, label: dataset.name.slice(0, 200), description: dataset.fields.slice(0, 5).map(field => field.label || field.key).join(" · ").slice(0, 400) };
  }) };
}

export function selectedAgentDatasets(checkpoint: AgentCheckpoint, catalog: Catalog) {
  const selected = checkpoint.selections?.at(-1);
  if (!selected) return [];
  const dataset = catalog.datasets.find(item => item.id === selected.option.id);
  if (!dataset) throw new Error("已选择的数据源已删除或不在当前目录中，请刷新数据后开始新任务");
  return [{ id: dataset.id, name: dataset.name, selectedBy: selected.selectedBy, selectedAt: selected.selectedAt }];
}
