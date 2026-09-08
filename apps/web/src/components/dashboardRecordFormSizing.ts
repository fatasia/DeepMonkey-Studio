import type { CSSProperties } from "react";

/** 只提升控件排版尺寸；画布/组件仍沿用同一个等比变换，超长表单在原边框内滚动。 */
export function dashboardRecordFormSizing(scaleX: number, scaleY: number): CSSProperties {
  const scale = Math.min(1, ...[scaleX, scaleY].map(value => Number.isFinite(value) && value > 0 ? value : 1));
  return {
    "--dashboard-form-font-size": `${13 / scale}px`,
    "--dashboard-form-control-height": `${32 / scale}px`,
  } as CSSProperties;
}
