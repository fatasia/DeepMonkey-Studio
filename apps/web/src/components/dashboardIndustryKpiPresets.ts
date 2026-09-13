import type { DashboardComponentPreset } from "./dashboardComponentPresetTypes";
import { metricPreset } from "./dashboardComponentPresetFactory";

/**
 * 行业 KPI 预设(素材数量波次 A):电力、水务、化工、医院、政务五个行业各 8 项。
 * 单位、量程与阈值均取行业考核口径(线损率 %、浊度 NTU、产销差 %、药占比 %、一次办结率 % 等),
 * 配合 conditionalRules 让超限自动进入预警色,避免"换名不换义"的凑数。
 */

// ── 电力 8 ────────────────────────────────────────────────────────────────
const POWER_PRESETS = [
  // 线损率综合考核 ≤6%,越限提示排查计量与网架
  metricPreset("power-line-loss-kpi", "线损率指标卡", "Line loss rate", "统计网供电线损率并提示超考核值", "value", "power.lineLoss", "lineLoss", "%", { min: 0, max: 15, conditionalRules: [{ id: "line-loss-high", operator: "gt", value: 6, color: "#ff8170", animation: "pulse" }] }),
  // 母线电压合格率国调考核 ≥98%
  metricPreset("bus-voltage-qualify", "母线电压合格率", "Bus voltage quality", "母线电压偏差在允许带内的时间占比", "progress", "power.busVoltageQuality", "qualityRate", "%", { min: 90, max: 100, conditionalRules: [{ id: "bus-voltage-low", operator: "lt", value: 98, color: "#e8bd68" }] }),
  // 负荷率 = 平均负荷/最大负荷,低说明容量闲置
  metricPreset("load-rate-kpi", "负荷率指标卡", "Load factor", "统计周期平均负荷与最大负荷之比", "value", "power.loadFactor", "loadFactor", "%", { min: 0, max: 100, conditionalRules: [{ id: "load-factor-low", operator: "lt", value: 40, color: "#e8bd68" }] }),
  // 新能源消纳考核:弃风弃光率 ≤5%
  metricPreset("curtailment-rate", "弃风弃光率", "Curtailment rate", "风电光伏受限电量占发电量比例", "value", "power.curtailment", "curtailmentRate", "%", { min: 0, max: 100, conditionalRules: [{ id: "curtailment-high", operator: "gt", value: 5, color: "#ff8170" }] }),
  // 火电厂厂用电率常规 4%-8%
  metricPreset("auxiliary-power-rate", "厂用电率", "Auxiliary power rate", "厂用消耗电量占发电量比例", "progress", "power.auxiliary", "auxRate", "%", { min: 0, max: 20, conditionalRules: [{ id: "aux-power-high", operator: "gt", value: 8, color: "#e8bd68" }] }),
  // 供电可靠率 RS-3 考核 ≥99.9%
  metricPreset("supply-reliability", "供电可靠率", "Supply reliability", "用户年均供电可靠率考核值", "gauge", "power.reliability", "rsRate", "%", { min: 99, max: 100, conditionalRules: [{ id: "reliability-low", operator: "lt", value: 99.9, color: "#e8bd68" }] }),
  // 主变负载率 ≥80% 进入重载区间
  metricPreset("transformer-loading", "主变负载率", "Transformer loading", "主变压器实时负载与额定容量之比", "gauge", "power.transformerLoad", "loading", "%", { min: 0, max: 120, conditionalRules: [{ id: "transformer-heavy", operator: "gte", value: 80, color: "#ff8170" }] }),
  // 峰谷差率反映调峰压力,>45% 需要需求侧响应
  metricPreset("peak-valley-diff", "峰谷差率", "Peak-valley difference", "最大负荷与低谷负荷差值占比", "value", "power.peakValley", "peakValleyRate", "%", { min: 0, max: 100, conditionalRules: [{ id: "peak-valley-high", operator: "gt", value: 45, color: "#e8bd68" }] }),
] as const;

