import { Shapes } from "lucide-react";
import type { DashboardDataWidgetConfig, SceneDashboardWidgetType } from "@bim-studio/contracts";
import { createContext, useContext, type CSSProperties } from "react";
import type { DashboardComponentPresetPreview } from "./dashboardComponentPresetTypes";
import { DashboardMapPreviewGraphic } from "./DashboardMapPreviewGraphic";
import { useDashboardPreviewGradientId as useGradientId } from "./dashboardComponentPreviewSvg";

type PreviewType = SceneDashboardWidgetType | "scene";
type DecorationStyle = DashboardDataWidgetConfig["decorationStyle"];

interface DashboardComponentPreviewProps {
  type: PreviewType;
  decorationStyle?: DecorationStyle;
  preview?: DashboardComponentPresetPreview;
  showMark?: boolean;
}

const PreviewMetadataContext = createContext<{ preview: DashboardComponentPresetPreview | undefined; showMark: boolean }>({ preview: undefined, showMark: true });

/** 素材预览必须表达真实图形语义，避免用户插入后才发现组件类型不符。 */
export function DashboardComponentPreview({ type, decorationStyle, preview, showMark = true }: DashboardComponentPreviewProps) {
  return <PreviewMetadataContext.Provider value={{ preview, showMark }}>
    <DashboardComponentPreviewGraphic type={type} decorationStyle={decorationStyle} />
  </PreviewMetadataContext.Provider>;
}

function DashboardComponentPreviewGraphic({ type, decorationStyle }: Omit<DashboardComponentPreviewProps, "preview">) {
  if (type === "line" || type === "area" || type === "combo") return <TrendPreview type={type} />;
  if (type === "scatter") return <ScatterPreview />;
  if (type === "radar") return <RadarPreview />;
  if (type === "graph") return <GraphPreview />;
  if (type === "sankey") return <SankeyPreview />;
  if (type === "bar") return <BarPreview />;
  if (type === "rank") return <RankPreview />;
  if (type === "wordcloud") return <WordcloudPreview />;
  if (type === "boxplot") return <BoxplotPreview />;
  if (type === "waterfall") return <WaterfallPreview />;
  if (type === "polarBar") return <PolarBarPreview />;
  if (type === "funnel") return <FunnelPreview />;
  if (type === "treemap") return <TreemapPreview />;
  if (type === "pie" || type === "sunburst") return <RingPreview nested={type === "sunburst"} />;
  if (type === "gauge") return <GaugePreview />;
  if (type === "liquid-fill") return <LiquidPreview />;
  if (type === "map") return <MapPreview />;
  if (type === "table" || type === "scroll-table") return <TablePreview scrolling={type === "scroll-table"} />;
  if (type === "value" || type === "digital-flip" || type === "progress" || type === "status") {
    return <MetricPreview type={type} />;
  }
  if (type === "filter") return <FilterPreview />;
  if (type === "record-form") return <RecordFormPreview />;
  if (type === "text") return <TextPreview />;
  if (type === "shape") return <ShapePreview />;
  if (type === "decoration") return <DecorationPreview style={decorationStyle ?? "title"} />;
  if (type === "scene") return <CompositionPreview kind="scene" />;
  if (type === "topology") return <CompositionPreview kind="topology" />;
  if (type === "image") return <CompositionPreview kind="image" />;
  if (type === "video") return <CompositionPreview kind="video" />;
  if (type === "monitor") return <CompositionPreview kind="monitor" />;
  if (type === "url") return <CompositionPreview kind="url" />;
  if (type === "unity") return <CompositionPreview kind="unity" />;
  return <IconPreview icon={<Shapes size={22} />} />;
}

