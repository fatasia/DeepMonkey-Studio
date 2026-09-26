/**
 * 黄金样例 16:遗传优化试点(golden-16)。
 * 规格:ps-pd-plant-full-replacement-upgrade-plan 5.4;锁定样例独立成文件,
 * 不占用 goldenModels.ts 的编号队列,避免与其他样例批次合并冲突。
 * 单线:source → 缓存 → 工位(设备资源) → sink;缓存容量与工位工时是 GA 的两个因子。
 */

import type { PlantLiteModel } from "../modelTypes.js";

export function golden16GeneticOptimization(): PlantLiteModel {
  return {
    id: "golden-16-genetic-optimization",
    name: "黄金样例 16 · 遗传优化",
    nodes: [
      { id: "src", name: "来料", kind: "source", interarrivalTime: { kind: "deterministic", value: 0.5 } },
      { id: "buf", name: "线前缓存", kind: "queue-buffer", capacity: 8 },
      { id: "st", name: "加工", kind: "station", processingTime: { kind: "deterministic", value: 1.0 }, resourceId: "mc" },
      { id: "snk", name: "出货", kind: "sink" },
    ],
    edges: [
      { id: "e1", from: "src", to: "buf" },
      { id: "e2", from: "buf", to: "st" },
      { id: "e3", from: "st", to: "snk" },
    ],
    resources: [{ id: "mc", name: "机床", kind: "equipment", capacity: 1 }],
  };
}
