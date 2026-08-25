export type FactoryNodeKind = "source" | "process" | "buffer" | "sink" | "agv";

interface FactoryNodeBase {
  id: string;
  name: string;
}

export interface SourceNode extends FactoryNodeBase {
  kind: "source";
  interarrivalTimeMs: number;
  initialDelayMs?: number;
  maxItems?: number;
}

export interface ProcessNode extends FactoryNodeBase {
  kind: "process";
  cycleTimeMs: number;
  /** Parallel processing stations. */
  capacity?: number;
  /** Maximum number of items waiting before a station. */
  queueCapacity?: number;
}

export interface BufferNode extends FactoryNodeBase {
  kind: "buffer";
  capacity: number;
}

export interface SinkNode extends FactoryNodeBase {
  kind: "sink";
}

export interface AgvNode extends FactoryNodeBase {
  kind: "agv";
  travelTimeMs: number;
  /** Parallel vehicles represented by this logical AGV group. */
  capacity?: number;
  queueCapacity?: number;
}

export type FactoryNode = SourceNode | ProcessNode | BufferNode | SinkNode | AgvNode;

export interface FactoryEdge {
  id: string;
  from: string;
  to: string;
  /** Lower values are attempted first when a node has multiple outgoing routes. */
  priority?: number;
}

export interface FactoryFlowModel {
  id: string;
  name: string;
  nodes: FactoryNode[];
  edges: FactoryEdge[];
}

export interface FactoryModelIssue {
  path: string;
  message: string;
}

export type FactoryModelValidation =
  | { valid: true; model: FactoryFlowModel; issues: [] }
  | { valid: false; issues: FactoryModelIssue[] };

/** Validates the intentionally small, deterministic M8 flow graph contract. */
export function validateFactoryFlowModel(input: unknown): FactoryModelValidation {
  const issues: FactoryModelIssue[] = [];
  if (!isRecord(input)) return invalid("$", "model must be an object");
  validateText(input.id, "$.id", issues);
  validateText(input.name, "$.name", issues);
  if (!Array.isArray(input.nodes) || input.nodes.length === 0) {
    issues.push({ path: "$.nodes", message: "nodes must be a non-empty array" });
  }
  if (!Array.isArray(input.edges)) issues.push({ path: "$.edges", message: "edges must be an array" });
  if (issues.length > 0) return { valid: false, issues };

  const nodes = input.nodes as unknown[];
  const edges = input.edges as unknown[];
  const nodeIds = new Set<string>();
  nodes.forEach((value, index) => validateNode(value, index, nodeIds, issues));
  const edgeIds = new Set<string>();
  const adjacency = new Map<string, string[]>();
  edges.forEach((value, index) => validateEdge(value, index, edgeIds, nodeIds, adjacency, issues));

  if (issues.length === 0) {
    const typedNodes = nodes as FactoryNode[];
    const typedEdges = edges as FactoryEdge[];
    const incoming = new Set(typedEdges.map((edge) => edge.to));
    const outgoing = new Set(typedEdges.map((edge) => edge.from));
    for (const node of typedNodes) {
      if (node.kind === "source" && incoming.has(node.id)) issues.push({ path: `$.nodes.${node.id}`, message: "source cannot have incoming edges" });
      if (node.kind === "sink" && outgoing.has(node.id)) issues.push({ path: `$.nodes.${node.id}`, message: "sink cannot have outgoing edges" });
      if (node.kind !== "sink" && !outgoing.has(node.id)) issues.push({ path: `$.nodes.${node.id}`, message: "non-sink node must have an outgoing edge" });
    }
    if (hasCycle(typedNodes.map((node) => node.id), adjacency)) issues.push({ path: "$.edges", message: "flow graph must be acyclic" });
  }

  if (issues.length > 0) return { valid: false, issues };
  return { valid: true, model: structuredClone(input) as unknown as FactoryFlowModel, issues: [] };
}