function PreviewShell({ variant, children }: { variant: string; children: React.ReactNode }) {
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
function MiniLegend({ x = 60 }: { x?: number }) {
  return <g className="legend">
    <rect x={x} y="5" width="9" height="3" rx="1.2" />
    <rect x={x + 13} y="5" width="9" height="3" rx="1.2" />
  </g>;
}

/** 垂直渐变定义；stop 颜色由 CSS 变量注入，保持令牌纪律。 */
function AreaGradientDef({ id, strongClass, weakClass }: { id: string; strongClass: string; weakClass: string }) {
  return <defs>
    <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" className={strongClass} />
      <stop offset="1" className={weakClass} />
    </linearGradient>
  </defs>;
}

function HorizontalGradientDef({ id, strongClass, weakClass }: { id: string; strongClass: string; weakClass: string }) {
  return <defs>
    <linearGradient id={id} x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" className={strongClass} />
      <stop offset="1" className={weakClass} />
    </linearGradient>
  </defs>;
}

const TREND_PRIMARY = "M12 38L26 30 40 33 54 18 68 24 90 10";
const TREND_SECONDARY = "M12 31L26 35 40 24 54 28 68 15 90 16";
const TREND_DOTS: ReadonlyArray<readonly [number, number]> = [[26, 30], [54, 18], [90, 10]];

function TrendPreview({ type }: { type: "line" | "area" | "combo" }) {
  const fillId = useGradientId("tg");
  return (
    <PreviewShell variant={`trend ${type}`}>
      {/* 帆软图表缩略图规范:无轴线、无网格、无标签,纯净图形本体放大居中。 */}
      <svg viewBox="8 3 84 52" aria-hidden="true">
        {type === "area" && <AreaGradientDef id={fillId} strongClass="stop-accent-strong" weakClass="stop-accent-ghost" />}
        {type === "area" && <path className="area-fill" d={`${TREND_PRIMARY}L90 50L12 50Z`} fill={`url(#${fillId})`} />}
        {type === "combo" && <g className="combo-bars">
          <rect x="15" y="30" width="9" height="20" rx="1.5" />
          <rect x="31" y="24" width="9" height="26" rx="1.5" />
          <rect x="47" y="33" width="9" height="17" rx="1.5" />
          <rect x="63" y="20" width="9" height="30" rx="1.5" />
          <rect x="79" y="27" width="9" height="23" rx="1.5" />
        </g>}
        {type !== "combo" && <path className="line-secondary" d={TREND_SECONDARY} />}
        <path className="line-primary" d={type === "combo" ? "M19 26L35 20 51 30 67 14 83 18" : TREND_PRIMARY} />
        <g className="dots">
          {(type === "combo" ? [[35, 20] as const, [67, 14] as const] : TREND_DOTS).map(([cx, cy]) => (
            <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="2.1" />
          ))}
        </g>
        <MiniLegend x={type === "area" ? 58 : 56} />
      </svg>
    </PreviewShell>
  );
}

function ScatterPreview() {
  return (
    <PreviewShell variant="scatter">
      <svg viewBox="10 8 82 42" aria-hidden="true">
        <path className="trend-fit" d="M14 44L88 14" />
        <g className="dots">
          <circle cx="22" cy="36" r="2.6" /><circle cx="34" cy="27" r="2.2" /><circle cx="47" cy="31" r="2.6" />
          <circle cx="60" cy="20" r="2.2" /><circle cx="77" cy="23" r="2.6" />
        </g>
        <g className="dots-alt">
          <circle cx="28" cy="43" r="2.2" /><circle cx="41" cy="38" r="2.6" /><circle cx="55" cy="36" r="2.2" />
          <circle cx="68" cy="30" r="2.6" /><circle cx="82" cy="34" r="2.2" />
        </g>
        <MiniLegend x={56} />
      </svg>
    </PreviewShell>
  );
}

function RadarPreview() {
  const fillId = useGradientId("rd");
  return (
    <PreviewShell variant="radar">
      <svg viewBox="25 5 46 48" aria-hidden="true">
        <defs>
          <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" className="stop-accent-strong" />
            <stop offset="1" className="stop-accent-ghost" />
          </linearGradient>
        </defs>
        <g className="grid">
          <path d="M48 8L68.5 21.8 61 45.2 35 45.2 27.5 21.8Z" />
          <path d="M48 16.5L60.6 25 55.8 39.9 40.2 39.9 35.4 25Z" />
          <path d="M48 25L52.7 28.2 50.9 33.7 45.1 33.7 43.3 28.2Z" />
        </g>
        <path className="value" d="M48 12.5L64.5 24.5 59.5 42 37.5 40 32.5 24Z" fill={`url(#${fillId})`} />
        <g className="dots">
          <circle cx="48" cy="12.5" r="1.7" /><circle cx="64.5" cy="24.5" r="1.7" /><circle cx="59.5" cy="42" r="1.7" />
          <circle cx="37.5" cy="40" r="1.7" /><circle cx="32.5" cy="24" r="1.7" />
        </g>
      </svg>
    </PreviewShell>
  );
}

function GraphPreview() {
  return (
    <PreviewShell variant="graph">
      <svg viewBox="10 5 76 50" aria-hidden="true">
        <path className="edges" d="M18 40L38 14 62 22 80 42M38 14L48 46M18 40L48 46 80 42" />
        <g className="halo"><circle cx="38" cy="14" r="8" /><circle cx="80" cy="42" r="7.4" /></g>
        <g className="nodes">
          <circle cx="18" cy="40" r="3.6" /><circle cx="38" cy="14" r="5" /><circle cx="62" cy="22" r="3.8" />
          <circle cx="48" cy="46" r="3.2" /><circle cx="80" cy="42" r="4.6" />
        </g>
      </svg>
    </PreviewShell>
  );
}

function SankeyPreview() {
  const flowId = useGradientId("sk");
  return (
    <PreviewShell variant="sankey">
      <svg viewBox="7 9 80 44" aria-hidden="true">
        <defs>
          <linearGradient id={`${flowId}a`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" className="stop-accent-strong" />
            <stop offset="1" className="stop-accent-ghost" />
          </linearGradient>
          <linearGradient id={`${flowId}b`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" className="stop-secondary-strong" />
            <stop offset="1" className="stop-secondary-ghost" />
          </linearGradient>
        </defs>
        <path className="flow" stroke={`url(#${flowId}a)`} strokeWidth="8" d="M12 20C34 20 30 38 52 38S70 26 84 26" />
        <path className="flow" stroke={`url(#${flowId}b)`} strokeWidth="6.4" d="M12 42C31 42 35 24 52 24S69 40 84 40" />
        <g className="nodes">
          <path d="M9 13V26M9 35V48M83 20V32M83 34V46" />
        </g>
      </svg>
    </PreviewShell>
  );
}

function BarPreview() {
  const barId = useGradientId("br");
  return (
    <PreviewShell variant="bars-svg">
      <svg viewBox="10 10 78 44" aria-hidden="true">
        <defs>
          <linearGradient id={barId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" className="stop-accent-strong" />
            <stop offset="1" className="stop-accent-deep" />
          </linearGradient>
        </defs>
        <g className="bars">
          <rect x="14" y="32" width="9" height="18" rx="1.5" fill={`url(#${barId})`} />
          <rect x="28" y="24" width="9" height="26" rx="1.5" fill={`url(#${barId})`} />
          <rect x="42" y="37" width="9" height="13" rx="1.5" fill={`url(#${barId})`} />
          <rect x="56" y="16" width="9" height="34" rx="1.5" fill={`url(#${barId})`} />
          <rect x="70" y="28" width="9" height="22" rx="1.5" fill={`url(#${barId})`} />
          <rect x="84" y="35" width="6" height="15" rx="1.5" fill={`url(#${barId})`} opacity=".72" />
        </g>
        <path className="target" d="M12 23H90" />
        <circle className="peak" cx="60.5" cy="14" r="2" />
      </svg>
    </PreviewShell>
  );
}

function RankPreview() {
  const rankId = useGradientId("rk");
  return (
    <PreviewShell variant="rank-svg">
      <svg viewBox="9 10 78 46" aria-hidden="true">
        <defs>
          <linearGradient id={rankId} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" className="stop-accent-strong" />
            <stop offset="1" className="stop-accent-mid" />
          </linearGradient>
        </defs>
        <g className="rank-bars">
          <rect x="12" y="13" width="66" height="7" rx="2" fill={`url(#${rankId})`} />
          <rect x="12" y="25" width="52" height="7" rx="2" fill={`url(#${rankId})`} opacity=".66" />
          <rect x="12" y="37" width="41" height="7" rx="2" fill={`url(#${rankId})`} opacity=".46" />
          <rect x="12" y="49" width="30" height="4" rx="1.6" fill={`url(#${rankId})`} opacity=".3" />
        </g>
        <g className="rank-caps">
          <rect x="76" y="14.6" width="2.6" height="3.8" rx="1.2" className="cap" />
        </g>
      </svg>
    </PreviewShell>
  );
}

/** 四类高级图表的净化 mark:纯 SVG 内联令牌着色,零新 CSS 类(帆软缩略图规范:无轴线无网格)。 */
function WordcloudPreview() {
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

function BoxplotPreview() {
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

function WaterfallPreview() {
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

function PolarBarPreview() {
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

function FunnelPreview() {
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

function TreemapPreview() {
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

function RingPreview({ nested }: { nested: boolean }) {
  return (
    <PreviewShell variant={nested ? "ring sunburst" : "ring pie"}>
      <i />
      {nested && <b className="inner" />}
      <em>62%</em>
    </PreviewShell>
  );
}

/**
 * 仪表阈值族的 mark 构图表:同 type(gauge)下每款量程、刻度与色带构图可辨
 * (帆软缩略图规范:无轴线无网格、净化 SVG、零新 CSS 类)。
 * 行业 KPI 等其他 gauge 预设不在表内,回落到默认构图。
 */
type GaugeDialShape = "half" | "full" | "arc270" | "short";

interface GaugeDialConfig {
  shape: GaugeDialShape;
  /** 沿弧百分比(0-100)的分段色带,颜色走净化令牌变量。 */
  segments?: ReadonlyArray<{ from: number; to: number; tone: "accent" | "secondary" | "danger" | "success" | "warn" }>;
  /** 沿弧百分比(0-100)的刻度点。 */
  ticks?: number[];
  /** 指针(at 为 0-100 沿弧百分比)。 */
  needles?: ReadonlyArray<{ at: number; tone?: "accent" | "secondary" }>;
  /** 偏差表的中心零位刻线。 */
  centerZero?: boolean;
  /** 安全线 / 饱和线等参考刻线(0-100)。 */
  guide?: { at: number; color: string };
  /** 反向弧:进度从满弧向零递减(储备裕度语义)。 */
  reversed?: boolean;
  value: string;
  unit?: string;
}

const GAUGE_TONE: Record<string, string> = {
  accent: "var(--preview-accent, currentColor)",
  secondary: "var(--preview-secondary, currentColor)",
  danger: "var(--danger, #e06a5f)",
  success: "var(--success, #4fae7e)",
  warn: "var(--warning, #e8bd68)",
};

/** 仪表盘中心与半径;dial 弧几何统一在此换算。 */
const GAUGE_CENTER = { cx: 48, cy: 46 };
const GAUGE_RADIUS = 28;

function gaugeArcPath(shape: GaugeDialShape): string {
  const { cx, cy } = GAUGE_CENTER;
  const r = GAUGE_RADIUS;
  if (shape === "full") return `M${cx} ${cy - r}A${r} ${r} 0 1 1 ${cx - 0.01} ${cy - r}`;
  if (shape === "arc270") return `M${(cx + r * Math.cos((135 * Math.PI) / 180)).toFixed(1)} ${(cy + r * Math.sin((135 * Math.PI) / 180)).toFixed(1)}A${r} ${r} 0 1 1 ${(cx + r * Math.cos((45 * Math.PI) / 180)).toFixed(1)} ${(cy + r * Math.sin((45 * Math.PI) / 180)).toFixed(1)}`;
  if (shape === "short") return `M${cx - r * 0.72} ${cy + r * 0.55}A${r} ${r} 0 0 1 ${cx + r * 0.72} ${cy + r * 0.55}`;
  return `M${cx - r} ${cy}A${r} ${r} 0 0 1 ${cx + r} ${cy}`;
}

/** 沿弧百分比 → 弧上坐标(半环/全环/270° 弧统一按各自扫过角度插值)。 */
function gaugePoint(shape: GaugeDialShape, at: number): { x: number; y: number } {
  const { cx, cy } = GAUGE_CENTER;
  const sweep = shape === "full" ? 360 : shape === "arc270" ? 270 : shape === "short" ? 150 : 180;
  const start = shape === "full" ? -90 : shape === "arc270" ? 135 : shape === "short" ? 145 : 180;
  const angle = ((start + (sweep * at) / 100) * Math.PI) / 180;
  return { x: cx + GAUGE_RADIUS * Math.cos(angle), y: cy + GAUGE_RADIUS * Math.sin(angle) };
}

function GaugeDial({ shape, segments, ticks, needles, centerZero, guide, reversed, value, unit }: GaugeDialConfig) {
  const path = gaugeArcPath(shape);
  const needleTone = (tone?: string) => (tone === "secondary" ? GAUGE_TONE.secondary : GAUGE_TONE.accent);
  return (
    <>
      {/* 底轨 */}
      <path className="gauge-track" d={path} />
      {/* 分段色带:pathLength=100 + dash 偏移按百分比切片,净化无裁剪路径 */}
      {(segments ?? []).map(({ from, to, tone }, index) => (
        <path key={index} d={path} pathLength={100} fill="none" stroke={GAUGE_TONE[tone]} strokeWidth={reversed ? 6.5 : 8} strokeLinecap="butt"
          strokeDasharray={`${Math.max(0.5, to - from)} ${100 - (to - from)}`} strokeDashoffset={-from} opacity={0.92} />
      ))}
      <g className="ticks">
        {(ticks ?? []).map((at) => {
          const p = gaugePoint(shape, at);
          return <circle key={at} cx={p.x.toFixed(1)} cy={p.y.toFixed(1)} r="1.5" />;
        })}
      </g>
      {centerZero && <path d={`M${GAUGE_CENTER.cx} ${GAUGE_CENTER.cy}L${GAUGE_CENTER.cx} ${GAUGE_CENTER.cy - GAUGE_RADIUS - 3}`} stroke={GAUGE_TONE.secondary} strokeWidth="1.2" strokeDasharray="2.4 2" opacity="0.9" fill="none" />}
      {guide && (() => {
        const p = gaugePoint(shape, guide.at);
        return <path d={`M${p.x.toFixed(1)} ${p.y.toFixed(1)}L${(GAUGE_CENTER.cx + (p.x - GAUGE_CENTER.cx) * 0.42).toFixed(1)} ${(GAUGE_CENTER.cy + (p.y - GAUGE_CENTER.cy) * 0.42).toFixed(1)}`} stroke={guide.color} strokeWidth="1.6" strokeLinecap="round" fill="none" />;
      })()}
      {(needles ?? []).map(({ at, tone }, index) => {
        const p = gaugePoint(shape, reversed ? 100 - at : at);
        return <path key={index} d={`M${GAUGE_CENTER.cx} ${GAUGE_CENTER.cy}L${p.x.toFixed(1)} ${p.y.toFixed(1)}`} stroke={needleTone(tone)} strokeWidth="2.2" strokeLinecap="round" fill="none" />;
      })}
      <circle className="hub" cx={GAUGE_CENTER.cx} cy={GAUGE_CENTER.cy} r="2.6" />
      <em>{value}{unit && <i>{unit}</i>}</em>
    </>
  );
}

/** 仪表阈值族 16 款的 mark → 构图映射(与 dashboardGaugeThresholdPresets 一一对应)。 */
const GAUGE_MARK_DIALS: Readonly<Record<string, GaugeDialConfig>> = {
  双指针转: { shape: "half", ticks: [0, 50, 100], needles: [{ at: 68 }, { at: 86, tone: "secondary" }], value: "2450", unit: "rpm" },
  分段色带: { shape: "half", segments: [{ from: 0, to: 55, tone: "success" }, { from: 55, to: 80, tone: "warn" }, { from: 80, to: 100, tone: "danger" }], ticks: [0, 50, 100], needles: [{ at: 62 }], value: "1.6", unit: "MPa" },
  半环温度: { shape: "short", ticks: [0, 50, 100], needles: [{ at: 38 }], value: "-18", unit: "°C" },
  全环完成: { shape: "full", segments: [{ from: 0, to: 72, tone: "accent" }], ticks: [0, 25, 50, 75], needles: [], value: "72", unit: "%" },
  "270°弧": { shape: "arc270", segments: [{ from: 0, to: 58, tone: "accent" }], ticks: [0, 50, 100], needles: [{ at: 58 }], value: "348", unit: "MW" },
  偏差带仪: { shape: "half", segments: [{ from: 0, to: 45, tone: "secondary" }, { from: 45, to: 55, tone: "success" }, { from: 55, to: 100, tone: "warn" }], centerZero: true, needles: [{ at: 61 }], value: "+1.2", unit: "%" },
  多量程电: { shape: "half", segments: [{ from: 0, to: 90, tone: "accent" }], ticks: [0, 15, 30, 45, 60, 75, 90, 100], needles: [{ at: 74 }], value: "10.2", unit: "kV" },
  负荷分区: { shape: "half", segments: [{ from: 0, to: 40, tone: "secondary" }, { from: 40, to: 67, tone: "success" }, { from: 67, to: 100, tone: "danger" }], needles: [{ at: 78 }], value: "84", unit: "%" },
  液位双色: { shape: "half", segments: [{ from: 0, to: 48, tone: "secondary" }, { from: 48, to: 100, tone: "accent" }], ticks: [0, 100], needles: [{ at: 55 }], value: "4.2", unit: "m" },
  压差报警: { shape: "half", segments: [{ from: 0, to: 70, tone: "accent" }, { from: 70, to: 100, tone: "danger" }], ticks: [0, 50, 100], needles: [{ at: 88 }], value: "62", unit: "kPa" },
  宽域频率: { shape: "half", segments: [{ from: 48, to: 56, tone: "success" }], ticks: [5, 20, 35, 50, 65, 80, 95], needles: [{ at: 50 }], value: "49.9", unit: "Hz" },
  窄量浓度: { shape: "short", segments: [{ from: 0, to: 60, tone: "success" }, { from: 60, to: 100, tone: "danger" }], ticks: [0, 30, 60, 100], needles: [{ at: 71 }], value: "6.4", unit: "ppm" },
  舒适带湿: { shape: "half", segments: [{ from: 40, to: 70, tone: "success" }], ticks: [0, 40, 70, 100], needles: [{ at: 55 }], value: "55", unit: "%" },
  蒸汽饱和: { shape: "half", segments: [{ from: 0, to: 84, tone: "accent" }, { from: 84, to: 100, tone: "danger" }], guide: { at: 84, color: "var(--preview-secondary, currentColor)" }, needles: [{ at: 66 }], value: "1.8", unit: "MPa" },
  库存安全: { shape: "half", segments: [{ from: 0, to: 25, tone: "danger" }, { from: 25, to: 100, tone: "accent" }], guide: { at: 25, color: "var(--warning, #e8bd68)" }, needles: [{ at: 42 }], value: "42", unit: "%" },
  出力储备: { shape: "half", segments: [{ from: 0, to: 15, tone: "danger" }, { from: 15, to: 100, tone: "secondary" }], reversed: true, needles: [{ at: 22 }], value: "78", unit: "%" },
};

function GaugePreview() {
  const { preview } = useContext(PreviewMetadataContext);
  const dial = preview ? GAUGE_MARK_DIALS[preview.mark] : undefined;
  const arcId = useGradientId("gg");
  return (
    <PreviewShell variant="gauge">
      <svg viewBox="15 12 66 40" aria-hidden="true">
        {dial ? <GaugeDial {...dial} /> : <>
          <defs>
            <linearGradient id={arcId} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" className="stop-accent-strong" />
              <stop offset="1" className="stop-secondary-strong" />
            </linearGradient>
          </defs>
          <path className="gauge-track" d="M20 46A28 28 0 0 1 76 46" />
          <path className="gauge-value" stroke={`url(#${arcId})`} d="M20 46A28 28 0 0 1 76 46" />
          <g className="ticks"><circle cx="20" cy="46" r="1.5" /><circle cx="48" cy="18" r="1.5" /><circle cx="76" cy="46" r="1.5" /></g>
          <path className="needle" d="M48 46L60 31" />
          <circle className="hub" cx="48" cy="46" r="2.6" />
          <em>72<i>%</i></em>
        </>}
      </svg>
    </PreviewShell>
  );
}

function LiquidPreview() {
  return (
    <PreviewShell variant="liquid">
      <i>
        <b className="wave wave-a" />
        <b className="wave wave-b" />
      </i>
      <em>68%</em>
    </PreviewShell>
  );
}

function MapPreview() {
  const { preview } = useContext(PreviewMetadataContext);
  return (
    <PreviewShell variant="map">
      <DashboardMapPreviewGraphic mark={preview?.mark} />
    </PreviewShell>
  );
}

function TablePreview({ scrolling }: { scrolling: boolean }) {
  return (
    <PreviewShell variant={`table ${scrolling ? "scrolling" : ""}`}>
      <i className="thead" />
      <i className="row" />
      <i className="row striped" />
      <i className="row" />
      {scrolling && <i className="scrollbar" />}
    </PreviewShell>
  );
}

function MetricPreview({ type }: { type: "value" | "digital-flip" | "progress" | "status" }) {
  const sparkId = useGradientId("kp");
  if (type === "status") {
    return (
      <PreviewShell variant={`metric ${type}`}>
        <span className="status-dot" />
        <b className="status-label">运行中</b>
        <i className="status-sub" />
      </PreviewShell>
    );
  }
  if (type === "progress") {
    return (
      <PreviewShell variant={`metric ${type}`}>
        <b className="kpi">68<i className="unit">%</i></b>
        <span className="bar"><i style={{ width: "68%" }} /></span>
      </PreviewShell>
    );
  }
  if (type === "digital-flip") {
    return (
      <PreviewShell variant={`metric ${type}`}>
        <b className="kpi flip">1286</b>
        <span className="delta up">▲ 8.2%</span>
      </PreviewShell>
    );
  }
  return (
    <PreviewShell variant={`metric ${type}`}>
      <b className="kpi">86.4<i className="unit">万元</i></b>
      <span className="delta up">▲ 12.6%</span>
      <svg className="spark" viewBox="0 0 30 18" aria-hidden="true">
        <defs>
          <linearGradient id={sparkId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" className="stop-accent-strong" />
            <stop offset="1" className="stop-accent-ghost" />
          </linearGradient>
        </defs>
        <path className="spark-fill" d="M2 13L9 9 15 11 21 4 28 7 28 17 2 17Z" fill={`url(#${sparkId})`} />
        <path className="spark-line" d="M2 13L9 9 15 11 21 4 28 7" />
      </svg>
    </PreviewShell>
  );
}

function FilterPreview() {
  return (
    <PreviewShell variant="filter">
      <svg className="funnel-icon" viewBox="0 0 12 12" aria-hidden="true">
        <path d="M1.5 2.5H10.5M3 6H9M4.6 9.5H7.4" />
      </svg>
      <i>全部设备</i>
      <b className="chevron" />
    </PreviewShell>
  );
}

function RecordFormPreview() {
  return (
    <PreviewShell variant="record-form">
      <svg viewBox="0 0 96 64" aria-hidden="true">
        <g className="form-labels"><path d="M10 12H26M10 30H22" /></g>
        <rect className="form-field" x="10" y="15" width="66" height="9" rx="2.4" />
        <rect className="form-field field-focus" x="10" y="33" width="66" height="9" rx="2.4" />
        <rect className="form-submit" x="53" y="48" width="23" height="8" rx="2.4" />
        <path className="form-submit-label" d="M59 52H70" />
      </svg>
    </PreviewShell>
  );
}

function TextPreview() {
  return (
    <PreviewShell variant="text">
      <i className="title-bar" />
      <b>工业看板标题</b>
      <span className="line" />
      <span className="line short" />
    </PreviewShell>
  );
}

function ShapePreview() {
  return (
    <PreviewShell variant="shape">
      <i />
      <b />
      <span className="connector" />
    </PreviewShell>
  );
}

function DecorationPreview({ style }: { style: NonNullable<DecorationStyle> }) {
  return (
    <PreviewShell variant={`decoration decoration-${style}`}>
      <i /><b />
      {(style === "title" || style === "header-wing" || style === "scan" || style === "neon") && <em>SECTION 01</em>}
    </PreviewShell>
  );
}

function IconPreview({ icon }: { icon: React.ReactNode }) {
  return <PreviewShell variant="icon generic">{icon}<i /><b /></PreviewShell>;
}

/**
 * 媒体 / 3D / 拓扑类不再用裸图标占位，而是“渐变底 + 图形组合”的构图示意，
 * 让用户在插入前就能读出组件的视觉形态（对标山海鲸素材库质感）。
 */
function CompositionPreview({ kind }: { kind: "scene" | "topology" | "image" | "video" | "monitor" | "url" | "unity" }) {
  const topId = useGradientId("cp");
  const content = (() => {
    switch (kind) {
      case "scene":
      case "unity":
        return <>
          <defs>
            <linearGradient id={`${topId}t`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" className="stop-accent-strong" />
              <stop offset="1" className="stop-accent-mid" />
            </linearGradient>
            <linearGradient id={`${topId}l`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" className="stop-secondary-strong" />
              <stop offset="1" className="stop-secondary-ghost" />
            </linearGradient>
          </defs>
          <ellipse className="ground" cx="48" cy="50" rx="21" ry="4" />
          {kind === "unity" && <ellipse className="orbit" cx="48" cy="30" rx="26" ry="10" />}
          <g className="cube">
            <path className="face-top" fill={`url(#${topId}t)`} d="M48 12L63 20 48 28 33 20Z" />
            <path className="face-left" fill={`url(#${topId}l)`} d="M33 20L48 28V46L33 38Z" />
            <path className="face-right" d="M63 20L48 28V46L63 38Z" />
          </g>
        </>;
      case "topology":
        return <>
          <g className="edges"><path d="M48 28L25 15M48 28L73 13M48 28L21 44M48 28L72 45M25 15L73 13" /></g>
          <g className="halo"><circle cx="48" cy="28" r="9.5" /></g>
          <g className="nodes">
            <circle cx="25" cy="15" r="3" /><circle cx="73" cy="13" r="3" />
            <circle cx="21" cy="44" r="3" /><circle cx="72" cy="45" r="3" />
          </g>
          <g className="hub"><circle cx="48" cy="28" r="5.4" /><circle className="ring" cx="48" cy="28" r="9" /></g>
          <path className="link-active" d="M48 28L72 45" />
        </>;
      case "image":
        return <>
          <rect className="frame" x="15" y="10" width="66" height="44" rx="4" />
          <path className="photo" d="M17 46L36 25 47 37 59 24 79 46V51.5H17Z" />
          <circle className="sun" cx="68" cy="20" r="4" />
          <path className="photo-glint" d="M22 14L34 12" />
        </>;
      case "video":
        return <>
          <rect className="frame screen" x="16" y="9" width="64" height="40" rx="4" />
          <circle className="play-halo" cx="48" cy="29" r="11" />
          <circle className="play" cx="48" cy="29" r="8.4" />
          <path className="play-tri" d="M45.4 24.6L53.4 29 45.4 33.4Z" />
          <path className="progress-track" d="M20 53H76" />
          <path className="progress-fill" d="M20 53H50" />
          <circle className="playhead" cx="50" cy="53" r="2.2" />
        </>;
      case "monitor":
        return <>
          <g className="grid-cells">
            <rect x="15" y="9" width="31" height="20" rx="2.5" />
            <rect x="50" y="9" width="31" height="20" rx="2.5" />
            <rect x="15" y="33" width="31" height="20" rx="2.5" />
            <rect x="50" y="33" width="31" height="20" rx="2.5" />
          </g>
          <path className="cam-sweep" d="M55 14L72 24" />
          <g className="rec"><circle cx="76" cy="14" r="2.2" /></g>
          <path className="timeline" d="M19 54H60" />
        </>;
      case "url":
        return <>
          <rect className="frame" x="14" y="9" width="68" height="46" rx="4" />
          <path className="chrome-bar" d="M14 19H82" />
          <circle className="dot dot-a" cx="20" cy="14" r="1.6" />
          <circle className="dot dot-b" cx="25.5" cy="14" r="1.6" />
          <circle className="dot dot-c" cx="31" cy="14" r="1.6" />
          <rect className="addr" x="38" y="11.6" width="34" height="5" rx="2" />
          <rect className="hero" x="20" y="25" width="42" height="12" rx="2" />
          <path className="line" d="M20 43H66M20 49H52" />
        </>;
    }
  })();
  return <PreviewShell variant={`icon media composition composition-${kind}`}>
    <svg viewBox={COMPOSITION_VIEWBOX[kind]} aria-hidden="true">{content}</svg>
  </PreviewShell>;
}

/** 每类构图示意按主体收紧视窗,让图形放大占满瓷砖(山海鲸“模型居中构图”)。 */
const COMPOSITION_VIEWBOX: Record<"scene" | "topology" | "image" | "video" | "monitor" | "url" | "unity", string> = {
  scene: "24 6 50 52",
  unity: "18 4 58 54",
  topology: "14 7 68 46",
  image: "12 7 72 50",
  video: "13 6 70 52",
  monitor: "12 6 72 52",
  url: "11 6 74 52",
};
