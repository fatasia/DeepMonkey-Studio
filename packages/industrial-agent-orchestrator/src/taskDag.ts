import type { AgentEvidence } from "./types.js";

export interface AgentTaskNode {
  id: string;
  dependsOn?: string[];
  /** Scene writes and validation are intentionally explicit so callers can require evidence. */
  kind: "tool" | "capture" | "validate" | "correct";
  run: (context: AgentTaskContext) => Promise<AgentTaskResult>;
}

export interface AgentTaskContext {
  signal: AbortSignal;
  attempt: number;
  outputs: ReadonlyMap<string, unknown>;
}

export interface AgentTaskResult {
  output?: unknown;
  evidence?: AgentEvidence[];
  passed?: boolean;
}

export interface AgentTaskDagOptions {
  maxCorrections?: number;
  signal?: AbortSignal;
}

export interface AgentTaskDagResult {
  status: "completed" | "failed" | "cancelled";
  outputs: ReadonlyMap<string, unknown>;
  evidence: AgentEvidence[];
  completed: string[];
  attempts: number;
  error?: { code: string; message: string };
}

/**
 * Runs a small, deterministic task graph for scene authoring and post-render checks.
 * The graph is deliberately independent of HTTP, React and model providers so the same
 * contract can be used by browser and Native adapters. A correction node may be retried
 * only when validation fails, and the retry budget is always finite.
 */
export async function runAgentTaskDag(
  nodes: readonly AgentTaskNode[],
  options: AgentTaskDagOptions = {},
): Promise<AgentTaskDagResult> {
  const maxCorrections = Math.max(0, Math.floor(options.maxCorrections ?? 2));
  const byId = new Map<string, AgentTaskNode>();
  for (const node of nodes) {
    if (!node.id || byId.has(node.id)) return failed("invalid-graph", `任务节点 ID 重复或为空：${node.id}`);
    byId.set(node.id, node);
  }
  for (const node of nodes) {
    for (const dependency of node.dependsOn ?? []) {
      if (!byId.has(dependency)) return failed("invalid-graph", `任务 ${node.id} 依赖不存在：${dependency}`);
    }
  }
  const outputs = new Map<string, unknown>();
  const evidence: AgentEvidence[] = [];
  const completed: string[] = [];
  const pending = new Set(nodes.map(node => node.id));
  let corrections = 0;
  let attempts = 0;
  while (pending.size) {
    if (options.signal?.aborted) return { status: "cancelled", outputs, evidence, completed, attempts, error: { code: "cancelled", message: "任务图已取消" } };
    const ready = nodes.filter(node => pending.has(node.id) && (node.dependsOn ?? []).every(id => outputs.has(id)));
    if (!ready.length) return failed("cycle", "任务图存在循环依赖或不可满足的依赖");
    for (const node of ready) {
      if (options.signal?.aborted) return { status: "cancelled", outputs, evidence, completed, attempts, error: { code: "cancelled", message: "任务图已取消" } };
      attempts += 1;
      let result: AgentTaskResult;
      try {
        result = await node.run({ signal: options.signal ?? new AbortController().signal, attempt: corrections + 1, outputs });
      } catch (error) {
        return failed("task-failed", error instanceof Error ? error.message : String(error), outputs, evidence, completed, attempts);
      }
      if (node.kind === "validate" && result.passed === false) {
        const correction = nodes.find(candidate => candidate.kind === "correct" && (candidate.dependsOn ?? []).includes(node.id));
        if (!correction || corrections >= maxCorrections) {
          return failed("validation-failed", `验证节点未通过：${node.id}`, outputs, evidence, completed, attempts);
        }
        corrections += 1;
        // Keep validation pending and run its correction immediately. The next graph
        // pass re-runs validation after the correction output is available.
        outputs.set(node.id, result.output ?? { passed: false });
        const correctionResult = await correction.run({ signal: options.signal ?? new AbortController().signal, attempt: corrections + 1, outputs });
        attempts += 1;
        if (correctionResult.output !== undefined) outputs.set(correction.id, correctionResult.output);
        evidence.push(...(correctionResult.evidence ?? []));
        completed.push(correction.id);
        pending.delete(correction.id);
        continue;
      }
      if (result.output !== undefined) outputs.set(node.id, result.output);
      evidence.push(...(result.evidence ?? []));
      completed.push(node.id);
      pending.delete(node.id);
    }
  }
  return { status: "completed", outputs, evidence, completed, attempts };
}

function failed(
  code: string,
  message: string,
  outputs = new Map<string, unknown>(),
  evidence: AgentEvidence[] = [],
  completed: string[] = [],
  attempts = 0,
): AgentTaskDagResult {
  return { status: "failed", outputs, evidence, completed, attempts, error: { code, message } };
}
