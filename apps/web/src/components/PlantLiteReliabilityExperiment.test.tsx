import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type {
  PlantLiteConfidenceInterval,
  PlantLiteModel,
  PlantLiteStudyRecord,
  PlantLiteStudyRequest,
} from "@bim-studio/contracts";
import { createAgvLinePlantLiteModel } from "@bim-studio/plant-lite-simulation";
import { PlantLiteReliabilityExperiment } from "./PlantLiteReliabilityExperiment";
import { createPlantLiteReliabilityStrategySweep } from "./plantLiteReliabilityStrategy";

describe("PlantLiteReliabilityExperiment", () => {
  it("shows a compact, truthful strategy action for configured equipment and transport resources", () => {
    const baseline = study("baseline", 60, 50);
    const html = renderToStaticMarkup(<PlantLiteReliabilityExperiment
      study={baseline}
      results={[baseline]}
      busy={false}
      onRunSweep={() => undefined}
    />);

    expect(html).toContain("可靠性策略实验");
    expect(html).toContain("敏感性分析 · 非预测性维护");
    expect(html).toContain("AGV 车队 · AGV 转运");
    expect(html).toContain("装配设备 · 装配工位");
    expect(html).toContain("基线 MTBF 720 分 · MTTR 10 分");
    expect(html).toContain("提高 MTBF 25%（720 → 900 分）");
    expect(html).toContain("缩短 MTTR 25%（10 → 7.5 分）");
    expect(html).toContain("运行 2 个策略");
    expect(html).toContain("不把敏感性目标冒充维护预测");
  });

  it("renders downtime, flow, energy and recommendation evidence after the sweep", () => {
    const baseline = study("baseline", 60, 50, 2);
    const [mtbfRequest, mttrRequest] = createPlantLiteReliabilityStrategySweep(baseline, "assembly-equipment")!.requests;
    const mtbf = candidate("mtbf", mtbfRequest!, 66, 28, 1.7);
    const mttr = candidate("mttr", mttrRequest!, 62, 38, 1.85);
    const html = renderToStaticMarkup(<PlantLiteReliabilityExperiment
      study={mttr}
      results={[mttr, mtbf, baseline]}
      busy={false}
      onRunSweep={() => undefined}
    />);

    expect(html).toContain("可靠性策略比较");
    expect(html).toContain("故障产能损失按台·分钟统计");
    expect(html).toContain("28.0 台·分");
    expect(html).toContain("66.0 件/时");
    expect(html).toContain("1.700 kWh/件 · 1.445 元/件");
    expect(html).toContain("优先验证候选");
    expect(html).toContain("推荐依据");
    expect(html).toContain("均值筛选不等于 95% 区间显著改善");
  });

  it("disables the shared run action while another study is active", () => {
    const baseline = study("baseline", 60, 50);
    const html = renderToStaticMarkup(<PlantLiteReliabilityExperiment
      study={baseline}
      results={[baseline]}
      busy
      onRunSweep={() => undefined}
    />);
    expect(html).toContain("aria-busy=\"true\"");
    expect(html).toContain("disabled=\"\"");
    expect(html).toContain("运行中");
  });

  it("does not occupy result space when no bound resource has explicit reliability inputs", () => {
    const baseline = study("baseline", 60, 50);
    baseline.model = createAgvLinePlantLiteModel();
    delete baseline.model.resources?.[0]?.failure;
    expect(renderToStaticMarkup(<PlantLiteReliabilityExperiment
      study={baseline}
      results={[baseline]}
      busy={false}
      onRunSweep={() => undefined}
    />)).toBe("");
  });
});

function study(id: string, throughput: number, downtime: number, energyPerItem?: number): PlantLiteStudyRecord {
  const model = modelFixture();
  return record(id, model, throughput, downtime, energyPerItem);
}

