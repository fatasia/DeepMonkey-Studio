/**
 * 黄金样例模型(golden-01..06 + golden-11..12)。
 * 规格:ps-pd-plant-full-replacement-upgrade-plan-2026-09-25.md 第 5.1/7 节。
 * 每个样例只固化一类机制,断言在 goldenPlant.test.ts;禁止在此添加统计语义。
 */

import type { PlantLiteModel } from "../modelTypes.js";
import { createAgvNetworkPlantLiteModel } from "../transportNetworkTemplate.js";

const LIMITS = { durationMinutes: 480, warmupMinutes: 60 } as const;

/** golden-01 单线:source → 缓存 → 工位(设备资源) → sink。 */
export function golden01SingleLine(): PlantLiteModel {
  return {
    id: "golden-01-single-line",
    name: "黄金样例 01 · 单线",
    nodes: [
      { id: "src", name: "来料", kind: "source", interarrivalTime: { kind: "deterministic", value: 1 } },
      { id: "buf", name: "线边缓存", kind: "queue-buffer", capacity: 20 },
      { id: "st", name: "加工", kind: "station", processingTime: { kind: "deterministic", value: 0.8 }, resourceId: "mc" },
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

/** golden-02 多品种:两类产品按 0.4/0.6 投放,无换型矩阵(未列切换为 0 分钟)。 */
export function golden02MultiProduct(): PlantLiteModel {
  return {
    ...golden01SingleLine(),
    id: "golden-02-multi-product",
    name: "黄金样例 02 · 多品种",
    productTypes: [
      { id: "pa", name: "产品 A", share: 0.4 },
      { id: "pb", name: "产品 B", share: 0.6 },
    ],
  };
}

/** golden-03 故障:设备故障间隔指数(均值 60 分钟),修复 5 分钟。
 * 来料提速到 0.5 分钟,让工位(而非来料)成为故障可观测的瓶颈环节。 */
export function golden03Failure(): PlantLiteModel {
  return {
    ...golden01SingleLine(),
    id: "golden-03-failure",
    name: "黄金样例 03 · 故障维修",
    nodes: golden01SingleLine().nodes.map((node) => node.kind === "source"
      ? { ...node, interarrivalTime: { kind: "deterministic", value: 0.5 } }
      : node),
    resources: [{
      id: "mc",
      name: "机床",
      kind: "equipment",
      capacity: 1,
      failure: {
        timeToFailure: { kind: "exponential", mean: 60 },
        repairTime: { kind: "deterministic", value: 5 },
      },
    }],
  };
}

/** golden-04 换型:多品种 + 有向换型矩阵,断言换型次数与占用分钟被观测。 */
export function golden04Changeover(): PlantLiteModel {
  return {
    ...golden02MultiProduct(),
    id: "golden-04-changeover",
    name: "黄金样例 04 · 换型",
    nodes: golden02MultiProduct().nodes.map((node) => node.kind === "station"
      ? {
        ...node,
        changeovers: [
          { fromProductTypeId: "pa", toProductTypeId: "pb", minutes: 5 },
          { fromProductTypeId: "pb", toProductTypeId: "pa", minutes: 4 },
        ],
      }
      : node),
  };
}

/** golden-05 多 AGV:车队 3 台 + 物理轨道(共享路口 conflictZone)+ journey 空驶/装卸。 */
export function golden05MultiAgv(): PlantLiteModel {
  const model = createAgvNetworkPlantLiteModel();
  return { ...model, id: "golden-05-multi-agv", name: "黄金样例 05 · 多 AGV 轨道调度" };
}

/**
 * golden-06 封路阻塞:在 golden-05 的 out-a 路段加封闭窗口(0..240 分钟不可通行),
 * 固化"轨道受阻可建模、可运行、可观测"。死锁检测与恢复算法属 R1,本样例不冒充。
 */
export function golden06BlockedRoute(): PlantLiteModel {
  const model = golden05MultiAgv();
  return {
    ...model,
    id: "golden-06-blocked-route",
    name: "黄金样例 06 · 封路阻塞",
    ...(model.transportNetwork
      ? {
        transportNetwork: {
          ...model.transportNetwork,
          segments: model.transportNetwork.segments.map((segment) => segment.id === "out-a"
            ? { ...segment, blockedUntilMinute: 240 }
            : segment),
        },
      }
      : {}),
  };
}

/**
 * golden-07 R0 遗留空位保留说明：07..09 已被 R0 期间的合并裁掉，编号不回收。
 * golden-11 Split 分流：60/40 份额轮转（无随机），两条下游线产能均足够消化各自份额。
 * 线 A 节拍 1.2、线 B 节拍 1.8；来料 0.8 保证两侧都不构成瓶颈，份额路由可被单独观测。
 */
export function golden11SplitShares(): PlantLiteModel {
  return {
    id: "golden-11-split-shares",
    name: "黄金样例 11 · Split 份额分流",
    nodes: [
      { id: "src", name: "来料", kind: "source", interarrivalTime: { kind: "deterministic", value: 0.8 } },
      {
        id: "div",
        name: "分流",
        kind: "split",
        routes: [
          { to: "st-a", share: 0.6 },
          { to: "st-b", share: 0.4 },
        ],
      },
      { id: "st-a", name: "加工 A", kind: "station", processingTime: { kind: "deterministic", value: 1.2 }, resourceId: "mc-a" },
      { id: "st-b", name: "加工 B", kind: "station", processingTime: { kind: "deterministic", value: 1.8 }, resourceId: "mc-b" },
      { id: "snk-a", name: "出货 A", kind: "sink" },
      { id: "snk-b", name: "出货 B", kind: "sink" },
    ],
    edges: [
      { id: "e1", from: "src", to: "div" },
      { id: "e2", from: "st-a", to: "snk-a" },
      { id: "e3", from: "st-b", to: "snk-b" },
    ],
    resources: [
      { id: "mc-a", name: "机床 A", kind: "equipment", capacity: 1 },
      { id: "mc-b", name: "机床 B", kind: "equipment", capacity: 1 },
    ],
  };
}

/**
 * golden-12 看板拉动：2 卡 × 每卡 5 件 = 最大在库 10。
 * 来料 0.4 快于工位 1.0，取走节拍由工位决定；断言源投放被卡数门控、在库水位低于上限。
 */
export function golden12KanbanPull(): PlantLiteModel {
  return {
    id: "golden-12-kanban-pull",
    name: "黄金样例 12 · Kanban 拉动",
    nodes: [
      { id: "src", name: "来料", kind: "source", interarrivalTime: { kind: "deterministic", value: 0.4 } },
      { id: "kb", name: "看板超市", kind: "queue-buffer", capacity: 10, kanban: { cardCount: 2, cardQuantity: 5 } },
      // 工位等待队列压到 1,使"离开超市"逐件发生,看板取走节拍与工位节拍一致。
      { id: "st", name: "加工", kind: "station", processingTime: { kind: "deterministic", value: 1 }, queueCapacity: 1, resourceId: "mc" },
      { id: "snk", name: "出货", kind: "sink" },
    ],
    edges: [
      { id: "e1", from: "src", to: "kb" },
      { id: "e2", from: "kb", to: "st" },
      { id: "e3", from: "st", to: "snk" },
    ],
    resources: [{ id: "mc", name: "机床", kind: "equipment", capacity: 1 }],
  };
}

export const GOLDEN_LIMITS = LIMITS;
