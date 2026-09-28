import type { SceneInteractionScriptState, SceneInteractionTarget, SceneInteractionTrigger } from "@bim-studio/contracts";
import type { InteractionEventDetail } from "../viewer/viewerTypes";
import { sameRuntimeInteractionTarget } from "../viewer/viewerStateUtils";
import { validateBehaviorGraph } from "./behaviorGraph";
import { BehaviorGraphRuntime, type BehaviorCommandOut, type BehaviorDispatchResult } from "./behaviorGraphRuntime";
import { type BehaviorTraceEntry } from "./behaviorTraceLog";
import { executeRestrictedCommand, type RestrictedCommandHost } from "./restrictedCommandAdapter";
import { isRestrictedInteractionScript, parseRestrictedInteractionScript } from "./restrictedInteractionDocument";

export interface RestrictedPlayConsumerOptions {
  readonly scripts: readonly SceneInteractionScriptState[];
  readonly host: RestrictedCommandHost;
  readonly onTrace?: (scriptId: string, entries: readonly BehaviorTraceEntry[]) => void;
  readonly onCommand?: (receipt: { scriptId: string; command: BehaviorCommandOut; status: "applied" | "rejected"; reason?: string; atMs: number }) => void;
  readonly onError?: (error: Error) => void;
}

export interface RestrictedPlayConsumer {
  readonly running: boolean;
  /** Prevalidate every enabled restricted graph before launching any script. */
  start(): void;
  /** Use the exact interaction dispatch target (including layerId) and original event payload. */
  dispatchInteraction(trigger: SceneInteractionTrigger, target: SceneInteractionTarget, detail?: Pick<InteractionEventDetail, "payload" | "test">): void;
  /** Simulation delta in milliseconds, provided by the T30 host, never wall-clock. */
  advance(deltaMs: number): void;
  /** Publish data-key changes into the deterministic graph runtime. */
  applyData(record: Readonly<Record<string, unknown>>): void;
  /** Synchronously block new commands, wait for in-flight command before T30 snapshot restoration. */
  stop(): Promise<void>;
}

interface BoundScript {
  readonly script: SceneInteractionScriptState;
  readonly runtime: BehaviorGraphRuntime;
}

/** The trusted JS path is retained unchanged. Only explicitly marked scripts enter this Play-only consumer. */
export function createRestrictedPlayConsumer(options: RestrictedPlayConsumerOptions): RestrictedPlayConsumer {
  let sessions: BoundScript[] = [];
  let running = false;
  let pending: Promise<void> = Promise.resolve();
  let generation = 0;
  let nextCommand = 1;
  const MAX_PENDING_COMMANDS = 1_024;
  let queuedCommands = 0;
  const error = (cause: unknown): void => {
    const normalized = cause instanceof Error ? cause : new Error(String(cause));
    if (!options.onError) { console.error("受限行为图执行失败", normalized); return; }
    try { options.onError(normalized); }
    catch (reportFailure) { console.error("受限行为图错误回调失败", reportFailure); }
  };

  function enqueue(bound: BoundScript, result: BehaviorDispatchResult, target: SceneInteractionTarget, epoch: number): void {
    if (result.entries.length) options.onTrace?.(bound.script.id, bound.runtime.traceLog.snapshot());
    if (result.status === "budget-exceeded") error(new Error(result.reason ?? "受限行为图超过仿真预算"));
    if (!result.commands.length) return;
    if (queuedCommands + result.commands.length > MAX_PENDING_COMMANDS) {
      const reason = `受限命令队列超过 ${MAX_PENDING_COMMANDS} 条上限，本次派发已拒绝`;
      bound.runtime.traceLog.append({ graphId: bound.script.id, eventNodeId: "host", outcome: "rejected", reason, atMs: bound.runtime.nowMs() });
      options.onTrace?.(bound.script.id, bound.runtime.traceLog.snapshot());
      error(new Error(reason));
      return;
    }
    queuedCommands += result.commands.length;
    // Capture dispatch time, not queue execution time: later ticks may arrive while a transition is awaiting.
    const atMs = bound.runtime.nowMs();
    // A single ordered queue prevents async visibility transitions from overtaking later scene commands.
    pending = pending.then(async () => {
      for (const command of result.commands) {
        queuedCommands--;
        if (!running || generation !== epoch) continue;
        try {
          await executeRestrictedCommand(options.host, command, target, nextCommand++);
          options.onCommand?.({ scriptId: bound.script.id, command, status: "applied", atMs });
        } catch (cause) {
          const reason = cause instanceof Error ? cause.message : String(cause);
          bound.runtime.traceLog.append({ graphId: bound.script.id, eventNodeId: "host", action: command.kind, outcome: "rejected", reason, atMs });
          options.onTrace?.(bound.script.id, bound.runtime.traceLog.snapshot());
          options.onCommand?.({ scriptId: bound.script.id, command, status: "rejected", reason, atMs });
          error(new Error(`受限动作 ${command.kind} 执行失败：${reason}`));
        }
      }
    }).catch(error);
  }

  return {
    get running() { return running; },
    start(): void {
      if (running) return;
      if (sessions.length) throw new Error("受限播放脚本仍在停止中，请等待命令排空后重试");
      const prepared: BoundScript[] = [];
      for (const script of options.scripts) {
        if (!script.enabled || !isRestrictedInteractionScript(script)) continue;
        const graph = parseRestrictedInteractionScript(script);
        const compiled = validateBehaviorGraph(graph, {
          targetExists: (id) => options.host.engine.listModels().some((model) => model.id === id),
        });
        if (!compiled.valid) throw new Error(`受限行为图 ${script.name} 目标校验失败：${compiled.issues.map((issue) => issue.message).join("；")}`);
        prepared.push({ script, runtime: new BehaviorGraphRuntime({ graph: compiled.graph }) });
      }
      sessions = prepared;
      generation++;
      nextCommand = 1;
      running = true;
    },
    dispatchInteraction(trigger, target, detail = {}): void {
      if (!running || detail.test) return;
      const epoch = generation;
      for (const bound of sessions) {
        if (bound.script.trigger !== trigger || !sameRuntimeInteractionTarget(bound.script.target, target)) continue;
        try {
          const payload = detail.payload === undefined ? undefined : detachedPayload(detail.payload);
          const result = bound.runtime.dispatchEvent(`interaction.${trigger}`, payload, { trigger, target });
          enqueue(bound, result, target, epoch);
        } catch (cause) { error(cause); }
      }
    },
    advance(deltaMs): void {
      if (!running || !Number.isFinite(deltaMs) || deltaMs <= 0) return;
      const epoch = generation;
      for (const bound of sessions) {
        try { enqueue(bound, bound.runtime.advance(deltaMs), bound.script.target, epoch); }
        catch (cause) { error(cause); }
      }
    },
    applyData(record): void {
      if (!running) return;
      const epoch = generation;
      try {
        const detached = detachedPayload(record) as Record<string, unknown>;
        for (const bound of sessions) enqueue(bound, bound.runtime.applyData(detached), bound.script.target, epoch);
      } catch (cause) { error(cause); }
    },
    async stop(): Promise<void> {
      if (!running && sessions.length === 0) return;
      running = false;
      generation++;
      try { await pending; } finally { sessions = []; }
    },
  };
}

function detachedPayload(payload: unknown): unknown {
  const serialized = JSON.stringify(payload);
  if (serialized === undefined || serialized.length > 4_096) throw new Error("受限事件数据必须是 ≤4096 字符的 JSON 值");
  return JSON.parse(serialized) as unknown;
}
