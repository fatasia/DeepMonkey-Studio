import type { SceneBehaviorModule, SceneBehaviorWorkerRequest, SceneBehaviorWorkerResponse } from "@bim-studio/scene-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SceneBehaviorManager } from "./SceneBehaviorManager";
import type { SceneBehaviorWorkerPort } from "./SceneBehaviorHost";

/**
 * H-C6-S1 多模块热插交互合同(2026-10-03):
 * Manager 按 entryId 多宿主并存(hotSwap 直通对应 Host)——本文件钉死
 * "热插其一不波及其余"的隔离合同:worker 消息面、运行态、advance 连续性、回滚边界。
 */

class FakeWorker implements SceneBehaviorWorkerPort {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly posted: SceneBehaviorWorkerRequest[] = [];
  terminate = vi.fn();
  postMessage(message: SceneBehaviorWorkerRequest): void {
    this.posted.push(structuredClone(message));
    // 真实 worker 会回执生命周期调用;不回执会触发宿主 pending/预算闸门(丢弃或 fail)。
    // 回执走微任务:同步回执会在调度器 tick 内重入,不是真实消息时序。
    if (message.type === "behavior.invoke") {
      const invocationId = message.invocationId;
      queueMicrotask(() => this.emit({ type: "behavior.result", invocationId, durationMs: 0,
        commands: [], events: [] } as unknown as SceneBehaviorWorkerResponse));
    }
  }
  emit(message: SceneBehaviorWorkerResponse): void { this.onmessage?.({ data: message } as MessageEvent<unknown>); }
  messages<TType extends SceneBehaviorWorkerRequest["type"]>(type: TType): Extract<SceneBehaviorWorkerRequest, { type: TType }>[] {
    return this.posted.filter((message): message is Extract<SceneBehaviorWorkerRequest, { type: TType }> => message.type === type);
  }
  invokeCount(): number { return this.messages("behavior.invoke").length; }
}

const moduleOf = (id: string): SceneBehaviorModule =>
  ({ id, name: id, apiVersion: "1.0", code: "function onUpdate(ctx) {}", lifecycle: ["onStart", "onStop"],
    capabilities: ["studio.runtime"], permissions: ["scene.write"] } as unknown as SceneBehaviorModule);

const ready = (worker: FakeWorker, moduleId: string): void =>
  worker.emit({ type: "behavior.ready", moduleId, lifecycle: ["onStart", "onStop"] } as SceneBehaviorWorkerResponse);

function dualHostManager(hostOptions?: { initializationTimeoutMs: number }) {
  const workers: FakeWorker[] = [];
  const manager = new SceneBehaviorManager({
    workerFactory: () => { const worker = new FakeWorker(); workers.push(worker); return worker; },
    ...(hostOptions ? { hostOptions } : {}),
  });
  manager.start([moduleOf("a"), moduleOf("b")], "scene-1");
  ready(workers[0]!, "a");
  ready(workers[1]!, "b");
  return { manager, workers };
}

const flushMicrotasks = async (): Promise<void> => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); };

describe("SceneBehaviorManager 多模块热插交互(H-C6-S1)", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("同场景双模块:热插 A 全程 B 的 worker 结构零变化、状态保持 running", async () => {
    const { manager, workers } = dualHostManager();
    const [a, b] = workers;
    const bInitializes = b!.messages("behavior.initialize").length; // B 初始挂载恰 1 次。

    manager.hotSwap("a", moduleOf("a:v2"));
    expect(a!.messages("behavior.initialize")).toHaveLength(2); // 初始 + 热插。
    // B 的 worker 在 A 热插期间零新增结构消息。
    expect(b!.messages("behavior.initialize")).toHaveLength(bInitializes);
    expect(b!.messages("behavior.dispose")).toHaveLength(0);

    ready(a!, "a:v2");
    expect(a!.messages("behavior.invoke").filter(message => message.lifecycle === "onStart")).toHaveLength(2);
    expect(manager.entries().every(entry => entry.diagnostics.status === "running")).toBe(true);
    manager.advance(16);
    await flushMicrotasks();
    // 热插完成后 B 仍在推进(至少收到一次 onUpdate invoke,计数不回退)。
    expect(b!.invokeCount()).toBeGreaterThanOrEqual(1);
  });

  it("热插 A 初始化超时回滚:B 运行态与 advance 不受影响,A 恢复旧模块", async () => {
    vi.useFakeTimers();
    const { manager, workers } = dualHostManager({ initializationTimeoutMs: 50 });
    const [a, b] = workers;

    await flushMicrotasks(); // 先排空初始 onStart 的回执,避免 fake 时间把正常 pending 判超时。
    manager.hotSwap("a", moduleOf("a:bad"));
    vi.advanceTimersByTime(60); // a:bad 的 ready 不来 → 超时回滚 v1。
    expect(a!.messages("behavior.initialize").at(-1)).toMatchObject({ module: { id: "a" } });
    // B 全程无波及:仅初始挂载那一次 initialize,无 dispose,状态仍 running。
    expect(b!.messages("behavior.dispose")).toHaveLength(0);
    expect(b!.messages("behavior.initialize")).toHaveLength(1);
    expect(manager.entries().find(entry => entry.module.id === "b")?.diagnostics.status).toBe("running");

    ready(a!, "a");
    expect(manager.entries().find(entry => entry.module.id === "a")?.diagnostics.status).toBe("running");
  });

  it("Manager 暂停态热插:ready 后该宿主保持 paused 不发 onStart,其余宿主同 paused", async () => {
    const { manager, workers } = dualHostManager();
    const [a, b] = workers;
    manager.pause();
    manager.hotSwap("a", moduleOf("a:v2"));
    ready(a!, "a:v2");
    expect(a!.messages("behavior.invoke").filter(message => message.lifecycle === "onStart")).toHaveLength(1); // 仅热插前旧 onStart。
    expect(manager.entries().every(entry => entry.diagnostics.status === "paused")).toBe(true);
    manager.resume();
    expect(manager.entries().every(entry => entry.diagnostics.status === "running")).toBe(true);
    expect(b!.messages("behavior.dispose")).toHaveLength(0);
  });

  it("跨场景宿主:reconcile 拆除旧场景宿主后,新场景热插仍按 entryId 精确命中", async () => {
    vi.useFakeTimers();
    const { manager, workers } = dualHostManager();
    const [a] = workers;
    // 场景切换:scene-2 只装 c;scene-1 的 a/b 被拆除,新 worker 给 c。
    manager.reconcile([moduleOf("c")], () => "scene-2");
    ready(workers[2]!, "c");
    await flushMicrotasks(); // 排空 c 的 onStart 回执,fake 时间只该推进 a/b 的 dispose 超时。
    expect(workers[0]!.messages("behavior.dispose")).toHaveLength(1);
    // dispose 两段式:worker 无回执,推进超时预算后 finishDispose→terminate。
    vi.advanceTimersByTime(10_000);
    expect(a!.terminate).toHaveBeenCalledOnce();
    // c 场景内热插精确命中 c 宿主。
    manager.hotSwap("c", moduleOf("c:v2"));
    expect(workers[2]!.messages("behavior.initialize").at(-1)).toMatchObject({ module: { id: "c:v2" } });
    expect(workers[0]!.messages("behavior.dispose")).toHaveLength(1); // 已拆宿主无二次消息。
  });
});
