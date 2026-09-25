import { parentPort } from "node:worker_threads";
import type { SimulationTermination } from "@bim-studio/contracts";
import { plantLiteSimulationEngine, type PlantLiteExperiment } from "@bim-studio/plant-lite-simulation";

/** 跨端确定性探针请求:与进程内 run 完全相同的输入三要素。 */
export interface PlantLitePortProbeRequest {
  experiment: PlantLiteExperiment;
  seed: string | number;
  replications?: number;
}

/** 只过消息边界的四字段摘要;完整 result 留在 Worker 内,避免大对象跨端拷贝。 */
export interface PlantLitePortProbeSummary {
  inputFingerprint: string;
  resultFingerprint: string;
  termination: SimulationTermination;
  replications: number;
}

type PlantLitePortProbeResponse =
  | { type: "result"; record: PlantLitePortProbeSummary }
  | { type: "error"; message: string };

const port = parentPort;
if (!port) throw new Error("Plant Lite 端口探针 Worker 必须由 worker_threads 启动");

port.on("message", (payload: PlantLitePortProbeRequest) => {
  void plantLiteSimulationEngine
    .run({
      input: payload.experiment,
      seed: payload.seed,
      ...(payload.replications !== undefined ? { replications: payload.replications } : {}),
    })
    .then((record) => {
      const summary: PlantLitePortProbeSummary = {
        inputFingerprint: record.inputFingerprint,
        resultFingerprint: record.resultFingerprint,
        termination: record.termination,
        replications: record.replications,
      };
      port.postMessage({ type: "result", record: summary } satisfies PlantLitePortProbeResponse);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      port.postMessage({ type: "error", message } satisfies PlantLitePortProbeResponse);
    });
});
