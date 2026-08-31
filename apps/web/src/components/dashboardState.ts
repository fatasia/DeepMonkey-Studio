import type { SceneDashboardState } from "@bim-studio/contracts";

export const DEFAULT_DASHBOARD_STATE: SceneDashboardState = {
  side: "right",
  width: 410,
  backgroundColor: "#11191d",
  backgroundOpacity: 0.94,
  blur: 14,
  borderRadius: 10,
  widgets: []
};

export function normalizeDashboardState(value: unknown): SceneDashboardState {
  if (!value || typeof value !== "object") return structuredClone(DEFAULT_DASHBOARD_STATE);
  const candidate = value as Partial<SceneDashboardState>;
  const widgets = Array.isArray(candidate.widgets)
    ? candidate.widgets.filter((widget) => widget && typeof widget === "object").slice(0, 100).map((widget, index) => {
      const item = widget as Partial<SceneDashboardState["widgets"][number]>;
      const type = ["value", "gauge", "status", "line", "area", "bar", "pie", "table", "image", "video", "monitor", "url", "topology"].includes(String(item.type)) ? item.type! : "value";
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
        ...(typeof item.pipelineId === "string" ? { pipelineId: item.pipelineId } : {}),
        ...(typeof item.field === "string" ? { field: item.field } : {}),
        ...(typeof item.url === "string" ? { url: item.url.slice(0, 2_048) } : {}),
        ...(typeof item.imageUrl === "string" ? { imageUrl: item.imageUrl.slice(0, 2_048) } : {}),
        ...(typeof item.assetId === "string" ? { assetId: item.assetId } : {}),
        ...(type === "image" ? { imageFit: item.imageFit === "contain" || item.imageFit === "fill" ? item.imageFit : "cover" as const } : {}),
        ...(typeof item.videoUrl === "string" ? { videoUrl: item.videoUrl.slice(0, 2_048) } : {}),
        ...((type === "video" || type === "monitor") ? { videoFit: item.videoFit === "cover" || item.videoFit === "fill" ? item.videoFit : "contain" as const } : {}),
        ...(typeof item.videoAutoplay === "boolean" ? { videoAutoplay: item.videoAutoplay } : {}),
        ...(typeof item.videoMuted === "boolean" ? { videoMuted: item.videoMuted } : {}),
        ...(typeof item.videoLoop === "boolean" ? { videoLoop: item.videoLoop } : {}),
        ...(typeof item.animationAutoplay === "boolean" ? { animationAutoplay: item.animationAutoplay } : {}),
        ...(typeof item.animationLoop === "boolean" ? { animationLoop: item.animationLoop } : {}),
        ...(typeof item.animationDuration === "number" && Number.isFinite(item.animationDuration) ? { animationDuration: Math.max(0.1, item.animationDuration) } : {}),
        ...(typeof item.animationDelay === "number" && Number.isFinite(item.animationDelay) ? { animationDelay: Math.max(0, item.animationDelay) } : {}),
        ...(["none", "fade", "slide-up", "scale", "pulse"].includes(String(item.animation)) ? { animation: item.animation } : {}),
        ...(type === "monitor" ? { monitorProtocol: item.monitorProtocol === "webrtc" ? "webrtc" as const : "hls" as const } : {}),
        ...(typeof item.monitorSourceUrl === "string" ? { monitorSourceUrl: item.monitorSourceUrl.slice(0, 2_048) } : {}),
        ...(typeof item.topologyId === "string" ? { topologyId: item.topologyId } : {})
      };
    })
    : [];
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
