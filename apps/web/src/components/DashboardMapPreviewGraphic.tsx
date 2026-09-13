import { useDashboardPreviewGradientId } from "./dashboardComponentPreviewSvg";

/**
 * 区域地图族的 mark 构图表:8 种制图形态(填色/气泡/飞线/热力/钻取/标注/管线/路网)
 * 在缩略图阶段即可辨认;运行时仍以 map 合同的 region/scatter/heat/route 模式渲染。
 * 轨迹与密度两类分析增强地图复用 flow / heat 构图。
 */
type MapMarkVariant = "choropleth" | "bubble" | "flow" | "heat" | "drill" | "annotation" | "pipe" | "road";

const MAP_MARK_VARIANTS: Readonly<Record<string, MapMarkVariant>> = {
  分省产值: "choropleth", 分省能耗: "choropleth",
  城市产值: "bubble", 城市负荷: "bubble",
  飞线流向: "flow", 人口迁徙: "flow", 运动轨迹: "flow",
  栅格热力: "heat", 街区热力: "heat", 密度热力: "heat",
  行政边界: "drill", 城市边界: "drill",
  园区平面: "annotation", 场站布局: "annotation",
  管线走向: "pipe", 廊道管线: "pipe",
  路网密度: "road", 轨道密度: "road",
  // 波次 F 地图变体:钻取增强走 drill、平面标注走 annotation、管廊轨迹走 pipe/flow、路网与人群热力走 heat/road。
  县域经济: "drill", 街道网格: "drill", 区域销售: "drill",
  厂区安全: "annotation", 校园能耗: "annotation",
  综合管廊: "pipe", 燃气管网: "pipe",
  快速路车: "road", 公交线网: "heat",
  危化品运: "flow", "AGV 巡检": "flow",
  人群聚集: "heat",
};

/** 底图轮廓,8 种形态共用,保证组内构图一致、组间差异聚焦在制图语义上。 */
const MAP_LANDMARK = "M12 22L26 11 42 15 53 9 76 19 71 33 57 36 49 51 28 46 16 37Z";

/** 变体底图统一淡填充:与默认构图的 ghost 渐变保持同等分量。 */
function MapBaseLand() {
  return <path className="land" d={MAP_LANDMARK} style={{ fill: "var(--preview-accent, currentColor)", fillOpacity: 0.06 }} />;
}

