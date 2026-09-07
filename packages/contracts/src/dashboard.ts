import type { JsonValue } from "./application.js";
import type { DirectBindingSpec } from "./directBinding.js";

/** 2D 看板组件、分析、报表与条件样式合同。 */
export type SceneDashboardSide = "left" | "right";
export type SceneDashboardWidgetType =
  | "text"
  | "shape"
  | "decoration"
  | "value"
  | "digital-flip"
  | "liquid-fill"
  | "progress"
  | "status"
  | "gauge"
  | "line"
  | "area"
  | "bar"
  | "combo"
  | "pie"
  | "scatter"
  | "radar"
  | "funnel"
  | "sankey"
  | "sunburst"
  | "treemap"
  | "graph"
  | "map"
  | "rank"
  | "table"
  | "scroll-table"
  | "filter"
  | "image"
  | "video"
  | "monitor"
  | "url"
  | "unity"
  | "topology";

export type DashboardAggregation = "none" | "count" | "distinct-count" | "sum" | "average" | "minimum" | "maximum";
export interface DashboardCalculatedField {
  key: string;
  label: string;
  formula: string;
}
export interface DashboardAnalysisConfig {
  dimensionField?: string;
  /** Ordered drill hierarchy, for example province -> city -> site. */
  drillFields?: string[];
  seriesField?: string;
  measureField?: string;
  aggregation: DashboardAggregation;
  calculatedFields?: DashboardCalculatedField[];
  sort?: "none" | "dimension-asc" | "dimension-desc" | "value-asc" | "value-desc";
  limit?: number;
}
export interface DashboardReportConfig {
  mode: "detail" | "grouped" | "crosstab";
  rowField?: string;
  columnField?: string;
  valueField?: string;
  /** Multiple measures rendered side by side in grouped and crosstab reports. `valueField` remains the single-value compatibility fallback. */
  valueFields?: string[];
  aggregation?: DashboardAggregation;
  pageSize?: number;
  /** Add per-row totals to crosstab reports. */
  showSubtotal?: boolean;
  showGrandTotal?: boolean;
  /** Keep the first business column visible while horizontally scrolling wide reports. */
  freezeFirstColumn?: boolean;
  /** Display stable 1-based row numbers in the current report result. */
  showRowNumbers?: boolean;
  /** Improve dense detail-table scanning. */
  stripedRows?: boolean;
  /** Formatting applied to numeric report cells. */
  valueFormat?: "auto" | "number" | "percent" | "currency" | undefined;
  decimalPlaces?: number;
  currency?: string;
}
export interface DashboardConditionalRule {
  id: string;
  field?: string;
  operator: "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "contains" | "between";
  value: string | number | boolean;
  valueTo?: number;
  color?: string;
  backgroundColor?: string;
  fontWeight?: number;
  visible?: boolean;
  animation?: "none" | "pulse";
}
export interface DashboardMapConfig {
  geoJsonUrl?: string;
  mapName?: string;
  regionField?: string;
  valueField?: string;
  longitudeField?: string;
  latitudeField?: string;
  mode?: "region" | "scatter" | "heat" | "route";
}

export interface DashboardChartConfig {
  /** Stack cartesian series with the same axis. */
  stacked?: boolean;
  /** Show the chart legend; useful for grouped and combination analysis. */
  showLegend?: boolean;
  /** Show values directly on bars/lines. */
  showDataLabels?: boolean;
  /** In a combo chart these named series render as lines on the right value axis. The last series is used when omitted. */
  secondaryAxisSeries?: string[];
}

