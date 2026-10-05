import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { AppStudioController } from "../AppStudioShell";
import { DEFAULT_PHYSICS_DEBUG_LAYERS, type PhysicsDebugFilter, type PhysicsDebugLayers } from "../../viewer/physicsDebugSnapshot";

/**
 * AppStudioViewport 物理调试域状态(source-size 拆分,2026-10-04:自
 * AppStudioViewport.tsx 按职责抽出自定义 hook,代码逐行同源;语义零变化)。
 *
 * 职责:B3 缺口 5 / T0 刀 3 的碰撞体调试线框开关、调试图层筛选与三路分层状态、
 * T28 物理调试面板开态;全部经 effect 应用到(可能重建的)引擎。
 */
export interface AppStudioPhysicsDebugState {
  readonly physicsDebugVisible: boolean;
  readonly setPhysicsDebugVisible: Dispatch<SetStateAction<boolean>>;
  readonly physicsDebugFilter: PhysicsDebugFilter;
  readonly setPhysicsDebugFilter: Dispatch<SetStateAction<PhysicsDebugFilter>>;
  readonly physicsDebugLayers: PhysicsDebugLayers;
  readonly setPhysicsDebugLayers: Dispatch<SetStateAction<PhysicsDebugLayers>>;
  readonly physicsDebugPanelOpen: boolean;
  readonly setPhysicsDebugPanelOpen: Dispatch<SetStateAction<boolean>>;
}

export function useAppStudioPhysicsDebugState(
  engine: AppStudioController["engine"],
  selectedId: string | undefined,
): AppStudioPhysicsDebugState {
  // B3 缺口 5:碰撞体调试线框开关——React 状态触发重渲染,引擎是事实来源;
  // 引擎重建(渲染后端切换)后经 effect 把当前开关重新应用到新引擎,避免状态漂移。
  const [physicsDebugVisible, setPhysicsDebugVisible] = useState(false);
  useEffect(() => {
    engine?.setPhysicsDebugVisible(physicsDebugVisible);
  }, [engine, physicsDebugVisible]);
  // T0 刀 3:调试图层筛选/分层状态,与开关同模式经 effect 应用到(可能重建的)引擎。
  // 筛选=选中时携带当前选中 id,选中变化即自动跟随(effect 依赖项)。
  const [physicsDebugFilter, setPhysicsDebugFilter] = useState<PhysicsDebugFilter>("all");
  const [physicsDebugLayers, setPhysicsDebugLayers] = useState<PhysicsDebugLayers>(DEFAULT_PHYSICS_DEBUG_LAYERS);
  useEffect(() => {
    engine?.setPhysicsDebugFilter(physicsDebugFilter, selectedId);
  }, [engine, physicsDebugFilter, selectedId]);
  useEffect(() => {
    engine?.setPhysicsDebugLayers(physicsDebugLayers);
  }, [engine, physicsDebugLayers]);
  // T28 物理调试面板:开启状态由工作区持有,物理面板关闭重开不丢状态。
  const [physicsDebugPanelOpen, setPhysicsDebugPanelOpen] = useState(false);
  return {
    physicsDebugVisible, setPhysicsDebugVisible,
    physicsDebugFilter, setPhysicsDebugFilter,
    physicsDebugLayers, setPhysicsDebugLayers,
    physicsDebugPanelOpen, setPhysicsDebugPanelOpen,
  };
}
