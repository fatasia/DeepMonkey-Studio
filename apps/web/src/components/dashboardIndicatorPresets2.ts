import type { DashboardComponentPreset } from "./dashboardComponentPresetTypes";
import { metricPreset } from "./dashboardComponentPresetFactory";

/** 指标预设第二批:环比/同比、峰值、告警统计等经营高频指标,单位与既有目录保持同一体系。 */
export const DASHBOARD_INDICATOR_PRESETS_2: readonly DashboardComponentPreset[] = [
  metricPreset("mom-output-kpi", "产量环比指标卡", "Output MoM KPI", "显示产量环比变化并为下滑告警", "value", "production.mom", "momDelta", "%", { min: -100, max: 100, conditionalRules: [{ id: "mom-decline", operator: "lt", value: 0, color: "#ff8170", animation: "pulse" }] }),
  metricPreset("yoy-sales-flip", "产值同比翻牌卡", "Revenue YoY flip", "大数字翻牌展示产值同比增速", "digital-flip", "business.yoy", "yoy", "%", { min: -100, max: 200, conditionalRules: [{ id: "yoy-decline", operator: "lt", value: 0, color: "#ff8170" }] }),
  metricPreset("plan-target-gauge", "计划达成仪表", "Plan attainment gauge", "仪表盘展示计划完成比例与差距", "gauge", "target.planRate", "planRate", "%", { min: 0, max: 100 }),
  metricPreset("oee-availability-progress", "设备稼动率卡", "Availability progress", "跟踪开动率并区分停机构成", "progress", "production.availability", "availability", "%", { min: 0, max: 100 }),
  metricPreset("energy-peak-card", "能耗峰值需量卡", "Peak demand KPI", "展示统计周期最大功率需量", "value", "energy.peakDemand", "peakDemand", "kW", { conditionalRules: [{ id: "peak-overload", operator: "gte", value: 800, color: "#ff8170", animation: "pulse" }] }),
  metricPreset("alarm-open-flip", "未处置告警翻牌", "Open alarm flip", "持续翻牌提醒待处置告警数量", "digital-flip", "alarm.open", "openCount", "条", { conditionalRules: [{ id: "alarm-pending", operator: "gt", value: 0, color: "#ff8170", animation: "pulse" }] }),
  metricPreset("spare-stock-liquid", "备件库存水球", "Spare stock level", "水球图展示备件库存安全水位", "liquid-fill", "spare.stock", "stockLevel", "%", { min: 0, max: 100 }),
  metricPreset("workshop-temp-status", "车间温度状态", "Workshop temperature", "区间状态显示正常、偏温和超温", "status", "environment.tempState", "tempState", "", { conditionalRules: [{ id: "temp-overheat", operator: "eq", value: "超温", color: "#ff8170", animation: "pulse" }] }),
  metricPreset("steam-pressure-value", "蒸汽压力指标卡", "Steam pressure KPI", "显示管网蒸汽压力并提示超压", "value", "steam.pressure", "pressure", "MPa", { min: 0, max: 2, conditionalRules: [{ id: "steam-overpressure", operator: "gt", value: 1.2, color: "#ff8170" }] }),
  metricPreset("batch-completed-flip", "完工批次翻牌", "Completed batches", "累计翻牌展示当日完工批次数", "digital-flip", "production.batches", "batches", "批", { fontSize: 40 }),
  metricPreset("power-factor-value", "功率因数指标卡", "Power factor KPI", "监测功率因数并提示低于考核线", "value", "energy.powerFactor", "powerFactor", "", { min: 0, max: 1, conditionalRules: [{ id: "pf-low", operator: "lt", value: 0.95, color: "#e8bd68" }] }),
  metricPreset("mttr-value-card", "平均修复时长卡", "Mean time to repair", "按工单统计平均修复耗时", "value", "maintenance.mttr", "mttr", "min", { analysis: { measureField: "mttr", aggregation: "average" }, conditionalRules: [{ id: "mttr-high", operator: "gt", value: 120, color: "#ff9b73" }] }),

  // 多值量程仪表族:同一仪表形态按业务量程与单位分化,量程阈值与告警联动。
  metricPreset("temperature-range-gauge", "温度量程仪表", "Temperature gauge", "车间或设备温度量程与高温告警", "gauge", "environment.temperature", "temperature", "°C", { min: -20, max: 80, conditionalRules: [{ id: "temp-high", operator: "gte", value: 60, color: "#ff8170" }] }),
  metricPreset("pressure-range-gauge", "压力量程仪表", "Pressure gauge", "管网压力量程与超压提示", "gauge", "steam.headerPressure", "pressure", "MPa", { min: 0, max: 2.5, conditionalRules: [{ id: "pressure-high", operator: "gte", value: 2, color: "#ff8170" }] }),
  metricPreset("flow-rate-gauge", "流量仪表", "Flow rate gauge", "水或气体瞬时流量与满量程提示", "gauge", "water.flowRate", "flowRate", "m³/h", { min: 0, max: 500 }),
  metricPreset("humidity-range-gauge", "湿度仪表", "Humidity gauge", "车间湿度区间与舒适范围提示", "gauge", "environment.humidity", "humidity", "%", { min: 0, max: 100 }),
  metricPreset("voltage-range-gauge", "电压仪表", "Voltage gauge", "动力电压量程与欠压告警", "gauge", "power.voltage", "voltage", "V", { min: 0, max: 400, conditionalRules: [{ id: "voltage-low", operator: "lt", value: 360, color: "#e8bd68" }] }),

  // 进度百分比族:同一进度形态按业务阶段分化,超限阈值触发预警色。
  metricPreset("annual-target-progress", "年度目标进度", "Annual target progress", "年度经营目标的累计完成比例", "progress", "target.annual", "annualRate", "%", { min: 0, max: 100 }),
  metricPreset("milestone-progress", "里程碑进度", "Milestone progress", "项目里程碑整体完成比例", "progress", "project.milestone", "completion", "%", { min: 0, max: 100 }),
  metricPreset("training-coverage-progress", "培训覆盖进度", "Training coverage", "安全培训人员覆盖比例", "progress", "safety.trainingCoverage", "coverage", "%", { min: 0, max: 100, conditionalRules: [{ id: "training-low", operator: "lt", value: 80, color: "#e8bd68" }] }),
  metricPreset("maintenance-plan-progress", "维保计划进度", "Maintenance plan progress", "维保计划执行与剩余任务比例", "progress", "maintenance.planProgress", "progress", "%", { min: 0, max: 100 }),
  metricPreset("order-fulfillment-progress", "订单履约进度", "Order fulfillment progress", "在手订单的发货履约比例", "progress", "order.fulfillment", "fulfillmentRate", "%", { min: 0, max: 100 }),
  metricPreset("budget-usage-progress", "预算执行进度", "Budget usage progress", "成本中心预算消耗比例与超支预警", "progress", "finance.budgetUsage", "usageRate", "%", { min: 0, max: 100, conditionalRules: [{ id: "budget-over", operator: "gt", value: 90, color: "#ff9b73" }] }),

  // 同环比卡族:变化率为主的经营快照,方向为负自动转警示色。
  metricPreset("profit-mom-value", "利润环比卡", "Profit MoM KPI", "利润环比变化并为下滑告警", "value", "business.profitMom", "momDelta", "%", { min: -100, max: 100, conditionalRules: [{ id: "profit-down", operator: "lt", value: 0, color: "#ff8170", animation: "pulse" }] }),
  metricPreset("order-yoy-value", "订单同比卡", "Order YoY KPI", "新增订单同比增速与需求波动", "value", "order.yoy", "yoy", "%", { min: -100, max: 200, conditionalRules: [{ id: "order-down", operator: "lt", value: 0, color: "#ff8170" }] }),
  metricPreset("energy-mom-value", "能耗环比卡", "Energy MoM KPI", "能耗环比上升时提示节能关注", "value", "energy.mom", "momDelta", "%", { min: -100, max: 100, conditionalRules: [{ id: "energy-up", operator: "gt", value: 10, color: "#e8bd68" }] }),
  metricPreset("delivery-yoy-value", "交付同比卡", "Delivery YoY KPI", "交付批次同比变化与产能联动", "value", "delivery.yoy", "yoy", "%", { min: -100, max: 200 }),
] as const;
