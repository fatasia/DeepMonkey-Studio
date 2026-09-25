import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { SimulationPortError } from "@bim-studio/contracts";
import { plantLiteSimulationEngine, type PlantLiteExperiment } from "@bim-studio/plant-lite-simulation";
import { isNodeWatchControlMessage } from "./plantLiteWorkerExecutor.js";
import type { PlantLitePortProbeSummary } from "./plantLitePortProbeWorker.js";

/** 门禁线:与 engine.test.ts 同形的最简单线;引擎确定性已由内核测试背书。 */
const LINE: PlantLiteExperiment = {
  seed: "cross-boundary",
  replications: 2,
  limits: { durationMinutes: 60, maxEvents: 1_000, maxResources: 4 },
  model: {
    id: "cross-line",
    name: "跨端门禁线",
    nodes: [
      { id: "source", name: "来料", kind: "source", interarrivalTime: { kind: "deterministic", value: 10 }, maxItems: 6 },
      { id: "station", name: "加工", kind: "station", processingTime: { kind: "deterministic", value: 3 } },
      { id: "sink", name: "出货", kind: "sink" },
    ],
    edges: [{ id: "1", from: "source", to: "station" }, { id: "2", from: "station", to: "sink" }],
  },
};

const SEED = "cross-seed-1";

function createProbeWorker(): Worker {
  if (import.meta.url.endsWith(".ts")) {
    // 开发进程从 workspace 源码解析包;Worker 必须继承同一条件,否则静默加载陈旧 dist 导出。
    return new Worker(new URL("./plantLitePortProbeWorker.ts", import.meta.url), {
      execArgv: ["--conditions=development", "--import", "tsx"],
    });
  }
  return new Worker(new URL("./plantLitePortProbeWorker.js", import.meta.url));
}

function runProbe(experiment: PlantLiteExperiment, seed: string | number, replications?: number): Promise<PlantLitePortProbeSummary> {
  return new Promise((resolve, reject) => {
    const worker = createProbeWorker();
    let settled = false;
    const timeout = setTimeout(() => finish(() => reject(new Error("Plant Lite 端口探针 Worker 超时(10s)"))), 10_000);
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      worker.removeAllListeners();
      void worker.terminate();
      action();
    };
    worker.once("error", (error) => finish(() => reject(error)));
    worker.on("message", (message: unknown) => {
      if (isNodeWatchControlMessage(message)) return;
      const value = message as { type?: string; record?: PlantLitePortProbeSummary; message?: string };
      if (value.type === "result" && value.record) {
        const record = value.record;
        finish(() => resolve(record));
        return;
      }
      if (value.type === "error") {
        const workerMessage = value.message ?? "";
        finish(() => reject(new Error(`探针 Worker 返回错误:${workerMessage}`)));
        return;
      }
      finish(() => reject(new Error(`探针 Worker 协议无效:${JSON.stringify(value)}`)));
    });
    worker.postMessage({ experiment, seed, ...(replications !== undefined ? { replications } : {}) });
  });
}

describe("Plant Lite 端口跨端确定性门禁", () => {
  it("进程内与 Worker 对同一 experiment+seed 产出逐字相同的指纹", async () => {
    const inProcess = await plantLiteSimulationEngine.run({ input: LINE, seed: SEED, replications: 2 });
    const fromWorker = await runProbe(LINE, SEED, 2);
    expect(fromWorker.resultFingerprint).toBe(inProcess.resultFingerprint);
    expect(fromWorker.inputFingerprint).toBe(inProcess.inputFingerprint);
    expect(fromWorker.termination).toBe("completed");
    expect(fromWorker.replications).toBe(2);
  });

  it("同种子重复运行指纹恒定,不同种子指纹必然不同", async () => {
    const first = await plantLiteSimulationEngine.run({ input: LINE, seed: SEED, replications: 2 });
    const repeated = await plantLiteSimulationEngine.run({ input: LINE, seed: SEED, replications: 2 });
    const otherSeed = await plantLiteSimulationEngine.run({ input: LINE, seed: "cross-seed-2", replications: 2 });
    expect(repeated.resultFingerprint).toBe(first.resultFingerprint);
    expect(otherSeed.resultFingerprint).not.toBe(first.resultFingerprint);
  });

  it("空模型在进程内抛 SimulationPortError 且 issues 非空,Worker 边界不伪造结果", async () => {
    const invalidModel: PlantLiteExperiment = { model: { id: "empty", name: "空模型", nodes: [], edges: [] }, seed: SEED };
    const failure: unknown = await plantLiteSimulationEngine
      .run({ input: invalidModel, seed: SEED })
      .then((record) => record, (error: unknown) => error);
    expect(failure).toBeInstanceOf(SimulationPortError);
    expect((failure as SimulationPortError).issues.length).toBeGreaterThan(0);
    await expect(runProbe(invalidModel, SEED)).rejects.toThrow(/模型校验失败/);
  });

  it("shouldCancel 立即返回 true 时终止口径为 cancelled", async () => {
    const cancelled = await plantLiteSimulationEngine.run({
      input: LINE,
      seed: SEED,
      replications: 2,
      shouldCancel: () => true,
    });
    expect(cancelled.termination).toBe("cancelled");
    expect(cancelled.replications).toBe(0);
  });
});