// ── 水务 8 ────────────────────────────────────────────────────────────────
const WATER_PRESETS = [
  // 产销差率(无效供水量)城镇供水考核 ≤12%
  metricPreset("water-nrw-kpi", "产销差率指标卡", "Non-revenue water", "产销差水量占供水总量比例", "value", "water.nrw", "nrwRate", "%", { min: 0, max: 50, conditionalRules: [{ id: "nrw-high", operator: "gt", value: 12, color: "#ff8170", animation: "pulse" }] }),
  // 《生活饮用水卫生标准》出厂水浊度 ≤1 NTU
  metricPreset("turbidity-kpi", "出厂浊度指标卡", "Turbidity", "出厂水浊度实时监测值", "value", "water.turbidity", "turbidity", "NTU", { min: 0, max: 5, conditionalRules: [{ id: "turbidity-high", operator: "gt", value: 1, color: "#ff8170" }] }),
  // 出厂余氯控制区间 0.3-0.5 mg/L,低于下限提示加氯不足
  metricPreset("residual-chlorine", "余氯指标卡", "Residual chlorine", "出厂水余氯与下限控制", "gauge", "water.chlorine", "residualChlorine", "mg/L", { min: 0, max: 1.5, conditionalRules: [{ id: "chlorine-low", operator: "lt", value: 0.3, color: "#e8bd68" }] }),
  // 泵站综合效率低于 65% 提示叶轮磨损或工况偏离
  metricPreset("pump-efficiency", "泵站效率", "Pump station efficiency", "泵站水泵机组综合运行效率", "progress", "water.pumpEfficiency", "efficiency", "%", { min: 0, max: 100, conditionalRules: [{ id: "pump-eff-low", operator: "lt", value: 65, color: "#e8bd68" }] }),
  // 单位供水电耗行业对标值约 300 kWh/km³
  metricPreset("ton-water-energy", "吨水电耗指标卡", "Energy per km³", "千立方米供水电耗对标值", "value", "water.unitEnergy", "unitEnergy", "kWh/km³", { min: 0, max: 600, conditionalRules: [{ id: "unit-energy-high", operator: "gt", value: 350, color: "#e8bd68" }] }),
  // 供水服务压力标准 ≥0.14 MPa
  metricPreset("pipe-pressure-kpi", "管网压力指标卡", "Pipe pressure", "管网最不利点供水压力", "value", "water.pressure", "pipePressure", "MPa", { min: 0, max: 0.8, conditionalRules: [{ id: "pipe-pressure-low", operator: "lt", value: 0.14, color: "#ff8170" }] }),
  // 水质综合合格率考核 ≥95%
  metricPreset("water-quality-pass", "水质综合合格率", "Water quality compliance", "各监测点水质检测综合合格率", "progress", "water.qualityPass", "qualityPassRate", "%", { min: 90, max: 100, conditionalRules: [{ id: "quality-pass-low", operator: "lt", value: 95, color: "#ff8170" }] }),
  // 《城镇供水管网漏损控制及评定标准》一级评定 ≤10%
  metricPreset("leakage-rate-kpi", "管网漏损率", "Leakage rate", "管网漏损水量占供水总量比例", "value", "water.leakage", "leakageRate", "%", { min: 0, max: 30, conditionalRules: [{ id: "leakage-high", operator: "gt", value: 10, color: "#ff8170" }] }),
] as const;

