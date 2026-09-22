import { PreviewShell } from "./dashboardPreviewShared";
import { useDashboardPreviewGradientId as useGradientId } from "./dashboardComponentPreviewSvg";

/** 四类高级图表的净化 mark:纯 SVG 内联令牌着色,零新 CSS 类(外部参考缩略图规范:无轴线无网格)。 */
export function WordcloudPreview() {
  const words: ReadonlyArray<{ x: number; y: number; size: number; text: string; secondary?: boolean; opacity?: number }> = [
    { x: 12, y: 30, size: 15, text: "点检" },
    { x: 58, y: 24, size: 10.5, text: "巡检", secondary: true },
    { x: 30, y: 46, size: 9, text: "保养", secondary: true, opacity: 0.8 },
    { x: 56, y: 44, size: 12, text: "润滑", opacity: 0.85 },
    { x: 20, y: 16, size: 8, text: "紧固", secondary: true, opacity: 0.6 },
    { x: 74, y: 14, size: 7.5, text: "校准", opacity: 0.55 },
  ];
  return (
    <PreviewShell variant="wordcloud">
      <svg viewBox="8 6 82 46" aria-hidden="true">
        {words.map(({ x, y, size, text, secondary, opacity }) => (
          <text key={`${x}-${text}`} x={x} y={y} fontSize={size} fontWeight={700} opacity={opacity ?? 1}
            style={{ fill: secondary ? "var(--preview-secondary, currentColor)" : "var(--preview-accent, currentColor)" }}>
            {text}
          </text>
        ))}
      </svg>
    </PreviewShell>
  );
}

export function BoxplotPreview() {
  // 两个箱体:须线-箱体-中位线三段结构,箱体用 accent 半透明填充
  const accent = "var(--preview-accent, currentColor)";
  const boxes: ReadonlyArray<{ x: number; top: number; bottom: number; mid: number }> = [
    { x: 30, top: 16, bottom: 36, mid: 23 },
    { x: 62, top: 22, bottom: 44, mid: 30 },
  ];
  return (
    <PreviewShell variant="boxplot">
      <svg viewBox="10 8 80 44" aria-hidden="true">
        {boxes.map(({ x, top, bottom, mid }) => (
          <g key={x} stroke={accent} strokeWidth="1.6" strokeLinecap="round">
            <path d={`M${x} ${top - 6}V${top}M${x} ${bottom}V${bottom + 5}`} />
            <rect x={x - 9} y={top} width="18" height={bottom - top} rx="1.6" style={{ fill: accent, fillOpacity: 0.3 }} />
            <path d={`M${x - 9} ${mid}H${x + 9}`} strokeWidth="2" />
          </g>
        ))}
      </svg>
    </PreviewShell>
  );
}

export function WaterfallPreview() {
  const fallId = useGradientId("wf");
  return (
    <PreviewShell variant="waterfall">
      <svg viewBox="8 8 82 46" aria-hidden="true">
        <defs>
          <linearGradient id={fallId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" className="stop-accent-strong" />
            <stop offset="1" className="stop-accent-deep" />
          </linearGradient>
        </defs>
        {/* 基期满柱 + 升柱(语义红)+ 降柱(语义绿)悬浮,虚线表达累计路径 */}
        <rect x="13" y="14" width="11" height="36" rx="1.5" fill={`url(#${fallId})`} />
        <rect x="31" y="14" width="11" height="12" rx="1.5" style={{ fill: "var(--danger, #e06a5f)" }} />
        <rect x="49" y="8" width="11" height="10" rx="1.5" style={{ fill: "var(--danger, #e06a5f)" }} />
        <rect x="67" y="10" width="11" height="16" rx="1.5" style={{ fill: "var(--success, #4fae7e)" }} />
        <path d="M24 14H31M42 26V30M60 18H67" stroke="var(--preview-accent, currentColor)" strokeWidth="1.2" strokeDasharray="2.5 2" opacity="0.7" />
        <path d="M11 50H85" stroke="var(--preview-secondary, currentColor)" strokeWidth="1" opacity="0.5" />
      </svg>
    </PreviewShell>
  );
}

export function PolarBarPreview() {
  // 放射状环形堆叠段:两段一环、长短交替,表达极坐标柱的环形分布
  const spokes: ReadonlyArray<{ angle: number; inner: number; outer: number; secondary?: boolean }> = [
    { angle: 0, inner: 16, outer: 34 },
    { angle: 45, inner: 16, outer: 28, secondary: true },
    { angle: 90, inner: 16, outer: 38 },
    { angle: 135, inner: 16, outer: 24, secondary: true },
    { angle: 180, inner: 16, outer: 32 },
    { angle: 225, inner: 16, outer: 26, secondary: true },
    { angle: 270, inner: 16, outer: 36 },
    { angle: 315, inner: 16, outer: 22, secondary: true },
  ];
  return (
    <PreviewShell variant="polar-bar">
      <svg viewBox="10 8 76 44" aria-hidden="true">
        <circle cx="48" cy="30" r="16" stroke="var(--preview-secondary, currentColor)" strokeWidth="0.8" opacity="0.4" fill="none" />
        <circle cx="48" cy="30" r="27" stroke="var(--preview-secondary, currentColor)" strokeWidth="0.8" opacity="0.22" fill="none" />
        {spokes.map(({ angle, inner, outer, secondary }) => (
          <path
            key={angle}
            style={{ fill: secondary ? "var(--preview-secondary, currentColor)" : "var(--preview-accent, currentColor)" }}
            transform={`rotate(${angle} 48 30)`}
            d={`M48 ${30 - inner} h5 v-${outer - inner} h-5 Z`}
          />
        ))}
      </svg>
    </PreviewShell>
  );
}

export function FunnelPreview() {
  const funnels: ReadonlyArray<{ d: string; cls: string }> = [
    { d: "M13 9H83L74 19H22Z", cls: "step step-1" },
    { d: "M22 21.5H74L65 31.5H31Z", cls: "step step-2" },
    { d: "M31 34H65L56 44H40Z", cls: "step step-3" },
    { d: "M40 46.5H56L50 55H46Z", cls: "step step-4" },
  ];
  return (
    <PreviewShell variant="funnel-svg">
      <svg viewBox="10 6 76 52" aria-hidden="true">
        {funnels.map(({ d, cls }) => <path key={cls} className={cls} d={d} />)}
      </svg>
    </PreviewShell>
  );
}

export function TreemapPreview() {
  const treeId = useGradientId("tm");
  return (
    <PreviewShell variant="treemap-svg">
      <svg viewBox="9 6 84 52" aria-hidden="true">
        <defs>
          <linearGradient id={treeId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" className="stop-accent-strong" />
            <stop offset="1" className="stop-accent-deep" />
          </linearGradient>
        </defs>
        <g className="cells">
          <rect x="12" y="9" width="43" height="46" rx="2" fill={`url(#${treeId})`} />
          <rect x="57" y="9" width="33" height="21" rx="2" className="cell-2" />
          <rect x="57" y="32" width="20" height="23" rx="2" className="cell-3" />
          <rect x="79" y="32" width="11" height="23" rx="2" className="cell-4" />
        </g>
      </svg>
    </PreviewShell>
  );
}

export function RingPreview({ nested }: { nested: boolean }) {
  return (
    <PreviewShell variant={nested ? "ring sunburst" : "ring pie"}>
      <i />
      {nested && <b className="inner" />}
      <em>62%</em>
    </PreviewShell>
  );
}
