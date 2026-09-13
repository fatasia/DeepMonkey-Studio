import { useId } from "react";

/** 生成全局唯一的 SVG 渐变 id，同一页面多张预览卡片互不串色。 */
export function useDashboardPreviewGradientId(prefix: string): string {
  const raw = useId();
  return `${prefix}${raw.replace(/[^a-zA-Z0-9_-]/g, "")}`;
}
