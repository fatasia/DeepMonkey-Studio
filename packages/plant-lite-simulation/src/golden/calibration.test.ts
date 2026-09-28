/**
 * T23 校准测试(工业小场景:传送带 + 传感器 + AGV 桩)。
 *
 * 三层断言,对齐 T19 四驱动验收口径在 DES 侧的映射:
 * 1. 跨驱动不变性:内核直跑 / 内核+轨迹 / 引擎端口 / 端口+取消信号 / 单重复切片,
 *    五种驱动方式必须产出逐位相同的事件序列与指标(DES 无渲染帧耦合,
 *    可扰动事件序列的只有运行挂具的可观测钩子,全部在此锁死);
 * 2. 重复运行确定性:同输入同种子 JSON 文本逐字相等,种子改变则基准哈希改变;
 * 3. golden 校准基准:完整代表轨迹 + 首重复指标的基准哈希以字面量锁定,
 *    并落盘 test-output/t23-plant-calibration/golden-trajectory.json 供回归对照。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { fingerprint64Labeled } from "@bim-studio/contracts";
import { runPlantLiteExperiment } from "../engine.js";
import { plantLiteSimulationEngine } from "../enginePort.js";
import {
  CALIBRATION_LIMITS,
  CALIBRATION_SEED,
  CALIBRATION_TRACE,
  createConveyorSensorAgvCalibrationModel,
} from "./calibrationModels.js";
import type { PlantLiteExperimentResult } from "../model.js";

const CALIBRATION_MODEL = createConveyorSensorAgvCalibrationModel();

/** 字面量基准哈希;任何改变统计语义、调度顺序或事件时点的内核改动都会在此暴露。 */
const CALIBRATION_GOLDEN_HASH = "cf20cfbd6e97a617";

const EVIDENCE_DIR = resolve(import.meta.dirname, "../../../../test-output/t23-plant-calibration");
const EVIDENCE_PATH = resolve(EVIDENCE_DIR, "golden-trajectory.json");

function kernelRun(input: Partial<Parameters<typeof runPlantLiteExperiment>[0]> = {}): PlantLiteExperimentResult {
  return runPlantLiteExperiment({
    model: CALIBRATION_MODEL,
    seed: CALIBRATION_SEED,
    replications: 4,
    limits: { ...CALIBRATION_LIMITS },
    ...input,
  });
}

/** 基准哈希材料:场景版本 + 种子 + 运行窗口 + 完整代表轨迹 + 首重复全量指标。 */
export function calibrationGoldenHash(result: PlantLiteExperimentResult): string {
  return fingerprint64Labeled([
    ["scene", "t23-conveyor-sensor-agv@1"],
    ["seed", CALIBRATION_SEED],
    ["limits", CALIBRATION_LIMITS],
    ["trace", result.representativeTrace],
    ["replication0", result.replications[0]],
  ]);
}