function candidate(
  id: string,
  request: PlantLiteStudyRequest,
  throughput: number,
  downtime: number,
  energyPerItem: number,
): PlantLiteStudyRecord {
  if (!request.model || !request.comparison) throw new Error("candidate fixture missing evidence");
  return {
    ...record(id, request.model, throughput, downtime, energyPerItem),
    name: request.name,
    seed: request.seed!,
    replications: request.replications!,
    comparison: request.comparison,
    ...(request.acceptanceTargets ? { acceptanceTargets: request.acceptanceTargets } : {}),
  };
}

function record(
  id: string,
  model: PlantLiteModel,
  throughput: number,
  downtime: number,
  energyPerItem?: number,
): PlantLiteStudyRecord {
  return {
    id,
    projectId: "project",
    name: "维护基线",
    createdAt: "2026-09-03T00:00:00Z",
    templateId: "agv-line-v1",
    model,
    seed: "maintenance-common-random",
    replications: 12,
    inputFingerprint: `input-${id}`,
    outcome: {
      status: "completed",
      completedReplications: 12,
      throughputPerHour: interval(throughput, throughput - 1, throughput + 1),
      averageWip: interval(throughput === 66 ? 7 : throughput === 62 ? 8.5 : 10, 6, 11),
      averageLeadTimeMinutes: interval(throughput === 66 ? 5.5 : throughput === 62 ? 6.5 : 8, 5, 9),
      resourceUtilization95: { "assembly-equipment": interval(.7, .65, .75) },
      resourceFailedMinutes95: { "assembly-equipment": interval(downtime, downtime - 4, downtime + 4) },
      ...(energyPerItem === undefined ? {} : { energy: energyOutcome(energyPerItem) }),
      bottlenecks: [],
    },
    execution: {
      engineId: "plant-lite-des",
      engineVersion: "1.0.0",
      inputFingerprint: `input-${id}`,
      deterministic: true,
      limits: { durationMinutes: 960, warmupMinutes: 120, maxEvents: 100_000, maxResources: 100 },
      trace: { replication: 3, maxEvents: 1_200, maxItems: 80 },
    },
  };
}

function modelFixture(): PlantLiteModel {
  const model = createAgvLinePlantLiteModel();
  model.resources!.push({
    id: "assembly-equipment",
    name: "装配设备",
    kind: "equipment",
    capacity: 2,
    failure: { timeToFailure: { kind: "exponential", mean: 400 }, repairTime: { kind: "deterministic", value: 10 } },
    power: { activePowerKw: 18, idlePowerKw: 2.2, source: "nameplate" },
  });
  const station = model.nodes.find((node) => node.id === "station-a");
  if (!station || station.kind !== "station") throw new Error("fixture station missing");
  station.resourceId = "assembly-equipment";
  delete station.power;
  return model;
}

function energyOutcome(energyPerItem: number): NonNullable<PlantLiteStudyRecord["outcome"]["energy"]> {
  const cost = energyPerItem * .85;
  return {
    activeEnergyKwh: interval(100, 95, 105),
    idleEnergyKwh: interval(10, 9, 11),
    totalEnergyKwh: interval(110, 104, 116),
    energyPerCompletedItemKwh: interval(energyPerItem, energyPerItem - .05, energyPerItem + .05),
    electricityCost: interval(93.5, 90, 97),
    electricityCostPerCompletedItem: interval(cost, cost - .05, cost + .05),
    carbonEmissionKg: interval(63.8, 60, 67),
    carbonEmissionPerCompletedItemKg: interval(energyPerItem * .58, energyPerItem * .55, energyPerItem * .61),
    peakDemandKw: interval(20, 19, 21),
    consumerEnergyKwh: { "assembly-equipment": interval(80, 76, 84) },
  };
}

function interval(mean: number, lower95: number, upper95: number): PlantLiteConfidenceInterval {
  return { mean, lower95, upper95, sampleStandardDeviation: 1, samples: 12 };
}
