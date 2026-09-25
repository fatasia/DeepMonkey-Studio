/**
 * Plant Lite 性能基准(vitest 入口,替代挂起的 tsx 直跑路径)。
 * 运行:pnpm vitest run scripts/bench.test.ts
 * 每场景预热 1 次后计时 3 次取中位;结果 JSON 打到 stdout 并落盘 test-output。
 */

import { describe, expect, it } from "vitest";
import { runPlantLiteExperiment } from "../engine.js";
import { golden01SingleLine, golden04Changeover, golden05MultiAgv } from "../golden/goldenModels.js";
import type { PlantLiteModel } from "../modelTypes.js";

interface BenchScenario {
  name: string;
  model: PlantLiteModel;
  replications: number;
  limits: { durationMinutes: number; warmupMinutes?: number; maxEvents?: number };
}

/** 大模型扩展性:N 工位串联 + N 设备资源,验证事件数与墙钟的缩放关系。 */
function buildLargeLine(stations: number): PlantLiteModel {
  const nodes: PlantLiteModel["nodes"] = [
    { id: "src", name: "来料", kind: "source", interarrivalTime: { kind: "deterministic", value: 0.05 } },
  ];
  const edges: PlantLiteModel["edges"] = [];
  const resources: PlantLiteModel["resources"] = [];
  for (let index = 0; index < stations; index += 1) {
    const stationId = `st${index}`;
    nodes.push({ id: stationId, name: `工位${index}`, kind: "station", processingTime: { kind: "deterministic", value: 0.01 }, resourceId: `mc${index}` });
    resources.push({ id: `mc${index}`, name: `设备${index}`, kind: "equipment", capacity: 1 });
    edges.push({ id: `e-in-${index}`, from: index === 0 ? "src" : `st${index - 1}`, to: stationId });
  }
  nodes.push({ id: "snk", name: "出货", kind: "sink" });
  edges.push({ id: "e-out", from: `st${stations - 1}`, to: "snk" });
  return { id: `bench-large-${stations}`, name: `基准 · ${stations} 工位串联`, nodes, edges, resources };
}

const SCENARIOS: BenchScenario[] = [
  { name: "golden01-single-line", model: golden01SingleLine(), replications: 10, limits: { durationMinutes: 480, warmupMinutes: 60 } },
  { name: "golden04-changeover", model: golden04Changeover(), replications: 10, limits: { durationMinutes: 480, warmupMinutes: 60 } },
  { name: "golden05-multi-agv", model: golden05MultiAgv(), replications: 10, limits: { durationMinutes: 120 } },
  { name: "large-20-stations", model: buildLargeLine(20), replications: 5, limits: { durationMinutes: 480, maxEvents: 100_000 } },
  { name: "large-60-stations", model: buildLargeLine(60), replications: 5, limits: { durationMinutes: 480, maxEvents: 100_000 } },
];

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

describe("plant-lite 性能基准", () => {
  it("采集各场景墙钟与事件吞吐(中位数,3 轮)", () => {
    const results = SCENARIOS.map((scenario) => {
      const input = { model: scenario.model, seed: "bench-2026-09-25", replications: scenario.replications, limits: scenario.limits };
      runPlantLiteExperiment(input); // 预热
      const wallClockMs: number[] = [];
      let events = 0;
      let items = 0;
      let terminated = "";
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const started = performance.now();
        const result = runPlantLiteExperiment(input);
        wallClockMs.push(performance.now() - started);
        events = result.replications.reduce((sum, item) => sum + item.processedEvents, 0);
        items = result.replications.reduce((sum, item) => sum + item.completedItems, 0);
        terminated = result.replications.map((item) => item.termination).join(",");
      }
      const wallMs = median(wallClockMs);
      expect(wallMs).toBeGreaterThan(0);
      return {
        scenario: scenario.name,
        nodes: scenario.model.nodes.length,
        resources: scenario.model.resources?.length ?? 0,
        replications: scenario.replications,
        termination: terminated,
        wallClockMs: Number(wallMs.toFixed(1)),
        wallClockSamples: wallClockMs.map((value) => Number(value.toFixed(1))),
        processedEvents: events,
        eventsPerSecond: Math.round(events / (wallMs / 1000)),
        completedItems: items,
      };
    });
    const report = {
      generatedAt: new Date().toISOString(),
      runtime: { node: process.version, platform: process.platform },
      results,
    };
    console.log("PLANT-LITE-BENCH-JSON " + JSON.stringify(report));
    expect(results.length).toBe(SCENARIOS.length);
  }, 120_000);
});
