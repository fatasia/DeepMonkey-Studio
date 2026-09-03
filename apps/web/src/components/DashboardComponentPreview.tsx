import {
  Box,
  Image,
  MonitorPlay,
  Network,
  Play,
  Shapes,
  SquareCode,
} from "lucide-react";
import type { DashboardDataWidgetConfig, SceneDashboardWidgetType } from "@bim-studio/contracts";
import { createContext, useContext, type CSSProperties } from "react";
import type { DashboardComponentPresetPreview } from "./dashboardComponentPresetTypes";

type PreviewType = SceneDashboardWidgetType | "scene";
type DecorationStyle = DashboardDataWidgetConfig["decorationStyle"];

interface DashboardComponentPreviewProps {
  type: PreviewType;
  decorationStyle?: DecorationStyle;
  preview?: DashboardComponentPresetPreview;
}

const PreviewMetadataContext = createContext<DashboardComponentPresetPreview | undefined>(undefined);

/** 素材预览必须表达真实图形语义，避免用户插入后才发现组件类型不符。 */
export function DashboardComponentPreview({ type, decorationStyle, preview }: DashboardComponentPreviewProps) {
  return <PreviewMetadataContext.Provider value={preview}>
    <DashboardComponentPreviewGraphic type={type} decorationStyle={decorationStyle} />
  </PreviewMetadataContext.Provider>;
}

function DashboardComponentPreviewGraphic({ type, decorationStyle }: Omit<DashboardComponentPreviewProps, "preview">) {
  if (type === "line" || type === "area" || type === "combo") return <TrendPreview type={type} />;
  if (type === "scatter") return <ScatterPreview />;
  if (type === "radar") return <RadarPreview />;
  if (type === "graph") return <GraphPreview />;
  if (type === "sankey") return <SankeyPreview />;
  if (type === "bar" || type === "rank") return <BarPreview horizontal={type === "rank"} />;
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
  if (type === "text") return <TextPreview />;
  if (type === "shape") return <ShapePreview />;
  if (type === "decoration") return <DecorationPreview style={decorationStyle ?? "title"} />;
  if (type === "scene") return <IconPreview className="scene" icon={<Box size={25} />} />;
  if (type === "topology") return <IconPreview className="topology" icon={<Network size={25} />} />;
  if (type === "image") return <IconPreview className="media image" icon={<Image size={24} />} />;
  if (type === "video") return <IconPreview className="media video" icon={<Play size={23} />} />;
  if (type === "monitor") return <IconPreview className="media monitor" icon={<MonitorPlay size={24} />} />;
  if (type === "url") return <IconPreview className="media url" icon={<SquareCode size={24} />} />;
  if (type === "unity") return <IconPreview className="media unity" icon={<Box size={24} />} />;
  return <IconPreview className="generic" icon={<Shapes size={22} />} />;
}

function PreviewShell({ variant, children }: { variant: string; children: React.ReactNode }) {
  const preview = useContext(PreviewMetadataContext);
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
    {preview && <small className="dashboard-library-preview-mark">{preview.mark}</small>}
  </span>;
}

function TrendPreview({ type }: { type: "line" | "area" | "combo" }) {
  return (
    <PreviewShell variant={`trend ${type}`}>
      <svg viewBox="0 0 84 48" aria-hidden="true">
        {type === "area" && <path className="area-fill" d="M5 38L5 34L20 27L35 31L50 13L65 20L79 8L79 38Z" />}
        {type === "combo" && <g className="combo-bars"><rect x="9" y="25" width="9" height="13" /><rect x="29" y="18" width="9" height="20" /><rect x="49" y="23" width="9" height="15" /><rect x="69" y="11" width="9" height="27" /></g>}
        <path className="primary" d="M5 34L20 27L35 31L50 13L65 20L79 8" />
        {type === "line" && <path className="secondary" d="M5 28L20 32L35 20L50 25L65 13L79 16" />}
      </svg>
    </PreviewShell>
  );
}

function ScatterPreview() {
  return (
    <PreviewShell variant="scatter">
      <svg viewBox="0 0 84 48" aria-hidden="true">
        <path className="axis" d="M8 6V40H79" />
        {["16,31,2", "24,25,3", "35,29,2", "43,18,3", "54,22,2", "62,11,3", "72,15,2"].map((point) => {
          const [cx, cy, r] = point.split(",");
          return <circle key={point} cx={cx} cy={cy} r={r} />;
        })}
      </svg>
    </PreviewShell>
  );
}