function MapMarkGraphic({ variant }: { variant: MapMarkVariant }) {
  const accent = "var(--preview-accent, currentColor)";
  const secondary = "var(--preview-secondary, currentColor)";
  const landId = useDashboardPreviewGradientId("mv");
  if (variant === "choropleth") {
    return <>
      <defs>
        <linearGradient id={landId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" className="stop-accent-strong" />
          <stop offset="1" className="stop-accent-ghost" />
        </linearGradient>
      </defs>
      <path className="land" fill={`url(#${landId})`} d={MAP_LANDMARK} />
      {/* 分级填色:三个子区按值深浅着色,表达 choropleth 分级语义 */}
      <path d="M26 11L42 15 40 29 27 26Z" style={{ fill: accent, fillOpacity: 0.72 }} stroke={secondary} strokeWidth=".7" />
      <path d="M42 15L53 9 71 22 57 30 40 29Z" style={{ fill: accent, fillOpacity: 0.34 }} stroke={secondary} strokeWidth=".7" />
      <path d="M27 26L40 29 49 44 28 46 16 37Z" style={{ fill: accent, fillOpacity: 0.55 }} stroke={secondary} strokeWidth=".7" />
    </>;
  }
  if (variant === "bubble") {
    return <>
      <MapBaseLand />
      <circle cx="31" cy="23" r="7.5" style={{ fill: accent, fillOpacity: 0.5 }} stroke={accent} strokeWidth="1" />
      <circle cx="58" cy="24" r="4.6" style={{ fill: secondary, fillOpacity: 0.5 }} stroke={secondary} strokeWidth="1" />
      <circle cx="45" cy="37" r="2.8" className="hot hot-dim" />
      <circle className="hot-ring" cx="31" cy="23" r="9.5" />
    </>;
  }
  if (variant === "flow") {
    const flowId = useDashboardPreviewGradientId("mf");
    return <>
      <defs>
        <linearGradient id={flowId} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" style={{ stopColor: secondary, stopOpacity: 0.1 }} />
          <stop offset="1" className="stop-accent-strong" />
        </linearGradient>
      </defs>
      <MapBaseLand />
      <path d="M31 23C46 18 56 18 66 16" stroke={`url(#${flowId})`} strokeWidth="2.4" fill="none" strokeLinecap="round" />
      <path d="M31 23C44 32 55 33 63 38" stroke={`url(#${flowId})`} strokeWidth="1.6" fill="none" strokeLinecap="round" opacity=".85" />
      <circle className="hot hot-pulse" cx="31" cy="23" r="2.6" />
      <circle className="hot" cx="66" cy="16" r="2.2" />
      <circle className="hot hot-dim" cx="63" cy="38" r="2" />
    </>;
  }
  if (variant === "heat") {
    return <>
      <MapBaseLand />
      <g opacity=".85">
        <circle cx="34" cy="24" r="9" style={{ fill: accent, fillOpacity: 0.16 }} />
        <circle cx="34" cy="24" r="5.5" style={{ fill: accent, fillOpacity: 0.3 }} />
        <circle cx="34" cy="24" r="2.8" style={{ fill: accent, fillOpacity: 0.62 }} />
        <circle cx="56" cy="30" r="7" style={{ fill: secondary, fillOpacity: 0.2 }} />
        <circle cx="56" cy="30" r="3.6" style={{ fill: secondary, fillOpacity: 0.42 }} />
        <circle cx="46" cy="40" r="4.5" style={{ fill: accent, fillOpacity: 0.22 }} />
      </g>
    </>;
  }
  if (variant === "drill") {
    return <>
      <MapBaseLand />
      {/* 选中子区高亮 + 兄弟子区虚线,表达逐级下钻 */}
      <path d="M26 11L42 15 40 29 27 26Z" style={{ fill: accent, fillOpacity: 0.6 }} stroke={accent} strokeWidth="1.1" />
      <path d="M42 15L53 9 71 22 57 30 40 29Z" fill="none" stroke={secondary} strokeWidth=".8" strokeDasharray="2.4 2" />
      <path d="M27 26L40 29 49 44 28 46 16 37Z" fill="none" stroke={secondary} strokeWidth=".8" strokeDasharray="2.4 2" />
      <circle cx="33" cy="20" r="1.8" className="hot hot-pulse" />
    </>;
  }
  if (variant === "annotation") {
    return <>
      <MapBaseLand />
      <path d="M31 23L20 12M31 23L46 13" stroke={secondary} strokeWidth=".7" opacity=".8" />
      <rect x="14" y="7" width="7" height="4" rx="1" style={{ fill: secondary, fillOpacity: 0.55 }} />
      <rect x="45" y="9" width="7" height="4" rx="1" style={{ fill: secondary, fillOpacity: 0.55 }} />
      <circle className="hot hot-pulse" cx="31" cy="23" r="2.4" />
      <circle className="hot" cx="58" cy="24" r="2" />
      <circle className="hot hot-dim" cx="45" cy="37" r="1.8" />
    </>;
  }
  if (variant === "pipe") {
    return <>
      <MapBaseLand />
      {/* 管线双线 + 泵站/阀门节点 */}
      {/* 管线双线 + 泵站/阀门节点 */}
      <path d="M14 34C28 30 38 22 52 20 62 18.6 70 14 78 12" stroke={accent} strokeWidth="3.4" fill="none" strokeLinecap="round" opacity=".55" />
      <path d="M14 34C28 30 38 22 52 20 62 18.6 70 14 78 12" stroke={secondary} strokeWidth="1.1" fill="none" strokeLinecap="round" strokeDasharray="4 3" />
      <circle cx="52" cy="20" r="2.6" style={{ fill: accent }} stroke="var(--lib-tile-border, #172126)" strokeWidth=".8" />
      <circle cx="78" cy="12" r="2.2" className="hot hot-pulse" />
    </>;
  }
  // 路网密度:细线路网 + 拥堵高亮段
  return <>
    <MapBaseLand />
    <g stroke={secondary} strokeWidth=".8" fill="none" opacity=".65">
      <path d="M14 30L82 24M18 40L78 34M28 12L40 48M52 10L58 48" />
    </g>
    <path d="M14 30L82 24" stroke={accent} strokeWidth="2" fill="none" strokeLinecap="round" />
    <path d="M40 48L52 10" stroke="var(--danger, #e06a5f)" strokeWidth="2" fill="none" strokeLinecap="round" opacity=".9" />
    <circle className="hot hot-pulse" cx="48" cy="26" r="2.4" />
  </>;
}

export function DashboardMapPreviewGraphic({ mark }: { mark: string | undefined }) {
  const markVariant = mark ? MAP_MARK_VARIANTS[mark] : undefined;
  const landId = useDashboardPreviewGradientId("mp");
  return (
    <svg viewBox="8 5 74 50" aria-hidden="true">
      {markVariant ? <MapMarkGraphic variant={markVariant} /> : <>
        <defs>
          <linearGradient id={landId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" className="stop-accent-mid" />
            <stop offset="1" className="stop-accent-ghost" />
          </linearGradient>
        </defs>
        <g className="graticule"><path d="M12 22H90M12 38H90M30 6V58M60 6V58" /></g>
        <path className="land" fill={`url(#${landId})`} d={MAP_LANDMARK} />
        <path className="route" d="M31 23C42 31 50 34 58 24" />
        <g className="hotspots">
          <circle className="hot-ring" cx="31" cy="23" r="6.2" />
          <circle className="hot hot-pulse" cx="31" cy="23" r="2.6" />
          <circle className="hot" cx="58" cy="24" r="3.1" />
          <circle className="hot hot-dim" cx="45" cy="37" r="2.2" />
        </g>
      </>}
    </svg>
  );
}
