import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PlantLiteStudyRecord } from "@bim-studio/contracts";
import { PlantLiteStudyPanel } from "./PlantLiteStudyPanel";
import { createAgvLinePlantLiteModel } from "@bim-studio/plant-lite-simulation";

function record(overrides: Partial<PlantLiteStudyRecord> = {}): PlantLiteStudyRecord {
  const ci = { mean: 60, sampleStandardDeviation: 2, lower95: 58, upper95: 62, samples: 12 };
  const interval = (mean: number, lower95: number, upper95: number) => ({ ...ci, mean, lower95, upper95 });
  const energy = {
    activeEnergyKwh: interval(80, 78, 82), idleEnergyKwh: interval(20, 19, 21), totalEnergyKwh: interval(100, 97, 103),
    energyPerCompletedItemKwh: interval(1.5, 1.4, 1.6), electricityCost: interval(85, 82, 88),
    electricityCostPerCompletedItem: interval(1.275, 1.2, 1.35), carbonEmissionKg: interval(58, 56, 60),
    carbonEmissionPerCompletedItemKg: interval(.87, .82, .92), peakDemandKw: interval(28, 27, 29),
    consumerEnergyKwh: { "station-a": interval(72, 70, 74), "agv-fleet": interval(28, 27, 29) },
  };
  const model = createAgvLinePlantLiteModel();
  return {
    id: "study-1", projectId: "project-1", name: "AGV 基线", createdAt: "2026-08-31T08:00:00.000Z",
    templateId: "agv-line-v1", agvCount: 4, bufferCapacity: 10, seed: "fixed", replications: 12, inputFingerprint: "input-1",
    model, modelFingerprint: "model-1",
    outcome: { status: "completed", completedReplications: 12, throughputPerHour: ci, averageWip: interval(3, 2.8, 3.2), averageLeadTimeMinutes: interval(5, 4.5, 5.5), nodeMetrics95: { "station-a": { utilization: interval(.92, .9, .94), averageQueueLength: interval(4.2, 4, 4.4), blockedMinutes: interval(0, 0, 0), starvedMinutes: interval(1, .8, 1.2) } }, resourceUtilization95: { "agv-fleet": interval(.7, .68, .72) }, energy, bottlenecks: [{ nodeId: "station-a", occurrences: 12, probability: 1 }] },
    execution: { engineId: "plant-lite-des", engineVersion: "1.0.0", inputFingerprint: "input-1", deterministic: true, limits: { durationMinutes: 480, maxEvents: 100000, maxResources: 12 } },
    ...overrides,
  };
}