// ── 化工 8 ────────────────────────────────────────────────────────────────
const CHEM_PRESETS = [
  // 单程收率低于设计值 92% 提示催化剂活性或工艺波动
  metricPreset("chem-yield-kpi", "单程收率指标卡", "Single-pass yield", "反应器单程转化收率与设计值对比", "value", "chem.yield", "yieldRate", "%", { min: 0, max: 100, conditionalRules: [{ id: "chem-yield-low", operator: "lt", value: 92, color: "#e8bd68" }] }),
  // 单位产品综合能耗(千克标煤/吨产品)对标行业能效标杆
  metricPreset("energy-intensity-chem", "能耗强度指标卡", "Energy intensity", "单位产品综合能耗与标杆值对比", "value", "chem.energyIntensity", "energyIntensity", "kgce/t", { min: 0, max: 600, conditionalRules: [{ id: "chem-energy-high", operator: "gt", value: 380, color: "#ff8170" }] }),
  // 特殊调节阀实时开度,作为工艺调节量参考
  metricPreset("control-valve-opening", "特阀开度", "Control valve opening", "特殊调节阀实时开度反馈", "progress", "chem.valveOpening", "opening", "%", { min: 0, max: 100 }),
  // 反应器温度超 380°C 触发高温联锁预警
  metricPreset("reactor-temp-kpi", "反应温度指标卡", "Reactor temperature", "反应器床层温度与高温联锁阈值", "value", "chem.reactorTemp", "reactorTemp", "°C", { min: 0, max: 450, conditionalRules: [{ id: "reactor-overheat", operator: "gt", value: 380, color: "#ff8170", animation: "pulse" }] }),
  // 转化率低于 88% 提示返混或进料配比异常
  metricPreset("conversion-rate-kpi", "转化率指标卡", "Conversion rate", "关键反应物转化率", "progress", "chem.conversion", "conversionRate", "%", { min: 0, max: 100, conditionalRules: [{ id: "conversion-low", operator: "lt", value: 88, color: "#e8bd68" }] }),
  // 吨产品蒸汽单耗对标 2.5 t/t
  metricPreset("steam-ratio-kpi", "蒸汽单耗指标卡", "Steam consumption ratio", "吨产品蒸汽消耗量", "value", "chem.steamRatio", "steamRatio", "t/t", { min: 0, max: 5, conditionalRules: [{ id: "steam-ratio-high", operator: "gt", value: 2.5, color: "#e8bd68" }] }),
  // 尾气排放浓度超 120 mg/m³ 触发环保告警
  metricPreset("tail-gas-emission", "尾气排放浓度", "Tail gas emission", "尾气排放浓度与排放限值", "value", "chem.tailGas", "emission", "mg/m³", { min: 0, max: 200, conditionalRules: [{ id: "tail-gas-over", operator: "gt", value: 120, color: "#ff8170", animation: "pulse" }] }),
  // 储罐液位高位 ≥90% 提示转料或降量
  metricPreset("tank-level-chem", "储罐液位指标卡", "Storage tank level", "原料储罐液位与高位警戒", "liquid-fill", "chem.tankLevel", "tankLevel", "%", { min: 0, max: 100, conditionalRules: [{ id: "tank-high-level", operator: "gt", value: 90, color: "#e8bd68" }] }),
] as const;

// ── 医院 8 ────────────────────────────────────────────────────────────────
const HOSPITAL_PRESETS = [
  // 床位使用率 85%-93% 为合理区间,>93% 存在超负荷风险
  metricPreset("bed-occupancy-kpi", "床位使用率指标卡", "Bed occupancy", "开放床位使用率与负荷区间", "gauge", "hospital.bedOccupancy", "occupancy", "%", { min: 0, max: 100, conditionalRules: [{ id: "bed-overload", operator: "gt", value: 93, color: "#ff8170" }] }),
  // 平均住院日三级医院目标 ≤9 天,>12 天提示压床
  metricPreset("avg-length-stay", "平均住院天数", "Average length of stay", "出院患者平均住院日", "value", "hospital.los", "averageStay", "天", { min: 0, max: 30, conditionalRules: [{ id: "stay-long", operator: "gt", value: 12, color: "#e8bd68" }] }),
  // 床位周转次数反映流转效率,月周转 <1.7 次(折算周期值)提示偏低
  metricPreset("bed-turnover-kpi", "床位周转次数", "Bed turnover", "统计周期内床位周转次数", "value", "hospital.bedTurnover", "turnover", "次", { min: 0, max: 60, conditionalRules: [{ id: "turnover-low", operator: "lt", value: 20, color: "#e8bd68" }] }),
  // 门诊候诊 >30 分钟触发服务预警
  metricPreset("wait-time-kpi", "候诊时长指标卡", "Outpatient wait time", "门急诊平均候诊时长", "value", "hospital.waitTime", "waitMinutes", "min", { min: 0, max: 120, conditionalRules: [{ id: "wait-long", operator: "gt", value: 30, color: "#ff8170", animation: "pulse" }] }),
  // 抢救成功率三级医院考核 ≥90%
  metricPreset("rescue-success-rate", "抢救成功率", "Rescue success rate", "急危重患者抢救成功比例", "progress", "hospital.rescueRate", "successRate", "%", { min: 0, max: 100, conditionalRules: [{ id: "rescue-rate-low", operator: "lt", value: 90, color: "#e8bd68" }] }),
  // 术前平均待术日 >3 天提示手术排程瓶颈
  metricPreset("preop-wait-days", "术前平均待术日", "Pre-op waiting days", "入院到手术的平均等待天数", "value", "hospital.preopWait", "preopDays", "天", { min: 0, max: 10, conditionalRules: [{ id: "preop-wait-long", operator: "gt", value: 3, color: "#e8bd68" }] }),
  // 院感发生率(千分率)超过 8‰ 启动感染控制处置
  metricPreset("infection-rate-kpi", "院感发生率", "HAI incidence", "院内感染发生千分率", "value", "hospital.haiRate", "haiRate", "‰", { min: 0, max: 20, conditionalRules: [{ id: "hai-high", operator: "gt", value: 8, color: "#ff8170" }] }),
  // 大型医用设备(CT/MRI)单机使用率 <70% 提示排程优化
  metricPreset("imaging-utilization", "大型设备使用率", "Imaging utilization", "大型医用设备开机使用率", "gauge", "hospital.imagingUtil", "utilization", "%", { min: 0, max: 100, conditionalRules: [{ id: "imaging-low", operator: "lt", value: 70, color: "#e8bd68" }] }),
] as const;

