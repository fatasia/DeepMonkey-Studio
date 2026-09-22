import { Shapes } from "lucide-react";
import type { DashboardDataWidgetConfig, SceneDashboardWidgetType } from "@bim-studio/contracts";
import type { DashboardComponentPresetPreview } from "./dashboardComponentPresetTypes";
import { PreviewMetadataContext, PreviewShell } from "./dashboardPreviewShared";
import { TrendPreview, ScatterPreview, RadarPreview, GraphPreview, SankeyPreview, BarPreview, RankPreview } from "./dashboardPreviewTrends";
import { WordcloudPreview, BoxplotPreview, WaterfallPreview, PolarBarPreview, FunnelPreview, TreemapPreview, RingPreview } from "./dashboardPreviewDistributions";
import { GaugePreview } from "./dashboardPreviewGauge";
import { LiquidPreview, MapPreview, TablePreview, MetricPreview, FilterPreview, RecordFormPreview, TextPreview, ShapePreview, DecorationPreview } from "./dashboardPreviewControls";
import { CompositionPreview } from "./dashboardPreviewComposition";

type PreviewType = SceneDashboardWidgetType | "scene";
type DecorationStyle = DashboardDataWidgetConfig["decorationStyle"];

interface DashboardComponentPreviewProps {
  type: PreviewType;
  decorationStyle?: DecorationStyle;
  preview?: DashboardComponentPresetPreview;
  showMark?: boolean;
}


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

function IconPreview({ icon }: { icon: React.ReactNode }) {
  return <PreviewShell variant="icon generic">{icon}<i /><b /></PreviewShell>;
}
