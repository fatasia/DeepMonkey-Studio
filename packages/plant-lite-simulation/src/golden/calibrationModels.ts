/**
 * T23 工业仿真校准基准(传送带 + 传感器 + AGV 桩)。
 *
 * 与 goldenModels.ts 的分工:golden-XX 各自固化一类机制;本场景把输送、
 * 质量检测(yieldRate 质量随机流)、AGV 轨道预约(冲突区 + 空驶回取)三类
 * 机制放进同一条事件链,作为跨包时间协议校准与确定性回归的**唯一校准基准**。
 * 本文件只定义场景与基准常量,不含统计语义;断言在 calibration.test.ts。
 */

import type { PlantLiteModel } from "../modelTypes.js";

/** 校准基准统一种子;同输入同种子必须逐位复现。 */
export const CALIBRATION_SEED = "t23-calibration-2026-09-27";

/** 校准基准运行窗口:预热 30 分钟,总时长 240 分钟,事件上限宽裕以避免限流终态。 */
export const CALIBRATION_LIMITS = { durationMinutes: 240, warmupMinutes: 30, maxEvents: 200_000, maxResources: 16 } as const;

/** 轨迹捕获上限:80 件投料上限下全量捕获、不截断,轨迹即完整事件序列。 */
export const CALIBRATION_TRACE = { replication: 0, maxEvents: 10_000, maxItems: 100 } as const;

/** 投放上限:有限运行,保证终止态为 completed 而非依赖时长截断。 */
const FEED_ITEMS = 80;

/**
 * 传送带 → 传感器检测 → AGV 桩转运 → 出货。
 * - 入线传送带:transport 资源容量 2,固定 0.5 分钟节拍(与来料 1.0 分钟形成半频事件对齐);
 * - 在线传感器:equipment 工位,yieldRate 0.95 启用质量随机流(独立种子流,可观测 scrap);
 * - AGV 桩:agv 车队容量 2 + journey 空驶/装卸,轨道含共享冲突区(aisle-a/aisle-b),
 *   强制走 TransportNetworkScheduler 的冲突前推路径,时间协议密度最高。
 */
export function createConveyorSensorAgvCalibrationModel(): PlantLiteModel {
  return {
    id: "t23-conveyor-sensor-agv",
    name: "T23 校准基准 · 传送带 + 传感器 + AGV 桩",
    nodes: [
      { id: "load", name: "上料口", kind: "source", interarrivalTime: { kind: "deterministic", value: 1 }, maxItems: FEED_ITEMS },
      { id: "belt-in", name: "入线传送带", kind: "transport", resourceId: "conveyor", travelTime: { kind: "deterministic", value: 0.5 } },
      {
        id: "sensor",
        name: "在线检测传感器",
        kind: "station",
        resourceId: "sensor-unit",
        processingTime: { kind: "deterministic", value: 0.4 },
        yieldRate: 0.95,
        queueCapacity: 4,
      },
      {
        id: "agv-stand",
        name: "AGV 桩转运",
        kind: "transport",
        resourceId: "agv-fleet",
        travelTime: { kind: "deterministic", value: 2 },
        journey: { from: "sensor-bay", to: "out-bay", speedMetersPerMinute: 30, loadMinutes: 0.2, unloadMinutes: 0.2 },
      },
      { id: "snk", name: "出货口", kind: "sink" },
    ],
    edges: [
      { id: "e1", from: "load", to: "belt-in" },
      { id: "e2", from: "belt-in", to: "sensor" },
      { id: "e3", from: "sensor", to: "agv-stand" },
      { id: "e4", from: "agv-stand", to: "snk" },
    ],
    resources: [
      { id: "conveyor", name: "传送带", kind: "transport", capacity: 2 },
      { id: "sensor-unit", name: "传感器单元", kind: "equipment", capacity: 1 },
      { id: "agv-fleet", name: "AGV 车队", kind: "agv", capacity: 2 },
    ],
    transportNetwork: {
      waypoints: [
        { id: "sensor-bay", name: "传感器接驳桩", position: [0, 0, 0] },
        { id: "junction", name: "干线路口", position: [6, 0, 0] },
        { id: "out-bay", name: "出货接驳桩", position: [12, 0, 4] },
      ],
      segments: [
        { id: "seg-a", from: "sensor-bay", to: "junction", lengthMeters: 6, conflictZone: "aisle-a" },
        { id: "seg-b", from: "junction", to: "out-bay", lengthMeters: 7.2, conflictZone: "aisle-b" },
        { id: "seg-back-b", from: "out-bay", to: "junction", lengthMeters: 7.2, conflictZone: "aisle-b" },
        { id: "seg-back-a", from: "junction", to: "sensor-bay", lengthMeters: 6, conflictZone: "aisle-a" },
      ],
      fleets: [{ resourceId: "agv-fleet", homeWaypointId: "sensor-bay" }],
    },
  };
}
