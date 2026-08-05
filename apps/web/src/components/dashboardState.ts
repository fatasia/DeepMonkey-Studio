import type { SceneDashboardState } from "@bim-studio/contracts";

export const DEFAULT_DASHBOARD_STATE: SceneDashboardState = {
  side: "right",
  width: 410,
  widgets: [
    { id: "realtime-value", title: "实时数值", key: "value", type: "value", unit: "", x: 0, y: 0, w: 1, h: 1, color: "#d4a84f" },
    { id: "device-gauge", title: "设备负载", key: "value", type: "gauge", unit: "%", x: 1, y: 0, w: 1, h: 2, min: 0, max: 100, color: "#d4a84f" },
    { id: "realtime-trend", title: "实时趋势", key: "value", type: "line", unit: "", x: 0, y: 1, w: 1, h: 2, color: "#63a8e8" },
    { id: "device-status", title: "设备状态", key: "status", type: "status", unit: "", x: 0, y: 3, w: 1, h: 1, color: "#65d89a" }
  ]
};

export function normalizeDashboardState(value: unknown): SceneDashboardState {
  if (!value || typeof value !== "object") return structuredClone(DEFAULT_DASHBOARD_STATE);
  const candidate = value as Partial<SceneDashboardState>;
  const widgets = Array.isArray(candidate.widgets)
    ? candidate.widgets.filter((widget) => widget && typeof widget === "object").slice(0, 100).map((widget, index) => {
      const item = widget as Partial<SceneDashboardState["widgets"][number]>;
      const type = ["value", "gauge", "status", "line", "bar"].includes(String(item.type)) ? item.type! : "value";
      return {
        id: typeof item.id === "string" && item.id ? item.id : `widget-${index}`,
        title: typeof item.title === "string" ? item.title : `指标 ${index + 1}`,
        key: typeof item.key === "string" && item.key ? item.key : "value",
        type,
        unit: typeof item.unit === "string" ? item.unit : "",
        x: clampInteger(item.x, 0, 1, index % 2),
        y: clampInteger(item.y, 0, 10_000, Math.floor(index / 2)),
        w: clampInteger(item.w, 1, 2, 1),
        h: clampInteger(item.h, 1, 8, type === "line" || type === "bar" ? 2 : 1),
        ...(typeof item.min === "number" && Number.isFinite(item.min) ? { min: item.min } : {}),
        ...(typeof item.max === "number" && Number.isFinite(item.max) ? { max: item.max } : {}),
        ...(typeof item.color === "string" && /^#[0-9a-f]{6}$/i.test(item.color) ? { color: item.color } : {})
      };
    })
    : structuredClone(DEFAULT_DASHBOARD_STATE.widgets);
  return {
    side: candidate.side === "left" ? "left" : "right",
    width: clampInteger(candidate.width, 320, 720, DEFAULT_DASHBOARD_STATE.width),
    widgets
  };
}

function clampInteger(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, Math.round(value))) : fallback;
}