describe("PlantLiteStudyPanel", () => {
  it("keeps the template first-run state focused", () => {
    const html = renderToStaticMarkup(<PlantLiteStudyPanel results={[]} busy={false} onReproduce={() => undefined} />);
    expect(html).toContain("起步产线已经就绪");
    expect(html).not.toContain("对比基线");
  });

  it("shows the measured window instead of hiding warm-up inside the run duration", () => {
    const html = renderToStaticMarkup(<PlantLiteStudyPanel results={[record({
      execution: {
        engineId: "plant-lite-des", engineVersion: "1.0.0", inputFingerprint: "input-1", deterministic: true,
        limits: { durationMinutes: 480, warmupMinutes: 60, maxEvents: 100000, maxResources: 12 },
      },
    })]} busy={false} onReproduce={() => undefined} />);
    expect(html).toContain("预热 60 分钟");
    expect(html).toContain("正式统计 420 分钟");
  });

  it("shows confidence intervals and exact reproduction evidence", () => {
    const baseline = record();
    const html = renderToStaticMarkup(<PlantLiteStudyPanel results={[record({ id: "study-2", reproductionOf: baseline.id }), baseline]} busy={false} onReproduce={() => undefined} />);
    expect(html).toContain("95% CI");
    expect(html).toContain("复现校验通过");
    expect(html).toContain("精确复现基线");
    expect(html).toContain("装配工位");
    expect(html).toContain("92% 计划利用率");
    expect(html).toContain("能耗与经济证据");
    expect(html).toContain("1.500 kWh/件");
    expect(html).toContain("¥1.275/件");
    expect(html).toContain("0.870 kgCO₂e/件");
  });

  it("renders project targets as interval-based acceptance evidence", () => {
    const html = renderToStaticMarkup(<PlantLiteStudyPanel results={[record({
      acceptanceTargets: {
        basis: "规划产能要求",
        minimumThroughputPerHour: 60,
        maximumAverageLeadTimeMinutes: 4,
        maximumEnergyPerCompletedItemKwh: 1.6,
      },
    })]} busy={false} onReproduce={() => undefined} />);
    expect(html).toContain("方案验收");
    expect(html).toContain("规划产能要求");
    expect(html).toContain("稳定达标");
    expect(html).toContain("区间有风险");
    expect(html).toContain("95% CI");
  });

  it("does not overstate exact reproduction when a non-throughput metric differs", () => {
    const baseline = record();
    const changedWip = { ...baseline.outcome.averageWip, mean: 3.5 };
    const candidate = record({
      id: "study-2",
      reproductionOf: baseline.id,
      outcome: { ...baseline.outcome, averageWip: changedWip },
    });

    const html = renderToStaticMarkup(
      <PlantLiteStudyPanel results={[candidate, baseline]} busy={false} onReproduce={() => undefined} />,
    );
    expect(html).not.toContain("复现校验通过");
    expect(html).toContain("吞吐均值对比");
  });

  it("hides a numerical delta when the selected baseline used different run conditions", () => {
    const baseline = record();
    const candidate = record({
      id: "study-2",
      execution: { ...baseline.execution, limits: { ...baseline.execution.limits, durationMinutes: 960 } },
    });
    const html = renderToStaticMarkup(<PlantLiteStudyPanel results={[candidate, baseline]} busy={false} onReproduce={() => undefined} />);

    expect(html).toContain("运行时长、预热期或资源上限不同，数值结论已隐藏");
    expect(html).not.toContain("吞吐均值对比");
  });

  it("does not mark changed equipment downtime evidence as an exact reproduction", () => {
    const baseline = record();
    const downtime = { mean: 12, sampleStandardDeviation: 1, lower95: 10, upper95: 14, samples: 12 };
    baseline.outcome.resourceFailedMinutes95 = { "assembly-equipment": downtime };
    const candidate = record({
      id: "study-2",
      reproductionOf: baseline.id,
      outcome: { ...baseline.outcome, resourceFailedMinutes95: { "assembly-equipment": { ...downtime, mean: 13 } } },
    });
    const html = renderToStaticMarkup(<PlantLiteStudyPanel results={[candidate, baseline]} busy={false} onReproduce={() => undefined} />);
    expect(html).not.toContain("复现校验通过");
  });

  it("does not mark changed energy economics evidence as an exact reproduction", () => {
    const baseline = record();
    const candidate = record({
      id: "study-2",
      reproductionOf: baseline.id,
      outcome: {
        ...baseline.outcome,
        energy: {
          ...baseline.outcome.energy!,
          electricityCostPerCompletedItem: { ...baseline.outcome.energy!.electricityCostPerCompletedItem, mean: 1.4 },
        },
      },
    });
    const html = renderToStaticMarkup(<PlantLiteStudyPanel results={[candidate, baseline]} busy={false} onReproduce={() => undefined} />);
    expect(html).not.toContain("复现校验通过");
  });

  it("does not mark a changed saved model snapshot as an exact reproduction", () => {
    const baseline = record();
    const changedModel = structuredClone(baseline.model!);
    changedModel.nodes[1] = { ...changedModel.nodes[1]!, name: "被改动的工位" };
    const candidate = record({ id: "study-2", reproductionOf: baseline.id, model: changedModel });

    const html = renderToStaticMarkup(
      <PlantLiteStudyPanel results={[candidate, baseline]} busy={false} onReproduce={() => undefined} />,
    );
    expect(html).not.toContain("复现校验通过");
  });

  it("does not mark changed acceptance criteria as an exact reproduction", () => {
    const baseline = record({ acceptanceTargets: { minimumThroughputPerHour: 60 } });
    const candidate = record({
      id: "study-2",
      reproductionOf: baseline.id,
      acceptanceTargets: { minimumThroughputPerHour: 70 },
    });
    const html = renderToStaticMarkup(<PlantLiteStudyPanel results={[candidate, baseline]} busy={false} onReproduce={() => undefined} />);
    expect(html).not.toContain("复现校验通过");
  });

  it("turns a buffer bottleneck into a relevant capacity-balancing action", () => {
    const baseline = record();
    const html = renderToStaticMarkup(
      <PlantLiteStudyPanel
        results={[record({ outcome: { ...baseline.outcome, bottlenecks: [{ nodeId: "queue-buffer", occurrences: 9, probability: 0.75 }] } })]}
        busy={false}
        onReproduce={() => undefined}
        onRunSweep={() => undefined}
      />,
    );
    expect(html).toContain("工序间缓冲");
    expect(html).toContain("扩大缓冲容量或平衡上下游节拍");
    expect(html).toContain("缓冲区策略实验");
    expect(html).toContain("减至 5");
    expect(html).not.toContain("瓶颈方案实验");
  });

  it("offers a one-variable DES experiment from evidenced bottlenecks", () => {
    const html = renderToStaticMarkup(<PlantLiteStudyPanel
      results={[record()]}
      busy={false}
      onReproduce={() => undefined}
      onRunSweep={() => undefined}
    />);
    expect(html).toContain("瓶颈方案实验");
    expect(html).toContain("固定 seed 与重复次数");
    expect(html).toContain("运行 2 个方案");
    expect(html).toContain('<details class="plant-improvement-lab">');
    expect(html.indexOf('class="logistics-metric-table"')).toBeLessThan(html.indexOf('class="plant-improvement-lab"'));
  });

  it("renders a truthful logistics playback when the study contains a trace", () => {
    const baseline = record();
    const html = renderToStaticMarkup(<PlantLiteStudyPanel
      results={[record({
        trace: {
          engineId: "plant-lite-des", engineVersion: "1.0.0", replication: 0, seed: 9,
          capturedItemCount: 1, omittedEventCount: 3, truncated: true, limits: { maxEvents: 20, maxItems: 1 },
          events: [
            { sequence: 0, atMinute: 0, type: "item-enter", itemId: "source:1", nodeId: "source" },
            { sequence: 1, atMinute: 1, type: "item-start", itemId: "source:1", nodeId: "station-a" },
            { sequence: 2, atMinute: 2, type: "item-complete", itemId: "source:1", nodeId: "station-a" },
          ],
        },
        execution: { ...baseline.execution, trace: { replication: 0, maxEvents: 20, maxItems: 1 } },
      })]}
      busy={false}
      onReproduce={() => undefined}
    />);
    expect(html).toContain("物流轨迹回放");
    expect(html).toContain("真实 DES 事件");
    expect(html).toContain("物料流分析");
    expect(html).toContain("资源甘特");
    expect(html).toContain("已采集转移");
    expect(html).toContain("另有 3 个事件未记录");
    expect(html).not.toContain("旧记录没有事件轨迹");
    expect(html.indexOf('class="plant-bottleneck-advice"')).toBeLessThan(html.indexOf('class="plant-playback"'));
    expect(html.indexOf('class="plant-playback"')).toBeLessThan(html.indexOf('class="logistics-evidence verified"'));
  });

  it("renders a persisted same-condition decision matrix after a bottleneck sweep", () => {
    const baseline = record({ id: "study-base" });
    const first = record({
      id: "study-candidate-1",
      comparison: { groupId: "sweep:1", baselineStudyId: baseline.id, parameterLabel: "并行工位数", candidateLabel: "2 个并行工位" },
      outcome: { ...baseline.outcome, throughputPerHour: { ...baseline.outcome.throughputPerHour, mean: 66, lower95: 64, upper95: 68 } },
    });
    const second = record({
      id: "study-candidate-2",
      comparison: { groupId: "sweep:1", baselineStudyId: baseline.id, parameterLabel: "并行工位数", candidateLabel: "3 个并行工位" },
      outcome: { ...baseline.outcome, throughputPerHour: { ...baseline.outcome.throughputPerHour, mean: 72, lower95: 70, upper95: 74 } },
    });
    const html = renderToStaticMarkup(<PlantLiteStudyPanel results={[second, first, baseline]} busy={false} onReproduce={() => undefined} />);
    expect(html).toContain("方案决策矩阵");
    expect(html).toContain("共同随机条件");
    expect(html).toContain("3 个并行工位");
    expect(html).toContain("最高吞吐");
    expect(html).toContain("非支配前沿");
    expect(html).toContain("单位成本");
    expect(html).toContain("区间改善");
  });
});
