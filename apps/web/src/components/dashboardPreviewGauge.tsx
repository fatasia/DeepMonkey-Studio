import { useContext } from "react";
import { PreviewMetadataContext, PreviewShell } from "./dashboardPreviewShared";
import { useDashboardPreviewGradientId as useGradientId } from "./dashboardComponentPreviewSvg";

/**
 * 仪表阈值族的 mark 构图表:同 type(gauge)下每款量程、刻度与色带构图可辨
 * (外部参考缩略图规范:无轴线无网格、净化 SVG、零新 CSS 类)。
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

export function GaugePreview() {
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
