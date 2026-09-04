import type { OperationsTab } from "../components/operationsPresentation";

export type SceneSimulationPanelId = "logistics" | "workcell" | "commissioning" | "whatif";

export interface SceneSimulationPanelDefinition {
  id: SceneSimulationPanelId;
  operationsTab: OperationsTab;
  label: string;
  englishLabel: string;
  eyebrow: string;
  description: string;
  englishDescription: string;
  commissioningStage?: "screening" | "control";
}

/**
 * 仿真能力只在这里注册。编辑器壳层负责承载，运营中心仍是算法与 Study 的唯一实现。
 */
export const SCENE_SIMULATION_PANELS: readonly SceneSimulationPanelDefinition[] = [
  {
    id: "logistics",
    operationsTab: "logistics",
    label: "物流仿真",
    englishLabel: "Logistics simulation",
    eyebrow: "FLOW",
    description: "离散事件、产线节拍、队列与 Plant Lite 扫描",
    englishDescription: "Discrete events, takt time, queues, and Plant Lite sweeps",
  },
  {
    id: "workcell",
    operationsTab: "commissioning",
    label: "工位与机器人",
    englishLabel: "Workcell & robot",
    eyebrow: "CELL",
    description: "基于当前工位和机器人检查任务、轨迹与碰撞风险",
    englishDescription: "Inspect tasks, trajectories, and collision risks in the current workcell",
    commissioningStage: "screening",
  },
  {
    id: "commissioning",
    operationsTab: "commissioning",
    label: "虚拟调试",
    englishLabel: "Virtual commissioning",
    eyebrow: "PLC",
    description: "把当前对象带入信号映射、联锁、故障与复位验证",
    englishDescription: "Bind the current object to signals, interlocks, faults, and reset tests",
    commissioningStage: "control",
  },
  {
    id: "whatif",
    operationsTab: "whatif",
    label: "What-if 扫描",
    englishLabel: "What-if sweep",
    eyebrow: "STUDY",
    description: "复用已保存 Study，对参数空间做可复现方案扫描",
    englishDescription: "Run reproducible parameter sweeps backed by saved Studies",
  },
] as const;

export function sceneSimulationPanel(id: SceneSimulationPanelId): SceneSimulationPanelDefinition {
  return SCENE_SIMULATION_PANELS.find((panel) => panel.id === id) ?? SCENE_SIMULATION_PANELS[0]!;
}
