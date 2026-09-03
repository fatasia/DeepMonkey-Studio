import type {
  DataDatasetField,
  DataFieldType,
  DataPipelineDefinition,
  DataPipelineNode,
  DataPipelineNodeDiagnostic,
  DataPipelinePreview
} from "@bim-studio/contracts";
import { compileFormula, evaluateFormula } from "./index.js";
import { executeRowScript } from "./script.js";

export type DatasetResolver = (datasetId: string) => Promise<Array<Record<string, unknown>>>;

export class DataPipelineError extends Error {
  constructor(message: string, readonly nodeId?: string, readonly diagnostics: DataPipelineNodeDiagnostic[] = []) {
    super(message);
    this.name = "DataPipelineError";
  }
}

export function validateDataPipeline(definition: Pick<DataPipelineDefinition, "nodes" | "edges">): DataPipelineNode[] {
  if (definition.nodes.length < 2) throw new DataPipelineError("流水线至少需要数据源和输出节点");
  if (!definition.nodes.some((node) => node.type === "source")) throw new DataPipelineError("流水线至少需要一个数据源节点");
  if (definition.nodes.filter((node) => node.type === "output").length !== 1) throw new DataPipelineError("流水线必须且只能有一个输出节点");
  const nodes = new Map<string, DataPipelineNode>();
  for (const node of definition.nodes) {
    if (typeof node.id !== "string" || !node.id.trim() || nodes.has(node.id)) throw new DataPipelineError("节点 ID 不能为空或重复", node.id);
    validateNodeConfiguration(node);
    nodes.set(node.id, node);
  }
  const edgeIds = new Set<string>();
  const edgePairs = new Set<string>();
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const node of definition.nodes) {
    incoming.set(node.id, []);
    outgoing.set(node.id, []);
  }
  for (const edge of definition.edges) {
    if (typeof edge.id !== "string" || !edge.id.trim() || edgeIds.has(edge.id)) throw new DataPipelineError("连线 ID 不能为空或重复");
    edgeIds.add(edge.id);
    const pair = `${edge.sourceNodeId}\u0000${edge.targetNodeId}`;
    if (edgePairs.has(pair)) throw new DataPipelineError("相同节点之间不能重复连线");
    edgePairs.add(pair);
    if (!nodes.has(edge.sourceNodeId) || !nodes.has(edge.targetNodeId)) throw new DataPipelineError("连线引用了不存在的节点");
    if (edge.sourceNodeId === edge.targetNodeId) throw new DataPipelineError("节点不能连接自身", edge.sourceNodeId);
    incoming.get(edge.targetNodeId)?.push(edge.sourceNodeId);
    outgoing.get(edge.sourceNodeId)?.push(edge.targetNodeId);
  }
  for (const node of definition.nodes) {
    const inputCount = incoming.get(node.id)?.length ?? 0;
    const outputCount = outgoing.get(node.id)?.length ?? 0;
    if (node.type === "source" && inputCount !== 0) throw new DataPipelineError("数据源节点不能有输入", node.id);
    if (node.type === "merge" && inputCount < 2) throw new DataPipelineError("合并节点至少需要两个输入", node.id);
    if (node.type !== "source" && node.type !== "merge" && inputCount !== 1) throw new DataPipelineError("处理节点必须且只能有一个输入", node.id);
    if (node.type === "output" && outputCount !== 0) throw new DataPipelineError("输出节点不能继续连接其他节点", node.id);
    if (node.type !== "output" && outputCount === 0) throw new DataPipelineError("非输出节点必须连接后续节点", node.id);
  }

  const remainingInputs = new Map([...incoming].map(([nodeId, sources]) => [nodeId, sources.length]));
  const ready = definition.nodes.filter((node) => remainingInputs.get(node.id) === 0);
  const ordered: DataPipelineNode[] = [];
  while (ready.length > 0) {
    const node = ready.shift();
    if (!node) break;
    ordered.push(node);
    for (const targetId of outgoing.get(node.id) ?? []) {
      const count = (remainingInputs.get(targetId) ?? 0) - 1;
      remainingInputs.set(targetId, count);
      if (count === 0) ready.push(nodes.get(targetId) as DataPipelineNode);
    }
  }
  if (ordered.length !== definition.nodes.length) throw new DataPipelineError("流水线存在循环，请使用显式状态机或窗口节点");
  return ordered;
}