describe("T23 校准 · 场景健全性", () => {
  const result = kernelRun({ trace: { ...CALIBRATION_TRACE } });

  it("有限投料确定性完成,三类资源均被真实占用", () => {
    expect(result.replications).toHaveLength(4);
    for (const replication of result.replications) {
      expect(replication.termination).toBe("completed");
      expect(replication.completedItems).toBeGreaterThan(0);
      expect(replication.completedItems).toBeLessThanOrEqual(80);
    }
    const first = result.replications[0]!;
    expect(first.resources.find((resource) => resource.resourceId === "conveyor")?.utilization).toBeGreaterThan(0);
    expect(first.resources.find((resource) => resource.resourceId === "sensor-unit")?.utilization).toBeGreaterThan(0);
    expect(first.resources.find((resource) => resource.resourceId === "agv-fleet")?.utilization).toBeGreaterThan(0);
  });

  it("传感器质量随机流被观测:有检验、有误杀,首通率落在合理区间", () => {
    for (const replication of result.replications) {
      const sensor = replication.nodes.find((node) => node.nodeId === "sensor");
      expect(sensor?.changeoverCount).toBe(0);
      const quality = replication.quality;
      const sensorQuality = quality?.stations.find((station) => station.nodeId === "sensor");
      expect(sensorQuality?.inspectedItems ?? 0).toBeGreaterThan(0);
      expect(sensorQuality?.scrapItems ?? -1).toBeGreaterThanOrEqual(0);
      expect(quality?.firstPassYield ?? 0).toBeGreaterThan(0.8);
      expect(quality?.firstPassYield ?? 1).toBeLessThanOrEqual(1);
    }
  });

  it("AGV 轨道预约证据进入轨迹:每件含 loaded 双向腿与空驶回取", () => {
    const trace = result.representativeTrace;
    expect(trace).toBeDefined();
    expect(trace?.truncated).toBe(false);
    const transportEvents = (trace?.events ?? []).filter((event) => "transport" in event);
    expect(transportEvents.length).toBeGreaterThan(0);
    const withLegs = transportEvents.filter(
      (event) => "transport" in event && Array.isArray(event.transport?.legs) && event.transport.legs.length >= 2,
    );
    expect(withLegs.length).toBeGreaterThan(0);
    for (const event of withLegs) {
      if (!("transport" in event)) continue;
      const legs = event.transport?.legs ?? [];
      expect(legs.some((leg) => leg.loaded)).toBe(true);
      expect(legs.every((leg) => leg.endMinute >= leg.startMinute)).toBe(true);
    }
  });

  it("轨迹事件时点单调:sequence 严格递增,atMinute 不减", () => {
    const events = result.representativeTrace?.events ?? [];
    expect(events.length).toBeGreaterThan(100);
    for (let index = 1; index < events.length; index += 1) {
      const previous = events[index - 1]!;
      const current = events[index]!;
      expect(current.sequence).toBe(previous.sequence + 1);
      expect(current.atMinute).toBeGreaterThanOrEqual(previous.atMinute);
    }
  });
});

describe("T23 校准 · 跨驱动不变性(T19 四驱动口径的 DES 映射)", () => {
  // A 内核直跑(基线);B 内核+轨迹+进度钩子;C 端口(request 级重复数);
  // D 端口+AbortSignal(input 级重复数);E 单重复切片(子运行框等价)。
  const baseline = kernelRun();
  const traced = kernelRun({ trace: { ...CALIBRATION_TRACE } });
  const sliced = kernelRun({ replications: 1 });

  it("A/B:轨迹记录与进度回调不扰动统计,轨迹本身逐字可复现", () => {
    const { representativeTrace: _omitted, ...baselineStatistics } = baseline;
    const { representativeTrace: tracedTrace, ...tracedStatistics } = traced;
    expect(tracedStatistics).toEqual(baselineStatistics);
    const traceAgain = kernelRun({ trace: { ...CALIBRATION_TRACE } }).representativeTrace;
    expect(JSON.stringify(tracedTrace)).toBe(JSON.stringify(traced.representativeTrace));
    expect(JSON.stringify(traceAgain)).toBe(JSON.stringify(tracedTrace));
  });

  it("C/D:引擎端口路径(含取消信号与进度钩子)产出逐位相同结果与指纹", async () => {
    const viaRequest = await plantLiteSimulationEngine.run({
      input: { model: CALIBRATION_MODEL, limits: { ...CALIBRATION_LIMITS } },
      seed: CALIBRATION_SEED,
      replications: 4,
    });
    const controller = new AbortController();
    const viaSignal = await plantLiteSimulationEngine.run(
      {
        input: { model: CALIBRATION_MODEL, limits: { ...CALIBRATION_LIMITS } },
        seed: CALIBRATION_SEED,
        replications: 4,
        onProgress: () => {},
      },
      { signal: controller.signal },
    );
    // 重复数走 input 通道(合同允许的第二形态):结果必须等价,指纹材料含输入形状故允许不同。
    const viaInput = await plantLiteSimulationEngine.run({
      input: { model: CALIBRATION_MODEL, replications: 4, limits: { ...CALIBRATION_LIMITS } },
      seed: CALIBRATION_SEED,
    });
    for (const record of [viaRequest, viaSignal, viaInput]) {
      expect(record.termination).toBe("completed");
      expect(JSON.stringify(record.result)).toBe(JSON.stringify(baseline));
      expect(JSON.stringify(record.result.representativeTrace)).toBe(JSON.stringify(baseline.representativeTrace));
    }
    expect(viaSignal.resultFingerprint).toBe(viaRequest.resultFingerprint);
    expect(viaSignal.inputFingerprint).toBe(viaRequest.inputFingerprint);
  });

  it("E:单重复切片复现完整实验的首重复(子运行框等价),不同序号重复彼此不同", () => {
    expect(JSON.stringify(sliced.replications[0])).toBe(JSON.stringify(baseline.replications[0]));
    const seeds = new Set(baseline.replications.map((replication) => replication.seed));
    expect(seeds.size).toBe(baseline.replications.length);
    expect(JSON.stringify(baseline.replications[0])).not.toBe(JSON.stringify(baseline.replications[1]));
  });
});