// ── 政务 8 ────────────────────────────────────────────────────────────────
const GOV_PRESETS = [
  metricPreset("handling-volume-kpi", "办件量翻牌卡", "Handling volume", "累计受理办件量翻牌展示", "digital-flip", "gov.handlingVolume", "volume", "件", { fontSize: 40 }),
  // 满意率考核 ≥95%
  metricPreset("satisfaction-rate-kpi", "满意率指标卡", "Satisfaction rate", "办事群众评价满意比例", "progress", "gov.satisfaction", "satisfaction", "%", { min: 0, max: 100, conditionalRules: [{ id: "satisfaction-low", operator: "lt", value: 95, color: "#e8bd68" }] }),
  // "一次办结"改革考核 ≥90%
  metricPreset("once-through-rate", "一次办结率", "First-visit completion", "一次上门即办结的事项比例", "progress", "gov.onceThrough", "onceThroughRate", "%", { min: 0, max: 100, conditionalRules: [{ id: "once-through-low", operator: "lt", value: 90, color: "#e8bd68" }] }),
  // 平均办理时限超过承诺值 5 天提示流程积压
  metricPreset("avg-handle-days", "平均办理时限", "Average handling time", "事项平均办结耗时", "value", "gov.handleDays", "handleDays", "天", { min: 0, max: 30, conditionalRules: [{ id: "handle-slow", operator: "gt", value: 5, color: "#e8bd68" }] }),
  metricPreset("overdue-case-flip", "超期件翻牌卡", "Overdue cases", "超承诺时限办件量实时翻牌", "digital-flip", "gov.overdueCases", "overdue", "件", { conditionalRules: [{ id: "overdue-exists", operator: "gt", value: 0, color: "#ff8170", animation: "pulse" }] }),
  // 网办率(全程网办占比)推进目标 ≥60%
  metricPreset("online-rate-kpi", "网办率指标卡", "Online handling rate", "全程网办事项占比", "progress", "gov.onlineRate", "onlineRate", "%", { min: 0, max: 100, conditionalRules: [{ id: "online-rate-low", operator: "lt", value: 60, color: "#e8bd68" }] }),
  // 大厅排队等候 >20 分钟提示增开窗口
  metricPreset("queue-wait-kpi", "排队等候时长", "Queue waiting time", "大厅平均排队等候时长", "value", "gov.queueWait", "queueWait", "min", { min: 0, max: 90, conditionalRules: [{ id: "queue-long", operator: "gt", value: 20, color: "#e8bd68" }] }),
  // 承诺时限内办结率 ≥98%
  metricPreset("committed-time-rate", "承诺时限达成率", "Committed deadline rate", "承诺时限内办结事项占比", "gauge", "gov.committedRate", "committedRate", "%", { min: 0, max: 100, conditionalRules: [{ id: "committed-low", operator: "lt", value: 98, color: "#ff8170" }] }),
] as const;

export const DASHBOARD_INDUSTRY_KPI_PRESETS: readonly DashboardComponentPreset[] = [
  ...POWER_PRESETS,
  ...WATER_PRESETS,
  ...CHEM_PRESETS,
  ...HOSPITAL_PRESETS,
  ...GOV_PRESETS,
] as const;