export async function executeDataPipeline(
  definition: DataPipelineDefinition,
  resolveDataset: DatasetResolver,
  options: { throughNodeId?: string } = {},
): Promise<DataPipelinePreview> {
  const startedAt = performance.now();
  const ordered = validateDataPipeline(definition);
  const throughNodeId = options.throughNodeId;
  if (throughNodeId && !ordered.some((node) => node.id === throughNodeId)) {
    throw new DataPipelineError("调试目标节点不存在", throughNodeId);
  }
  const outputs = new Map<string, Array<Record<string, unknown>>>();
  const diagnostics: DataPipelineNodeDiagnostic[] = [];
  const predecessors = new Map(definition.nodes.map((node) => [node.id, definition.edges.filter((edge) => edge.targetNodeId === node.id).map((edge) => edge.sourceNodeId)]));
  const executionNodeIds = throughNodeId ? collectDependencies(throughNodeId, predecessors) : undefined;

  for (const node of ordered) {
    if (executionNodeIds && !executionNodeIds.has(node.id)) continue;
    const nodeStartedAt = performance.now();
    const inputSets = (predecessors.get(node.id) ?? []).map((nodeId) => outputs.get(nodeId) ?? []);
    const inputRows = inputSets.reduce((sum, rows) => sum + rows.length, 0);
    const inputSample = takeInputSample(inputSets, 5);
    try {
      const rows = await executeNode(node, inputSets, resolveDataset);
      outputs.set(node.id, rows);
      diagnostics.push({ nodeId: node.id, status: "success", inputRows, outputRows: rows.length, durationMs: performance.now() - nodeStartedAt, inputSample, sample: rows.slice(0, 5) });
      if (node.id === throughNodeId) break;
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      diagnostics.push({ nodeId: node.id, status: "error", inputRows, outputRows: 0, durationMs: performance.now() - nodeStartedAt, inputSample, sample: [], error: message });
      throw new DataPipelineError(`${node.name}: ${message}`, node.id, diagnostics);
    }
  }

  const resultNode = throughNodeId ? ordered.find((node) => node.id === throughNodeId) : ordered.find((node) => node.type === "output");
  if (!resultNode) throw new DataPipelineError("流水线必须且只能有一个输出节点", undefined, diagnostics);
  const rows = outputs.get(resultNode.id) ?? [];
  return {
    pipeline: definition,
    status: "success",
    fields: inferFields(rows),
    rows,
    durationMs: performance.now() - startedAt,
    diagnostics,
    ...(throughNodeId ? { executedThroughNodeId: throughNodeId } : {}),
  };
}

function collectDependencies(targetNodeId: string, predecessors: Map<string, string[]>): Set<string> {
  const result = new Set<string>();
  const pending = [targetNodeId];
  while (pending.length > 0) {
    const nodeId = pending.pop();
    if (!nodeId || result.has(nodeId)) continue;
    result.add(nodeId);
    pending.push(...(predecessors.get(nodeId) ?? []));
  }
  return result;
}

function takeInputSample(inputSets: Array<Array<Record<string, unknown>>>, limit: number): Array<Record<string, unknown>> {
  const sample: Array<Record<string, unknown>> = [];
  for (const rows of inputSets) {
    for (const row of rows) {
      sample.push({ ...row });
      if (sample.length === limit) return sample;
    }
  }
  return sample;
}

