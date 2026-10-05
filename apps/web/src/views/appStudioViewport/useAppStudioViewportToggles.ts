import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { isTextEntryTarget } from "../../shortcuts/keymap";

/**
 * AppStudioViewport 面板开态(source-size 拆分,2026-10-04:自 AppStudioViewport.tsx
 * 按职责抽出自定义 hook,代码逐行同源;语义零变化)。
 *
 * 职责:开发者 HUD / 实验性功能 / 光照烘焙工作台 / 工程分析 / 质量面板 / 发布视口
 * 对象面板的本地开态,以及 HUD 固定 F9 快捷键 effect。
 */
export interface AppStudioViewportToggles {
  readonly viewerObjectPanelOpen: boolean;
  readonly setViewerObjectPanelOpen: Dispatch<SetStateAction<boolean>>;
  readonly engineeringOpen: boolean;
  readonly setEngineeringOpen: Dispatch<SetStateAction<boolean>>;
  readonly qualityPanelOpen: boolean;
  readonly setQualityPanelOpen: Dispatch<SetStateAction<boolean>>;
  readonly devHudOpen: boolean;
  readonly setDevHudOpen: Dispatch<SetStateAction<boolean>>;
  readonly experimentalPanelOpen: boolean;
  readonly setExperimentalPanelOpen: Dispatch<SetStateAction<boolean>>;
  readonly bakeBenchOpen: boolean;
  readonly setBakeBenchOpen: Dispatch<SetStateAction<boolean>>;
}

export function useAppStudioViewportToggles(): AppStudioViewportToggles {
  const [viewerObjectPanelOpen, setViewerObjectPanelOpen] = useState(false);
  const [engineeringOpen, setEngineeringOpen] = useState(false);
  const [qualityPanelOpen, setQualityPanelOpen] = useState(false);
  // 刀 6:开发者 HUD(性能观测小条)开态;默认关,F9 或工具坞「查看与分析」菜单开。
  const [devHudOpen, setDevHudOpen] = useState(false);
  // 配置易用性:实验性功能面板(URL opt-in 开关集中呈递)开态;默认关,工具坞「仿真与开发」菜单开。
  const [experimentalPanelOpen, setExperimentalPanelOpen] = useState(false);
  // T0 刀 4:光照烘焙工作台开态(工作区持有,面板关闭重开不丢会话观察)。
  const [bakeBenchOpen, setBakeBenchOpen] = useState(false);
  // 刀 6:开发者 HUD 用固定 F9,不进用户可配置键位表(keymap 面向编辑动作);
  // 文本控件聚焦时跳过,与全局快捷键分发器同纪律。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "F9" || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      if (isTextEntryTarget(event.target)) return;
      event.preventDefault();
      setDevHudOpen((value) => !value);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
  return {
    viewerObjectPanelOpen, setViewerObjectPanelOpen,
    engineeringOpen, setEngineeringOpen,
    qualityPanelOpen, setQualityPanelOpen,
    devHudOpen, setDevHudOpen,
    experimentalPanelOpen, setExperimentalPanelOpen,
    bakeBenchOpen, setBakeBenchOpen,
  };
}
