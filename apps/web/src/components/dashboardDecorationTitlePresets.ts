import type { DashboardComponentPreset } from "./dashboardComponentPresetTypes";
import { decorationPreset } from "./dashboardComponentPresetFactory";

export const DASHBOARD_DECORATION_TITLE_PRESETS: readonly DashboardComponentPreset[] = [
  decorationPreset({ id: "section-title", zh: "机械分区标题", en: "Mechanical section title", descriptionZh: "划分看板主要业务区域", family: "title", mark: "SEC", style: "header-wing", content: "分区标题", width: 420, height: 72 }),
  decorationPreset({ id: "bracket-title", zh: "括号业务标题", en: "Bracket title", descriptionZh: "标识紧凑业务分组", family: "title", mark: "[01]", style: "bracket", content: "业务分组", width: 360, height: 64 }),
  decorationPreset({ id: "plant-overview-title", zh: "厂级运营标题", en: "Plant operations title", descriptionZh: "用于厂级运营总览页首", family: "title", mark: "PLANT", style: "title", content: "厂级运营总览", width: 620, height: 76 }),
  decorationPreset({ id: "workshop-title", zh: "车间态势标题", en: "Workshop status title", descriptionZh: "用于车间态势分区页首", family: "title", mark: "SHOP", style: "header-wing", content: "车间运行态势", width: 520, height: 72, color: "#66a9b8" }),
  decorationPreset({ id: "energy-title", zh: "能源管理标题", en: "Energy title", descriptionZh: "用于能源与碳管理主题区", family: "title", mark: "ENERGY", style: "title", content: "能源与碳管理", width: 520, height: 72, color: "#69ad87" }),
  decorationPreset({ id: "safety-title", zh: "安全态势标题", en: "Safety title", descriptionZh: "用于安全与应急主题区", family: "title", mark: "SAFE", style: "neon", content: "安全运行态势", width: 500, height: 72, color: "#e7b85f" }),
  decorationPreset({ id: "logistics-title", zh: "物流调度标题", en: "Logistics title", descriptionZh: "用于仓储物流与车辆调度区", family: "title", mark: "LOGI", style: "header-wing", content: "物流调度中心", width: 520, height: 72, color: "#719bb2" }),
  decorationPreset({ id: "maintenance-title", zh: "维护中心标题", en: "Maintenance title", descriptionZh: "用于预测维护和工单主题区", family: "title", mark: "MRO", style: "bracket", content: "设备维护中心", width: 480, height: 68, color: "#a6a973" }),

  decorationPreset({ id: "live-status-badge", zh: "实时数据角标", en: "Live data badge", descriptionZh: "标识当前区域使用实时数据", family: "badge", mark: "LIVE", style: "bracket", content: "实时", width: 112, height: 42, color: "#70bd91" }),
  decorationPreset({ id: "current-shift-badge", zh: "当前班次角标", en: "Current shift badge", descriptionZh: "在页首显示当前生产班次", family: "badge", mark: "SHIFT", style: "frame-notch", content: "早班", width: 128, height: 42 }),
  decorationPreset({ id: "online-status-badge", zh: "在线状态角标", en: "Online badge", descriptionZh: "标识数据源或设备在线", family: "badge", mark: "ON", style: "neon", content: "在线", width: 108, height: 42, color: "#69ad87" }),
  decorationPreset({ id: "ai-insight-badge", zh: "AI 洞察角标", en: "AI insight badge", descriptionZh: "标识由模型生成的洞察区域", family: "badge", mark: "AI", style: "corner", content: "AI 洞察", width: 132, height: 42, color: "#8c8fd1" }),
  decorationPreset({ id: "warning-level-badge", zh: "预警等级角标", en: "Warning level badge", descriptionZh: "标识当前预警等级和关注区", family: "badge", mark: "L2", style: "neon", content: "二级预警", width: 144, height: 42, color: "#ff9b73" }),
  decorationPreset({ id: "metric-unit-badge", zh: "指标单位角标", en: "Metric unit badge", descriptionZh: "附着于指标区说明统计单位", family: "badge", mark: "UNIT", style: "border", content: "单位：万元", width: 140, height: 40, color: "#8fa0a7" }),
  decorationPreset({ id: "refresh-time-badge", zh: "更新时间角标", en: "Refresh time badge", descriptionZh: "显示数据最近更新时间位置", family: "badge", mark: "TIME", style: "corner", content: "更新 10:30", width: 156, height: 40, color: "#71868f" }),
  decorationPreset({ id: "security-level-badge", zh: "访问级别角标", en: "Access level badge", descriptionZh: "标识页面数据访问级别", family: "badge", mark: "SEC", style: "bracket", content: "内部", width: 112, height: 40, color: "#ad9270" }),
] as const;

