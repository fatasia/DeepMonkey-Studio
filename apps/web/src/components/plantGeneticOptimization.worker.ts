import type { GeneticOptimizationConfig, GeneticOptimizationResult, PlantLiteModel } from "@bim-studio/contracts";
import { GeneticOptimizer } from "@bim-studio/plant-lite-simulation";

interface Request { model: PlantLiteModel; stationId: string; minimumMinutes: number; maximumMinutes: number; seed: string | number; }
type Reply = { ok: true; result: GeneticOptimizationResult } | { ok: false; message: string };

self.onmessage = (event: MessageEvent<Request>) => {
  try {
    const { model, stationId, minimumMinutes, maximumMinutes, seed } = event.data;
    if (!Number.isFinite(minimumMinutes) || !Number.isFinite(maximumMinutes) || minimumMinutes <= 0 || maximumMinutes <= minimumMinutes) throw new Error("工时搜索范围无效。");
    const config: GeneticOptimizationConfig = {
      metricPath: "confidence95.throughputPerHour.mean", goal: "maximize", populationSize: 4,
      generations: 2, crossoverRate: 0.8, mutationRate: 0.2, seed, replications: 2,
      limits: { durationMinutes: 45, maxEvents: 2_000, maxResources: 100 },
    };
    const optimizer = new GeneticOptimizer(config, [{ id: "minutes", label: "工位工时（分钟）", values: [minimumMinutes, maximumMinutes], apply(candidate, minutes) {
      const station = candidate.nodes.find((node) => node.id === stationId);
      if (!station || station.kind !== "station" || station.processingTime.kind !== "deterministic") throw new Error("工位不再是确定性加工工位。");
      station.processingTime = { kind: "deterministic", value: minutes };
    } }], model);
    const result = optimizer.optimize();
    self.postMessage({ ok: true, result } satisfies Reply);
  } catch (error) {
    self.postMessage({ ok: false, message: error instanceof Error ? error.message : "GA 筛查失败，请检查模型。" } satisfies Reply);
  }
};
