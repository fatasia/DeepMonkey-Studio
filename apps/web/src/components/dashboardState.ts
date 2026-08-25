import type { SceneDashboardState } from "@bim-studio/contracts";

export const DEFAULT_DASHBOARD_STATE: SceneDashboardState = {
  side: "right",
  width: 410,
  backgroundColor: "#11191d",
  backgroundOpacity: 0.94,
  blur: 14,
  borderRadius: 10,
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
      const type = ["value", "gauge", "status", "line", "area", "bar", "pie", "table", "image", "video", "monitor", "url"].includes(String(item.type)) ? item.type! : "value";
      return {
        id: typeof item.id === "string" && item.id ? item.id : `widget-${index}`,
        title: typeof item.title === "string" ? item.title : `指标 ${index + 1}`,
        key: typeof item.key === "string" && item.key ? item.key : "value",
        type,
        unit: typeof item.unit === "string" ? item.unit : "",
        x: clampInteger(item.x, 0, 1, index % 2),
        y: clampInteger(item.y, 0, 10_000, Math.floor(index / 2)),
        w: clampInteger(item.w, 1, 2, 1),
        h: clampInteger(item.h, 1, 8, type === "url" || type === "video" || type === "monitor" || type === "table" ? 3 : ["line", "area", "bar", "pie"].includes(type) ? 2 : 1),
        ...(typeof item.min === "number" && Number.isFinite(item.min) ? { min: item.min } : {}),
        ...(typeof item.max === "number" && Number.isFinite(item.max) ? { max: item.max } : {}),
        ...(typeof item.color === "string" && /^#[0-9a-f]{6}$/i.test(item.color) ? { color: item.color } : {}),
        ...(typeof item.backgroundColor === "string" && /^#[0-9a-f]{6}$/i.test(item.backgroundColor) ? { backgroundColor: item.backgroundColor } : {}),
        ...(typeof item.backgroundOpacity === "number" ? { backgroundOpacity: Math.max(0, Math.min(1, item.backgroundOpacity)) } : {}),
        ...(typeof item.textColor === "string" && /^#[0-9a-f]{6}$/i.test(item.textColor) ? { textColor: item.textColor } : {}),
        ...(typeof item.datasetId === "string" ? { datasetId: item.datasetId } : {}),
        ...(typeof item.field === "string" ? { field: item.field } : {}),
        ...(typeof item.url === "string" ? { url: item.url.slice(0, 2_048) } : {}),
        ...(typeof item.imageUrl === "string" ? { imageUrl: item.imageUrl.slice(0, 2_048) } : {}),
        ...(typeof item.assetId === "string" ? { assetId: item.assetId } : {}),
        ...(type === "image" ? { imageFit: item.imageFit === "contain" || item.imageFit === "fill" ? item.imageFit : "cover" as const } : {}),
        ...(typeof item.videoUrl === "string" ? { videoUrl: item.videoUrl.slice(0, 2_048) } : {}),
        ...((type === "video" || type === "monitor") ? { videoFit: item.videoFit === "cover" || item.videoFit === "fill" ? item.videoFit : "contain" as const } : {}),
        ...(typeof item.videoAutoplay === "boolean" ? { videoAutoplay: item.videoAutoplay } : {}),
        ...(typeof item.videoMuted === "boolean" ? { videoMuted: item.videoMuted } : {}),
        ...(type === "monitor" ? { monitorProtocol: item.monitorProtocol === "webrtc" ? "webrtc" as const : "hls" as const } : {}),
        ...(typeof item.monitorSourceUrl === "string" ? { monitorSourceUrl: item.monitorSourceUrl.slice(0, 2_048) } : {})
      };
    })
    : structuredClone(DEFAULT_DASHBOARD_STATE.widgets);
  return {
    side: candidate.side === "left" ? "left" : "right",
    width: clampInteger(candidate.width, 320, 720, DEFAULT_DASHBOARD_STATE.width),
    ...(typeof candidate.backgroundColor === "string" && /^#[0-9a-f]{6}$/i.test(candidate.backgroundColor) ? { backgroundColor: candidate.backgroundColor } : {}),
    ...(typeof candidate.backgroundOpacity === "number" ? { backgroundOpacity: Math.max(0, Math.min(1, candidate.backgroundOpacity)) } : {}),
    ...(typeof candidate.blur === "number" ? { blur: clampInteger(candidate.blur, 0, 30, DEFAULT_DASHBOARD_STATE.blur ?? 14) } : {}),
    ...(typeof candidate.borderRadius === "number" ? { borderRadius: clampInteger(candidate.borderRadius, 0, 24, DEFAULT_DASHBOARD_STATE.borderRadius ?? 10) } : {}),
    widgets
  };
}

function clampInteger(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, Math.round(value))) : fallback;
}