async function executeNode(node: DataPipelineNode, inputSets: Array<Array<Record<string, unknown>>>, resolveDataset: DatasetResolver): Promise<Array<Record<string, unknown>>> {
  if (node.type === "source") return (await resolveDataset(node.datasetId)).map((row) => ({ ...row }));
  if (node.type === "merge") return inputSets.flat().map((row) => ({ ...row }));
  const rows = inputSets[0] ?? [];
  if (node.type === "output") return rows;
  if (node.type === "filter") {
    const formula = compileFormula(node.formula);
    return rows.filter((row) => Boolean(evaluateFormula(formula, row)));
  }
  if (node.type === "formula") {
    const formula = compileFormula(node.formula);
    return rows.map((row) => ({ ...row, [node.key]: evaluateFormula(formula, row) }));
  }
  if (node.type === "script") {
    const result = await executeRowScript(node.source, rows, {}, { timeoutMs: 150, memoryLimitBytes: 8 * 1024 * 1024 });
    return rows.map((row, index) => ({ ...row, [node.key]: result.output[index] ?? null }));
  }
  if (node.type === "select")
    return rows.map((row) => Object.fromEntries(node.fields.map((field) => [field, row[field]])));
  if (node.type === "deduplicate") {
    const seen = new Set<string>();
    return rows.filter((row) => {
      const key = JSON.stringify(node.fields.length ? node.fields.map((field) => row[field]) : row);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  if (node.type === "aggregate") return aggregateRows(rows, node);
  if (node.type === "sort") return [...rows].sort((left, right) => compareValues(left[node.field], right[node.field]) * (node.direction === "desc" ? -1 : 1));
  return rows.slice(0, node.count);
}

function validateNodeConfiguration(node: DataPipelineNode): void {
  if (!["source", "filter", "formula", "script", "select", "deduplicate", "aggregate", "sort", "limit", "merge", "output"].includes(String(node.type))) throw new DataPipelineError("不支持的节点类型", node.id);
  if (typeof node.name !== "string" || !node.name.trim()) throw new DataPipelineError("节点名称不能为空", node.id);
  if (!node.position || !Number.isFinite(node.position.x) || !Number.isFinite(node.position.y)) throw new DataPipelineError("节点位置无效", node.id);
  if (node.type === "source" && !node.datasetId.trim()) throw new DataPipelineError("数据源节点必须选择数据集", node.id);
  if (node.type === "filter") compileFormula(node.formula);
  if (node.type === "formula") {
    if (!node.key.trim()) throw new DataPipelineError("公式节点输出字段不能为空", node.id);
    compileFormula(node.formula);
  }
  if (node.type === "script" && (!node.key.trim() || !node.source.trim())) throw new DataPipelineError("脚本节点输出字段和脚本不能为空", node.id);
  if (node.type === "select" && node.fields.length === 0) throw new DataPipelineError("字段选择节点至少需要一个字段", node.id);
  if (node.type === "aggregate") {
    if (!node.outputKey.trim()) throw new DataPipelineError("汇总节点输出字段不能为空", node.id);
    if (node.operation !== "count" && !node.field.trim()) throw new DataPipelineError("汇总节点必须选择数值字段", node.id);
  }
  if (node.type === "sort" && !node.field.trim()) throw new DataPipelineError("排序字段不能为空", node.id);
  if (node.type === "limit" && (!Number.isInteger(node.count) || node.count < 1 || node.count > 10_000)) throw new DataPipelineError("限量行数必须是 1 到 10000 的整数", node.id);
}

function aggregateRows(
  rows: Array<Record<string, unknown>>,
  node: Extract<DataPipelineNode, { type: "aggregate" }>,
): Array<Record<string, unknown>> {
  const groups = new Map<string, Array<Record<string, unknown>>>();
  for (const row of rows) {
    const key = JSON.stringify(node.groupBy.map((field) => row[field]));
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const first = group[0] ?? {};
    const values = group.map((row) => row[node.field]).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    let result: number;
    if (node.operation === "count") result = group.length;
    else if (node.operation === "sum") result = values.reduce((sum, value) => sum + value, 0);
    else if (node.operation === "average") result = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
    else if (node.operation === "min") result = values.length ? Math.min(...values) : 0;
    else result = values.length ? Math.max(...values) : 0;
    return {
      ...Object.fromEntries(node.groupBy.map((field) => [field, first[field]])),
      [node.outputKey]: result,
    };
  });
}

function compareValues(left: unknown, right: unknown): number {
  if (left === right) return 0;
  if (left === null || left === undefined) return 1;
  if (right === null || right === undefined) return -1;
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left).localeCompare(String(right), "zh-CN", { numeric: true });
}

function inferFields(rows: Array<Record<string, unknown>>): DataDatasetField[] {
  const samples = new Map<string, unknown>();
  for (const row of rows.slice(0, 100)) {
    for (const [key, value] of Object.entries(row)) {
      const saved = samples.get(key);
      if (!samples.has(key) || ((saved === null || saved === undefined) && value !== null && value !== undefined)) samples.set(key, value);
    }
  }
  return [...samples].map(([key, value]) => ({ key, label: key, type: inferFieldType(value) }));
}

function inferFieldType(value: unknown): DataFieldType {
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (value && typeof value === "object") return "json";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) && Number.isFinite(Date.parse(value))) return "datetime";
  return "string";
}