function RadarPreview() {
  return (
    <PreviewShell variant="radar">
      <svg viewBox="0 0 84 48" aria-hidden="true">
        <path className="grid" d="M42 5L70 20L59 43H25L14 20ZM42 13L60 22L53 35H31L24 22Z" />
        <path className="value" d="M42 9L62 21L53 38L28 34L21 22Z" />
      </svg>
    </PreviewShell>
  );
}

function GraphPreview() {
  return (
    <PreviewShell variant="graph">
      <svg viewBox="0 0 84 48" aria-hidden="true">
        <path d="M18 29L38 13L58 20L69 36M38 13L44 36M18 29L44 36L69 36" />
        <g>{[[18, 29], [38, 13], [58, 20], [44, 36], [69, 36]].map(([cx, cy]) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="4" />)}</g>
      </svg>
    </PreviewShell>
  );
}

function SankeyPreview() {
  return (
    <PreviewShell variant="sankey">
      <svg viewBox="0 0 84 48" aria-hidden="true">
        <path className="flow primary" d="M12 13C34 13 30 32 52 32S66 19 76 19" />
        <path className="flow secondary" d="M12 34C31 34 35 17 52 17S65 34 76 34" />
        <path className="node" d="M9 8V38M52 12V38M78 13V40" />
      </svg>
    </PreviewShell>
  );
}

function BarPreview({ horizontal }: { horizontal: boolean }) {
  return (
    <PreviewShell variant={horizontal ? "rank-bars" : "bars"}>
      <i /><i /><i /><i />
    </PreviewShell>
  );
}

function FunnelPreview() {
  return <PreviewShell variant="funnel"><i /><i /><i /><i /></PreviewShell>;
}

function TreemapPreview() {
  return <PreviewShell variant="treemap"><i /><i /><i /><i /><i /></PreviewShell>;
}

function RingPreview({ nested }: { nested: boolean }) {
  return <PreviewShell variant={nested ? "ring sunburst" : "ring pie"}><i /><b /></PreviewShell>;
}

function GaugePreview() {
  return <PreviewShell variant="gauge"><i /><b /><em>72</em></PreviewShell>;
}

function LiquidPreview() {
  return <PreviewShell variant="liquid"><i><b /></i><em>68%</em></PreviewShell>;
}

function MapPreview() {
  return (
    <PreviewShell variant="map">
      <svg viewBox="0 0 84 48" aria-hidden="true">
        <path d="M11 16L24 7L39 11L50 6L73 15L68 28L55 31L47 42L27 38L17 30Z" />
        <circle cx="30" cy="19" r="2.5" /><circle cx="54" cy="20" r="3" /><circle cx="43" cy="32" r="2" />
      </svg>
    </PreviewShell>
  );
}

function TablePreview({ scrolling }: { scrolling: boolean }) {
  return <PreviewShell variant={`table ${scrolling ? "scrolling" : ""}`}><i /><i /><i /><i /></PreviewShell>;
}

function MetricPreview({ type }: { type: "value" | "digital-flip" | "progress" | "status" }) {
  return (
    <PreviewShell variant={`metric ${type}`}>
      {type === "status" && <span />}
      <b>{type === "status" ? "运行" : "86.4"}</b>
      <i />
    </PreviewShell>
  );
}

function FilterPreview() {
  return <PreviewShell variant="filter"><i>全部设备</i><b>⌄</b></PreviewShell>;
}

function TextPreview() {
  return <PreviewShell variant="text"><b>工业看板标题</b><i /><i /></PreviewShell>;
}

function ShapePreview() {
  return <PreviewShell variant="shape"><i /><b /></PreviewShell>;
}

function DecorationPreview({ style }: { style: NonNullable<DecorationStyle> }) {
  return (
    <PreviewShell variant={`decoration decoration-${style}`}>
      <i /><b />
      {(style === "title" || style === "header-wing" || style === "scan" || style === "neon") && <em>SECTION 01</em>}
    </PreviewShell>
  );
}

function IconPreview({ className, icon }: { className: string; icon: React.ReactNode }) {
  return <PreviewShell variant={`icon ${className}`}>{icon}<i /><b /></PreviewShell>;
}