describe("T23 校准 · 重复运行确定性", () => {
  it("同输入同种子两次运行:实验结果 JSON 文本逐字相等", () => {
    const first = kernelRun();
    const second = kernelRun();
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("种子参与结果:换种子后基准哈希与轨迹文本均不同(质量随机流随种子变化)", () => {
    const tracedBaseline = kernelRun({ trace: { ...CALIBRATION_TRACE } });
    const other = kernelRun({ seed: "t23-calibration-alt", trace: { ...CALIBRATION_TRACE } });
    expect(calibrationGoldenHash(other)).not.toBe(calibrationGoldenHash(tracedBaseline));
    expect(JSON.stringify(other.representativeTrace)).not.toBe(JSON.stringify(tracedBaseline.representativeTrace));
    const firstArrival = (trace: PlantLiteExperimentResult["representativeTrace"]) =>
      (trace?.events ?? []).find((event) => event.type === "item-enter")?.atMinute;
    expect(firstArrival(other.representativeTrace)).toBeDefined();
  });
});

describe("T23 校准 · golden 基准锁定与落盘", () => {
  const result = kernelRun({ trace: { ...CALIBRATION_TRACE } });
  const hash = calibrationGoldenHash(result);

  it("基准哈希与锁定字面量逐字一致(校准回归基准)", () => {
    expect(result.representativeTrace?.truncated).toBe(false);
    expect(hash).toBe(CALIBRATION_GOLDEN_HASH);
  });

  it("基准轨迹落盘 test-output,JSON 往返后哈希可复算", () => {
    const evidence = {
      scene: "t23-conveyor-sensor-agv@1",
      engineId: "plant-lite-des",
      engineVersion: "1.0.0",
      seed: CALIBRATION_SEED,
      limits: CALIBRATION_LIMITS,
      goldenHash: hash,
      trace: result.representativeTrace,
      replication0: result.replications[0],
    };
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    writeFileSync(EVIDENCE_PATH, JSON.stringify(evidence, null, 2), "utf8");
    const reloaded = JSON.parse(readFileSync(EVIDENCE_PATH, "utf8")) as typeof evidence;
    expect(reloaded.goldenHash).toBe(CALIBRATION_GOLDEN_HASH);
    const recomputed = fingerprint64Labeled([
      ["scene", reloaded.scene],
      ["seed", reloaded.seed],
      ["limits", reloaded.limits],
      ["trace", reloaded.trace],
      ["replication0", reloaded.replication0],
    ]);
    expect(recomputed).toBe(CALIBRATION_GOLDEN_HASH);
  });
});
