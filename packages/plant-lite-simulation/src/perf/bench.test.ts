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
  limits: { durationMinutes: number; warmupMinutes?: number; maxEvents?: number; maxResources?: number };
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

/** 规模档位模型:lines 条并行产线 × stationsPerLine 工位/线;每个工位独立设备资源。
 *  对标西门子档位口径(Essentials ≤500 / Standard ≤4000 / Advanced 全厂对象):
 *  节点数 = 1 source + lines×stationsPerLine 工位 + lines sink;资源数 = lines×stationsPerLine。 */
function buildTierModel(lines: number, stationsPerLine: number): PlantLiteModel {
  const nodes: PlantLiteModel["nodes"] = [];
  const edges: PlantLiteModel["edges"] = [];
  const resources: PlantLiteModel["resources"] = [];
  for (let line = 0; line < lines; line += 1) {
    const sourceId = `src-l${line}`;
    nodes.push({ id: sourceId, name: `来料 L${line}`, kind: "source", interarrivalTime: { kind: "deterministic", value: 0.05 }, maxItems: 400 });
    let previous = sourceId;
    for (let index = 0; index < stationsPerLine; index += 1) {
      const stationId = `l${line}-st${index}`;
      nodes.push({ id: stationId, name: `工位 L${line}#${index}`, kind: "station", processingTime: { kind: "deterministic", value: 0.01 }, resourceId: `${stationId}-mc` });
      resources.push({ id: `${stationId}-mc`, name: `设备 ${stationId}`, kind: "equipment", capacity: 1 });
      edges.push({ id: `${previous}->${stationId}`, from: previous, to: stationId });
      previous = stationId;
    }
    const sinkId = `snk-l${line}`;
    nodes.push({ id: sinkId, name: `出货 L${line}`, kind: "sink" });
    edges.push({ id: `${previous}->${sinkId}`, from: previous, to: sinkId });
  }
  return {
    id: `bench-tier-${lines}x${stationsPerLine}`,
    name: `档位 · ${lines} 线 × ${stationsPerLine} 工位`,
    nodes, edges, resources,
  };
}

const SCENARIOS: BenchScenario[] = [
  { name: "golden01-single-line", model: golden01SingleLine(), replications: 10, limits: { durationMinutes: 480, warmupMinutes: 60 } },
  { name: "golden04-changeover", model: golden04Changeover(), replications: 10, limits: { durationMinutes: 480, warmupMinutes: 60 } },
  { name: "golden05-multi-agv", model: golden05MultiAgv(), replications: 10, limits: { durationMinutes: 120 } },
  { name: "large-20-stations", model: buildLargeLine(20), replications: 5, limits: { durationMinutes: 480, maxEvents: 100_000 } },
  { name: "large-60-stations", model: buildLargeLine(60), replications: 5, limits: { durationMinutes: 480, maxEvents: 100_000 } },
  // 规模档位(对象数口径=节点数,对齐西门子 Essentials/Standard/超档):
  // maxResources 覆盖默认上限 100:资源单元总数=lines×stationsPerLine。
  { name: "tier-500-objects", model: buildTierModel(5, 99), replications: 3, limits: { durationMinutes: 480, maxEvents: 200_000, maxResources: 500 } },
  { name: "tier-4000-objects", model: buildTierModel(40, 99), replications: 2, limits: { durationMinutes: 480, maxEvents: 400_000, maxResources: 4_000 } },
  { name: "tier-10000-objects", model: buildTierModel(100, 99), replications: 2, limits: { durationMinutes: 480, maxEvents: 400_000, maxResources: 10_000 } },
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
