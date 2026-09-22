import { PreviewShell, MiniLegend, AreaGradientDef } from "./dashboardPreviewShared";
import { useDashboardPreviewGradientId as useGradientId } from "./dashboardComponentPreviewSvg";

const TREND_PRIMARY = "M12 38L26 30 40 33 54 18 68 24 90 10";
const TREND_SECONDARY = "M12 31L26 35 40 24 54 28 68 15 90 16";
const TREND_DOTS: ReadonlyArray<readonly [number, number]> = [[26, 30], [54, 18], [90, 10]];

export function TrendPreview({ type }: { type: "line" | "area" | "combo" }) {
  const fillId = useGradientId("tg");
  return (
    <PreviewShell variant={`trend ${type}`}>
      {/* 外部参考图表缩略图规范:无轴线、无网格、无标签,纯净图形本体放大居中。 */}
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

export function ScatterPreview() {
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

export function RadarPreview() {
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

export function GraphPreview() {
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

export function SankeyPreview() {
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

export function BarPreview() {
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

export function RankPreview() {
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
