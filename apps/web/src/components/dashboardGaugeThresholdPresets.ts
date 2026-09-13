import type { DashboardComponentPreset } from "./dashboardComponentPresetTypes";
import { analysisPreset } from "./dashboardComponentPresetFactory";

/**
 * 仪表阈值族(素材数量波次 A):16 款量程、刻度与色带构图各异的阈值仪表。
 * 每款在 DashboardComponentPreview 内拥有独立的 mark 构图(双指针/色带分段/半环/全环/
 * 270° 弧/偏差带/多量程等),min/max 与 conditionalRules 采用行业真实量程,
 * 禁止同一构图仅换标签凑数。
 */
export const DASHBOARD_GAUGE_THRESHOLD_PRESETS: readonly DashboardComponentPreset[] = [
  // 双指针:当前值 + 额定上限对照(缩略图双针构图)
  analysisPreset("dual-needle-tachometer", "双指针转速表", "Dual-needle tachometer", "主针显示实时转速,副针标定额定上限", "gauge", "motor.rpmGauge", "motor", "rpm", { analysis: { dimensionField: "motor", measureField: "rpm", aggregation: "average" }, min: 0, max: 3600 }),
  // 三段色带:安全/关注/告警(缩略图分段色带构图)
  analysisPreset("band-segment-pressure", "分段色带压力表", "Band-segment pressure", "压力按安全、关注、告警三段色带判定", "gauge", "pipe.pressureGauge", "section", "pressure", { analysis: { dimensionField: "section", measureField: "pressure", aggregation: "average" }, min: 0, max: 2.5, conditionalRules: [{ id: "pressure-segment-high", operator: "gt", value: 2, color: "#ff8170" }] }),
  // 半环 180°:低温工况(缩略图半弧构图)
  analysisPreset("half-arc-temperature", "半环温度表", "Half-arc temperature", "半弧刻度展示冷库低温区间", "gauge", "coldroom.tempGauge", "bay", "temperature", { analysis: { dimensionField: "bay", measureField: "temperature", aggregation: "average" }, min: -30, max: 10 }),
  // 全环 360°:完成度(缩略图全环构图)
  analysisPreset("full-ring-completion", "全环完成度表", "Full-ring completion", "360° 环形刻度展示整备完成度", "gauge", "workshop.completionGauge", "station", "completion", { analysis: { dimensionField: "station", measureField: "completion", aggregation: "average" }, min: 0, max: 100 }),
  // 270° 弧:动力功率(缩略图 3/4 弧构图)
  analysisPreset("arc270-power-meter", "270°弧功率表", "270° arc power", "270° 弧刻度展示机组有功功率", "gauge", "unit.powerGauge", "unit", "power", { analysis: { dimensionField: "unit", measureField: "power", aggregation: "average" }, min: 0, max: 600, conditionalRules: [{ id: "power-arc-high", operator: "gt", value: 520, color: "#ff8170" }] }),
  // 偏差带:零点居中正负偏差(缩略图中心零点构图)
  analysisPreset("deviation-band-gauge", "偏差带仪表", "Deviation band gauge", "以设定值为中心展示正负工艺偏差", "gauge", "process.deviationGauge", "loop", "deviation", { analysis: { dimensionField: "loop", measureField: "deviation", aggregation: "average" }, min: -10, max: 10, conditionalRules: [{ id: "deviation-out", operator: "gte", value: 6, color: "#e8bd68" }] }),
  // 多量程:自动量程切换的宽域电压(缩略图双量程刻度构图)
  analysisPreset("multi-range-voltage", "多量程电压表", "Multi-range voltage", "双量程刻度覆盖 400V 与 10kV 母线", "gauge", "grid.voltageGauge", "bus", "voltage", { analysis: { dimensionField: "bus", measureField: "voltage", aggregation: "average" }, min: 0, max: 400, conditionalRules: [{ id: "voltage-multi-low", operator: "lt", value: 360, color: "#e8bd68" }] }),
  // 三区底色:轻载/正常/重载(缩略图分区底色构图)
  analysisPreset("load-zone-meter", "负荷分区表", "Load zone meter", "轻载、经济、重载三区底色显示负荷带", "gauge", "transformer.loadGauge", "bay", "load", { analysis: { dimensionField: "bay", measureField: "load", aggregation: "average" }, min: 0, max: 120, conditionalRules: [{ id: "load-zone-heavy", operator: "gte", value: 80, color: "#ff8170" }] }),
  // 双色带:液位高位/低位双色(缩略图双色渐变带构图)
  analysisPreset("level-duotone-gauge", "液位双色仪表", "Level duotone gauge", "高低水位双色带标定储罐液位", "gauge", "tank.levelGauge", "tank", "level", { analysis: { dimensionField: "tank", measureField: "level", aggregation: "average" }, min: 0, max: 100, conditionalRules: [{ id: "level-duo-high", operator: "gt", value: 90, color: "#e8bd68" }] }),
  // 告警尾区:末端红色警戒弧(缩略图红尾区构图)
  analysisPreset("differential-pressure-alarm", "压差报警仪表", "Differential pressure alarm", "末端红色警戒弧标定滤芯堵塞压差", "gauge", "filter.dpGauge", "filter", "deltaPressure", { analysis: { dimensionField: "filter", measureField: "deltaPressure", aggregation: "maximum" }, min: 0, max: 80, conditionalRules: [{ id: "dp-alarm", operator: "gt", value: 55, color: "#ff8170", animation: "pulse" }] }),
  // 宽量程:45-55Hz 窄带放大的宽域频率(缩略图宽域细刻度构图)
  analysisPreset("wide-span-frequency", "宽域频率表", "Wide-span frequency", "45-55Hz 宽域刻度聚焦电网频率", "gauge", "grid.frequencyGauge", "bus", "frequency", { analysis: { dimensionField: "bus", measureField: "frequency", aggregation: "average" }, min: 45, max: 55, conditionalRules: [{ id: "frequency-wide-low", operator: "lt", value: 49.8, color: "#ff8170" }] }),
  // 窄量程:0-10ppm 微量浓度(缩略图窄量程放大构图)
  analysisPreset("narrow-band-concentration", "窄量浓度表", "Narrow-band concentration", "0-10ppm 窄量程放大微量泄漏浓度", "gauge", "gas.traceGauge", "zone", "concentration", { analysis: { dimensionField: "zone", measureField: "concentration", aggregation: "maximum" }, min: 0, max: 10, conditionalRules: [{ id: "trace-high", operator: "gt", value: 6, color: "#ff8170", animation: "pulse" }] }),
  // 舒适带:绿色舒适区间(缩略图绿色舒适带构图)
  analysisPreset("comfort-band-humidity", "舒适带湿度表", "Comfort band humidity", "40-70% 舒适绿带显示车间湿度", "gauge", "environment.humidityGauge", "zone", "humidity", { analysis: { dimensionField: "zone", measureField: "humidity", aggregation: "average" }, min: 0, max: 100 }),
  // 饱和线:蒸汽压力饱和对照(缩略图饱和线标记构图)
  analysisPreset("steam-saturation-gauge", "蒸汽饱和压力表", "Steam saturation gauge", "标注饱和压力线对照管网过热度", "gauge", "steam.saturationGauge", "header", "pressure", { analysis: { dimensionField: "header", measureField: "pressure", aggregation: "average" }, min: 0, max: 2.5, conditionalRules: [{ id: "steam-sat-high", operator: "gt", value: 2.1, color: "#ff8170" }] }),
  // 安全线:库存安全余量(缩略图安全线标记构图)
  analysisPreset("stock-safety-gauge", "库存安全余量表", "Stock safety gauge", "标注安全库存线的备料余量", "gauge", "material.safetyGauge", "warehouse", "margin", { analysis: { dimensionField: "warehouse", measureField: "margin", aggregation: "minimum" }, min: 0, max: 100, conditionalRules: [{ id: "stock-safety-low", operator: "lt", value: 25, color: "#ff8170" }] }),
  // 反向弧:储备裕度越大越安全(缩略图反向刻度构图)
  analysisPreset("reserve-margin-gauge", "出力储备表", "Reserve margin gauge", "反向刻度展示调峰出力储备裕度", "gauge", "grid.reserveGauge", "region", "reserve", { analysis: { dimensionField: "region", measureField: "reserve", aggregation: "minimum" }, min: 0, max: 100, conditionalRules: [{ id: "reserve-low", operator: "lt", value: 15, color: "#ff8170", animation: "pulse" }] }),
] as const;
