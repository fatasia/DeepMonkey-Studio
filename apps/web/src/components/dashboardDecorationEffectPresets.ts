import type { DashboardComponentPreset } from "./dashboardComponentPresetTypes";
import { decorationPreset } from "./dashboardComponentPresetFactory";

const loop = { animation: "pulse" as const, animationAutoplay: true, animationLoop: true, animationDuration: 1800 };

export const DASHBOARD_DECORATION_EFFECT_PRESETS: readonly DashboardComponentPreset[] = [
  decorationPreset({ id: "section-light-beam", zh: "分区底部光带", en: "Section light beam", descriptionZh: "在重点分区底部形成柔和光带", family: "light", mark: "BEAM", style: "neon", content: "", width: 520, height: 24, color: "#5e9dad" }),
  decorationPreset({ id: "title-light-underline", zh: "标题强调光线", en: "Title light underline", descriptionZh: "强化主标题下方的视觉层级", family: "light", mark: "LINE", style: "divider", content: "", width: 420, height: 18, color: "#d6b65f" }),
  decorationPreset({ id: "data-flow-light", zh: "数据流动光带", en: "Data flow light", descriptionZh: "表达数据从左向右持续流动", family: "light", mark: "FLOW", style: "scan", content: "", width: 620, height: 22, color: "#66a5b6", widget: { ...loop, animationDuration: 2400 } }),
  decorationPreset({ id: "energy-flow-light", zh: "能源流向光带", en: "Energy flow light", descriptionZh: "表达能源在模块间的传递方向", family: "light", mark: "ENERGY", style: "segment", content: "", width: 560, height: 22, color: "#69ad87", widget: { ...loop, animationDuration: 2200 } }),
  decorationPreset({ id: "focus-glow-band", zh: "重点聚焦光带", en: "Focus glow band", descriptionZh: "在当前重点对象旁提供持续提示", family: "light", mark: "FOCUS", style: "neon", content: "重点关注", width: 280, height: 42, color: "#e1ba62", widget: loop }),
  decorationPreset({ id: "status-edge-light", zh: "状态边缘光条", en: "Status edge light", descriptionZh: "为状态卡组提供统一边缘识别", family: "light", mark: "STATE", style: "bracket", content: "", width: 360, height: 30, color: "#75a28d" }),

  decorationPreset({ id: "panel-scan-overlay", zh: "面板扫描覆盖", en: "Panel scan overlay", descriptionZh: "覆盖设备面板形成纵向扫描效果", family: "scan", mark: "SCAN", style: "scan", content: "设备扫描", width: 420, height: 260, color: "#61a3b4", widget: { ...loop, animationDuration: 2800 } }),
  decorationPreset({ id: "radar-scan-zone", zh: "雷达扫描区域", en: "Radar scan zone", descriptionZh: "标记需要持续巡检的空间区域", family: "scan", mark: "RADAR", style: "neon", content: "巡检区域", width: 320, height: 320, color: "#6aa99c", widget: { ...loop, animationDuration: 3000 } }),
  decorationPreset({ id: "crosshair-locator", zh: "目标定位扫描框", en: "Target locator", descriptionZh: "聚焦地图、视频或三维联动目标", family: "scan", mark: "+", style: "corner", content: "目标定位", width: 220, height: 180, color: "#d5b45c", widget: loop }),
  decorationPreset({ id: "barcode-scan-strip", zh: "条码扫描光条", en: "Barcode scan strip", descriptionZh: "用于入库、质检和追溯扫码区域", family: "scan", mark: "CODE", style: "diagonal", content: "扫码区", width: 360, height: 72, color: "#7ca2ad", widget: { ...loop, animationDuration: 1600 } }),
  decorationPreset({ id: "data-sweep-marker", zh: "数据刷新扫描条", en: "Data sweep marker", descriptionZh: "提示图表数据正在刷新或重算", family: "scan", mark: "SYNC", style: "scan", content: "数据刷新", width: 420, height: 48, color: "#729aa5", widget: { ...loop, animationDuration: 2000 } }),

  decorationPreset({ id: "alarm-neon", zh: "重点告警标题", en: "Alarm neon title", descriptionZh: "用于异常与重点关注区域标题", family: "alarm", mark: "ALARM", style: "neon", content: "重点告警", width: 380, height: 68, color: "#ff756a", widget: loop }),
  decorationPreset({ id: "critical-alarm-banner", zh: "重大告警横幅", en: "Critical alarm banner", descriptionZh: "跨区展示必须立即处置的重大告警", family: "alarm", mark: "L4", style: "neon", content: "重大告警 · 立即处置", width: 620, height: 76, color: "#ff665f", widget: { ...loop, animationDuration: 1100 } }),
  decorationPreset({ id: "device-offline-banner", zh: "设备离线提示", en: "Device offline banner", descriptionZh: "提示设备、网关或数据源失联", family: "alarm", mark: "OFF", style: "bracket", content: "设备离线", width: 320, height: 62, color: "#d28b70", widget: loop }),
  decorationPreset({ id: "fault-zone-frame", zh: "故障区域框", en: "Fault zone frame", descriptionZh: "框选发生故障的设备或业务区域", family: "alarm", mark: "FAULT", style: "frame-notch", content: "故障区域", width: 420, height: 260, color: "#e27369", widget: loop }),
  decorationPreset({ id: "emergency-command-banner", zh: "应急指挥横幅", en: "Emergency command banner", descriptionZh: "进入应急态时展示统一指挥提示", family: "alarm", mark: "SOS", style: "scan", content: "应急处置中", width: 520, height: 72, color: "#f08265", widget: { ...loop, animationDuration: 1300 } }),
] as const;

