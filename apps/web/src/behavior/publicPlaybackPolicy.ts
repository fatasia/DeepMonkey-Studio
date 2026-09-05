import type { DashboardDataWidgetConfig } from "@bim-studio/contracts";

/** Gate only server-backed features; local data, filtering and Worker commands remain active. */
export function publicWidgetRestriction(widget: DashboardDataWidgetConfig, hasRuntimeValue: boolean): string | undefined {
  if ((widget.datasetId || widget.pipelineId || widget.directBinding) && !hasRuntimeValue) return "受保护数据尚未开放；公开页不会读取后台数据源。";
  if (widget.type === "monitor" && widget.monitorSourceUrl && !widget.videoUrl) return "监控源需要媒体网关授权，请发布可浏览的视频地址。";
}
