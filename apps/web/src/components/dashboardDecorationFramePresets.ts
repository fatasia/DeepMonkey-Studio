import type { DashboardComponentPreset } from "./dashboardComponentPresetTypes";
import { decorationPreset } from "./dashboardComponentPresetFactory";

export const DASHBOARD_DECORATION_FRAME_PRESETS: readonly DashboardComponentPreset[] = [
  decorationPreset({ id: "notched-frame", zh: "缺口组件边框", en: "Notched component frame", descriptionZh: "叠放在标准图表下方形成工业边界", family: "frame", mark: "CHART", style: "frame-notch", content: "", width: 520, height: 280 }),
  decorationPreset({ id: "corner-frame", zh: "四角定位边框", en: "Corner frame", descriptionZh: "弱化边线并强调四角定位", family: "frame", mark: "FOCUS", style: "corner", content: "", width: 460, height: 260 }),
  decorationPreset({ id: "metric-card-frame", zh: "指标卡容器", en: "Metric card frame", descriptionZh: "包裹单个核心指标并保留标题位", family: "frame", mark: "KPI", style: "border", content: "核心指标", width: 280, height: 150 }),
  decorationPreset({ id: "wide-chart-frame", zh: "宽幅趋势边框", en: "Wide chart frame", descriptionZh: "承载长时间轴趋势和组合图", family: "frame", mark: "TREND", style: "frame-notch", content: "", width: 720, height: 320, color: "#688f9c" }),
  decorationPreset({ id: "ranking-panel-frame", zh: "排行列表边框", en: "Ranking panel frame", descriptionZh: "承载纵向排行和滚动列表", family: "frame", mark: "TOP", style: "bracket", content: "", width: 380, height: 420 }),
  decorationPreset({ id: "report-table-frame", zh: "报表表格边框", en: "Report table frame", descriptionZh: "承载宽表与分页工具区", family: "frame", mark: "TABLE", style: "border", content: "", width: 760, height: 420, color: "#667d87" }),
  decorationPreset({ id: "map-panel-frame", zh: "地图点位边框", en: "Map panel frame", descriptionZh: "为 GIS 地图保留图例和缩放区", family: "frame", mark: "GIS", style: "corner", content: "", width: 680, height: 440, color: "#5f8fa0" }),
  decorationPreset({ id: "topology-panel-frame", zh: "拓扑画布边框", en: "Topology panel frame", descriptionZh: "包裹工艺或网络拓扑画布", family: "frame", mark: "NET", style: "frame-notch", content: "", width: 680, height: 420, color: "#6b98a6" }),
  decorationPreset({ id: "video-monitor-frame", zh: "视频监控边框", en: "Video monitor frame", descriptionZh: "适配 16:9 视频与摄像头监控", family: "frame", mark: "CAM", style: "neon", content: "", width: 480, height: 270, color: "#668f9d" }),
  decorationPreset({ id: "alarm-panel-frame", zh: "告警列表边框", en: "Alarm panel frame", descriptionZh: "强调告警列表和待处置区域", family: "frame", mark: "ALARM", style: "neon", content: "", width: 460, height: 360, color: "#d36f68" }),
  decorationPreset({ id: "maintenance-card-frame", zh: "维护工单边框", en: "Maintenance card frame", descriptionZh: "承载维护建议和工单摘要", family: "frame", mark: "MRO", style: "bracket", content: "", width: 420, height: 240, color: "#9a9c6a" }),
  decorationPreset({ id: "energy-panel-frame", zh: "能源分析边框", en: "Energy panel frame", descriptionZh: "用于能耗、碳排和流向分析区", family: "frame", mark: "ENERGY", style: "corner", content: "", width: 560, height: 320, color: "#69a982" }),
  decorationPreset({ id: "compact-status-frame", zh: "紧凑状态边框", en: "Compact status frame", descriptionZh: "排列多个设备状态和联锁信号", family: "frame", mark: "STATE", style: "border", content: "", width: 220, height: 112, color: "#71858c" }),
  decorationPreset({ id: "comparison-frame", zh: "左右对比边框", en: "Comparison frame", descriptionZh: "用于计划实绩或方案前后对比", family: "frame", mark: "A/B", style: "bracket", content: "", width: 620, height: 300 }),
  decorationPreset({ id: "full-width-section-frame", zh: "全宽分区边框", en: "Full-width section frame", descriptionZh: "划分横跨页面的业务大区", family: "frame", mark: "ZONE", style: "frame-notch", content: "", width: 1080, height: 340, color: "#596f78" }),
  decorationPreset({ id: "focus-object-frame", zh: "重点对象聚焦框", en: "Focus object frame", descriptionZh: "突出当前选中的设备或区域", family: "frame", mark: "FOCUS", style: "neon", content: "重点关注", width: 360, height: 220, color: "#d6b65f", widget: { animation: "pulse", animationAutoplay: true, animationLoop: true } }),
] as const;