export function assertFactoryFlowModel(input: unknown): FactoryFlowModel {
  const validation = validateFactoryFlowModel(input);
  if (!validation.valid) throw new Error(validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
  return validation.model;
}

function validateNode(value: unknown, index: number, ids: Set<string>, issues: FactoryModelIssue[]): void {
  const path = `$.nodes[${index}]`;
  if (!isRecord(value)) {
    issues.push({ path, message: "node must be an object" });
    return;
  }
  validateUniqueText(value.id, `${path}.id`, ids, issues);
  validateText(value.name, `${path}.name`, issues);
  if (value.kind === "source") {
    validatePositive(value.interarrivalTimeMs, `${path}.interarrivalTimeMs`, issues);
    validateNonNegativeOptional(value.initialDelayMs, `${path}.initialDelayMs`, issues);
    validatePositiveIntegerOptional(value.maxItems, `${path}.maxItems`, issues);
    return;
  }
  if (value.kind === "process") {
    validatePositive(value.cycleTimeMs, `${path}.cycleTimeMs`, issues);
    validatePositiveIntegerOptional(value.capacity, `${path}.capacity`, issues);
    validatePositiveIntegerOptional(value.queueCapacity, `${path}.queueCapacity`, issues);
    return;
  }
  if (value.kind === "buffer") {
    validatePositiveInteger(value.capacity, `${path}.capacity`, issues);
    return;
  }
  if (value.kind === "sink") return;
  if (value.kind === "agv") {
    validatePositive(value.travelTimeMs, `${path}.travelTimeMs`, issues);
    validatePositiveIntegerOptional(value.capacity, `${path}.capacity`, issues);
    validatePositiveIntegerOptional(value.queueCapacity, `${path}.queueCapacity`, issues);
    return;
  }
  issues.push({ path: `${path}.kind`, message: "kind must be source, process, buffer, sink or agv" });
}

function validateEdge(
  value: unknown,
  index: number,
  ids: Set<string>,
  nodeIds: Set<string>,
  adjacency: Map<string, string[]>,
  issues: FactoryModelIssue[]
): void {
  const path = `$.edges[${index}]`;
  if (!isRecord(value)) {
    issues.push({ path, message: "edge must be an object" });
    return;
  }
  validateUniqueText(value.id, `${path}.id`, ids, issues);
  validateText(value.from, `${path}.from`, issues);
  validateText(value.to, `${path}.to`, issues);
  if (typeof value.from === "string" && !nodeIds.has(value.from)) issues.push({ path: `${path}.from`, message: "unknown source node" });
  if (typeof value.to === "string" && !nodeIds.has(value.to)) issues.push({ path: `${path}.to`, message: "unknown target node" });
  if (value.priority !== undefined && !Number.isSafeInteger(value.priority)) issues.push({ path: `${path}.priority`, message: "priority must be an integer" });
  if (typeof value.from === "string" && typeof value.to === "string" && nodeIds.has(value.from) && nodeIds.has(value.to)) {
    const targets = adjacency.get(value.from) ?? [];
    targets.push(value.to);
    adjacency.set(value.from, targets);
  }
}

function hasCycle(nodeIds: string[], adjacency: Map<string, string[]>): boolean {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeId: string): boolean => {
    if (visiting.has(nodeId)) return true;
    if (visited.has(nodeId)) return false;
    visiting.add(nodeId);
    for (const target of adjacency.get(nodeId) ?? []) if (visit(target)) return true;
    visiting.delete(nodeId);
    visited.add(nodeId);
    return false;
  };
  return nodeIds.some(visit);
}

function validateUniqueText(value: unknown, path: string, ids: Set<string>, issues: FactoryModelIssue[]): void {
  validateText(value, path, issues);
  if (typeof value !== "string" || !value.trim()) return;
  if (ids.has(value)) issues.push({ path, message: `duplicate id ${value}` });
  ids.add(value);
}

function validateText(value: unknown, path: string, issues: FactoryModelIssue[]): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 120) issues.push({ path, message: "must be a non-empty string up to 120 characters" });
}

function validatePositive(value: unknown, path: string, issues: FactoryModelIssue[]): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) issues.push({ path, message: "must be a positive finite number" });
}

function validatePositiveInteger(value: unknown, path: string, issues: FactoryModelIssue[]): void {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) issues.push({ path, message: "must be a positive integer" });
}

function validatePositiveIntegerOptional(value: unknown, path: string, issues: FactoryModelIssue[]): void {
  if (value !== undefined) validatePositiveInteger(value, path, issues);
}

function validateNonNegativeOptional(value: unknown, path: string, issues: FactoryModelIssue[]): void {
  if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) issues.push({ path, message: "must be a non-negative finite number" });
}

function invalid(path: string, message: string): FactoryModelValidation {
  return { valid: false, issues: [{ path, message }] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
