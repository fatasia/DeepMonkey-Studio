import { createContext, useContext, type CSSProperties } from "react";
import type { DashboardComponentPresetPreview } from "./dashboardComponentPresetTypes";

export const PreviewMetadataContext = createContext<{ preview: DashboardComponentPresetPreview | undefined; showMark: boolean }>({ preview: undefined, showMark: true });

export function PreviewShell({ variant, children }: { variant: string; children: React.ReactNode }) {
  const { preview, showMark } = useContext(PreviewMetadataContext);
  const resourceStyle = preview ? {
    "--preview-accent": preview.accent,
    "--preview-secondary": preview.secondary,
  } as CSSProperties : undefined;
  return <span
    className={`dashboard-library-preview ${variant}`}
    data-preview-family={preview?.family}
    data-preview-variant={preview?.variant}
    style={resourceStyle}
  >
    {children}
    {preview && showMark && <small className="dashboard-library-preview-mark">{preview.mark}</small>}
  </span>;
}

/** 双系列迷你图例：两个小色块即可表达“多系列”，置于绘图区右上不与数据冲突。 */
export function MiniLegend({ x = 60 }: { x?: number }) {
  return <g className="legend">
    <rect x={x} y="5" width="9" height="3" rx="1.2" />
    <rect x={x + 13} y="5" width="9" height="3" rx="1.2" />
  </g>;
}

/** 垂直渐变定义；stop 颜色由 CSS 变量注入，保持令牌纪律。 */
export function AreaGradientDef({ id, strongClass, weakClass }: { id: string; strongClass: string; weakClass: string }) {
  return <defs>
    <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" className={strongClass} />
      <stop offset="1" className={weakClass} />
    </linearGradient>
  </defs>;
}

export function HorizontalGradientDef({ id, strongClass, weakClass }: { id: string; strongClass: string; weakClass: string }) {
  return <defs>
    <linearGradient id={id} x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" className={strongClass} />
      <stop offset="1" className={weakClass} />
    </linearGradient>
  </defs>;
}