export interface SceneDashboardWidgetState {
  id: string;
  title: string;
  key: string;
  type: SceneDashboardWidgetType;
  unit: string;
  x: number;
  y: number;
  w: number;
  h: number;
  min?: number;
  max?: number;
  color?: string;
  backgroundColor?: string;
  backgroundOpacity?: number;
  /** Container background, independent from an image widget's own imageUrl. */
  componentBackgroundImageUrl?: string;
  componentBackgroundImageName?: string;
  componentBackgroundImageFit?: "cover" | "contain" | "stretch" | "original";
  componentBackgroundImagePosition?: "center" | "top" | "bottom" | "left" | "right";
  componentBackgroundImageRepeat?: boolean;
  textColor?: string;
  datasetId?: string;
  pipelineId?: string;
  directBinding?: DirectBindingSpec;
  sampleData?: import("./dashboardSampleData.js").DashboardSampleData;
  /** 引用已确认的语义口径版本；版本变化必须重新确认，不静默漂移。 */
  semanticBinding?: {
    modelId: string;
    revision: number;
    metricKey?: string;
    dimensionKey?: string;
    parameterKey?: string;
    autoLink?: boolean;
  };
  field?: string;
  analysis?: DashboardAnalysisConfig;
  report?: DashboardReportConfig;
  conditionalRules?: DashboardConditionalRule[];
  map?: DashboardMapConfig;
  chart?: DashboardChartConfig;
  url?: string;
  /** Hosted Unity WebGL player URL. The player must include the Deep Monkey Studio Unity bridge. */
  unityUrl?: string;
  /** Project-managed Unity build selected in Studio. */
  unityResourceId?: string;
  unityResourceVersionId?: string;
  /** Optional reusable build manifest that can supply player URL, scenes, events and data-layer declarations. */
  unityManifestUrl?: string;
  /** Informational Unity editor/player version. Compatibility is governed by unityBridgeVersion, not this label. */
  unityVersion?: string;
  /** Version of the host/player messaging contract implemented by the Unity build. */
  unityBridgeVersion?: number;
  unityAllowedOrigin?: string;
  unityScene?: string;
  unityScenes?: string[];
  unityEventNames?: string[];
  /** Maps a Studio data key to a manifest data layer. */
  unityDataBindings?: Array<{ dataKey: string; layerKey: string }>;
  /** Default object action exposed by the imported Unity build. */
  unityDefaultAction?: { action: string; objectId?: string };
  /** Values for manifest-declared Unity properties, keyed by property key. */
  unityPropertyValues?: Record<string, JsonValue>;
  imageUrl?: string;
  assetId?: string;
  imageFit?: "cover" | "contain" | "fill";
  videoUrl?: string;
  videoFit?: "cover" | "contain" | "fill";
  videoAutoplay?: boolean;
  videoMuted?: boolean;
  /** 关闭时媒体播放一次并停在结尾。 */
  videoLoop?: boolean;
  monitorProtocol?: "hls" | "webrtc";
  monitorSourceUrl?: string;
  topologyId?: string;
  content?: string;
  shape?: "rectangle" | "rounded" | "ellipse" | "line";
  decorationStyle?: "title" | "border" | "divider" | "corner" | "neon" | "bracket" | "segment" | "scan" | "dots" | "diagonal" | "header-wing" | "frame-notch";
  options?: string[];
  filterMode?: "select" | "multi-select" | "text" | "date";
  filterMatch?: "exact" | "contains";
  /** Filter widgets publish this parameter across all dashboard pages. */
  filterField?: string;
  /** Optional parent parameter; the control stays disabled until the parent has a value. */
  parentFilterKey?: string;
  /** Write the clicked chart/table/ranking value to this shared dashboard parameter. */
  linkageParameterKey?: string;
  borderColor?: string;
  borderWidth?: number;
  fontSize?: number;
  fontWeight?: number;
  textAlign?: "left" | "center" | "right";
  designState?: "auto" | "empty" | "loading" | "partial" | "error" | "forbidden";
  animation?: "none" | "fade" | "slide-up" | "scale" | "pulse";
  /** 进入预览后是否立即启动组件动画；关闭后组件保持静态，便于脚本或交互接管。 */
  animationAutoplay?: boolean;
  /** 关闭时仅播放一次并停在末帧。 */
  animationLoop?: boolean;
  animationDuration?: number;
  animationDelay?: number;
}

export interface SceneDashboardState {
  side: SceneDashboardSide;
  width: number;
  backgroundColor?: string;
  backgroundOpacity?: number;
  blur?: number;
  borderRadius?: number;
  widgets: SceneDashboardWidgetState[];
}
