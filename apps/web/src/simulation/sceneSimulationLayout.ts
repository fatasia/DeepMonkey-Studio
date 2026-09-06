export type SimulationPanelPlacement = "float" | "left" | "right";
export interface PanelLayout { left: number; top: number; width: number; height: number }
export interface SimulationPanelPreference {
  version: 2;
  placement: SimulationPanelPlacement;
  collapsed: boolean;
  dockWidth: number;
  floating?: PanelLayout;
}
export interface SimulationDockReservation { placement: SimulationPanelPlacement; collapsed: boolean; width: number }
export const SIMULATION_LAYOUT_KEY = "bim-studio.scene-simulation-panel-layout.v2";
export const LEGACY_SIMULATION_LAYOUT_KEY = "bim-studio.scene-simulation-panel-layout.v1";
export const DEFAULT_SIMULATION_LAYOUT: SimulationPanelPreference = { version: 2, placement: "float", collapsed: false, dockWidth: 420 };
const MARGIN = 10;

export function constrainPanelLayout(layout: PanelLayout, boundsWidth: number, boundsHeight: number, collapsed = false): PanelLayout {
  const marginX = Math.min(MARGIN, Math.max(0, boundsWidth / 2));
  const marginY = Math.min(MARGIN, Math.max(0, boundsHeight / 2));
  const availableWidth = Math.max(0, boundsWidth - marginX * 2);
  const availableHeight = Math.max(0, boundsHeight - marginY * 2);
  const width = Math.min(Math.max(Math.min(420, availableWidth), layout.width), availableWidth);
  const height = Math.min(Math.max(Math.min(360, availableHeight), layout.height), availableHeight);
  return {
    left: Math.min(Math.max(marginX, layout.left), Math.max(marginX, boundsWidth - (collapsed ? Math.min(320, width) : width) - marginX)),
    top: Math.min(Math.max(marginY, layout.top), Math.max(marginY, boundsHeight - (collapsed ? Math.min(48, height) : height) - marginY)),
    width, height,
  };
}

export function defaultPanelLayout(width: number, height: number): PanelLayout {
  const panelWidth = Math.min(520, Math.max(280, width - MARGIN * 2));
  const panelHeight = Math.min(610, Math.max(280, height - 116));
  return { left: Math.max(MARGIN, width - panelWidth - 18), top: Math.min(84, Math.max(MARGIN, height - panelHeight - MARGIN)), width: panelWidth, height: panelHeight };
}

export function constrainDockWidth(width: number, available: number): number {
  // 即使同时展开场景树 / 检查器，也至少留 280px 给真正的渲染容器。
  const maximum = Math.max(0, Math.min(600, available - 280));
  return Math.min(Math.max(Math.min(360, maximum), width), maximum);
}

function decodeFloating(value: unknown): PanelLayout | undefined {
  if (!value || typeof value !== "object") return undefined;
  const rect = value as Partial<PanelLayout>;
  if (![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) || rect.width! <= 0 || rect.height! <= 0) return undefined;
  return { left: rect.left!, top: rect.top!, width: rect.width!, height: rect.height! };
}

export function decodeSimulationLayout(value: unknown): SimulationPanelPreference | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<SimulationPanelPreference>;
  if (candidate.version === undefined) {
    const floating = decodeFloating(value);
    return floating ? { ...DEFAULT_SIMULATION_LAYOUT, floating } : undefined;
  }
  if (candidate.version !== 2) return undefined;
  if (!["float", "left", "right"].includes(String(candidate.placement))) return undefined;
  const floating = decodeFloating(candidate.floating);
  return {
    version: 2, placement: candidate.placement!, collapsed: candidate.collapsed === true,
    dockWidth: Number.isFinite(candidate.dockWidth) ? Math.max(360, Math.min(600, candidate.dockWidth!)) : 420,
    ...(floating ? { floating } : {}),
  };
}

export function readSimulationLayout(): SimulationPanelPreference {
  for (const key of [SIMULATION_LAYOUT_KEY, LEGACY_SIMULATION_LAYOUT_KEY]) {
    try {
      const decoded = decodeSimulationLayout(JSON.parse(localStorage.getItem(key) ?? "null"));
      if (decoded) return { ...decoded, collapsed: false };
    } catch { /* 损坏的 v2 仍可回退 v1；受限存储使用内存默认值。 */ }
  }
  return { ...DEFAULT_SIMULATION_LAYOUT };
}

export function writeSimulationLayout(value: SimulationPanelPreference): void {
  // 显式重新打开仍默认展开；收起是当前会话状态，不恢复上次运行或表单。
  try { localStorage.setItem(SIMULATION_LAYOUT_KEY, JSON.stringify(decodeSimulationLayout({ ...value, collapsed: false }))); }
  catch { /* 私密浏览不妨碍本次停靠和浮动操作。 */ }
}
