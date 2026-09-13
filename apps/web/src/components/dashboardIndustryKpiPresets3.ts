import type { DashboardComponentPreset } from "./dashboardComponentPresetTypes";
import { metricPreset } from "./dashboardComponentPresetFactory";

/**
 * 行业 KPI 预设补深(素材数量波次 F):五个既有行业各 +5~7,新增半导体行业组 7 项,
 * 与 dashboardIndustryKpiPresets / 2 共同构成行业 KPI 族 100 项。
 * 单位与阈值取行业考核口径(备用容量率 %、WAT 合格率 %、抗菌药物送检率 %、差评整改率 % 等),
 * 每项都有真实的量程、越限规则与业务含义,延续既有命名词表,不做换名凑数。
 */

// ── 电力 +7(调度与网架侧补充)─────────────────────────────────────────────
const POWER_DEEP = [
  // 备用容量率 = (可用容量-最大负荷)/最大负荷,调度口径 ≥13% 为合格线
  metricPreset("reserve-margin-kpi", "备用容量率指标卡", "Reserve margin", "可用容量相对最大负荷的裕度", "value", "power.reserveMargin", "reserveMargin", "%", { min: 0, max: 30, conditionalRules: [{ id: "reserve-margin-low", operator: "lt", value: 13, color: "#e8bd68", animation: "pulse" }] }),
  // AGC 机组的投运率考核 ≥98%,反映一次调频可用水平
  metricPreset("agc-input-rate", "AGC 投运率", "AGC availability", "自动发电控制机组投运比例", "progress", "power.agcRate", "agcRate", "%", { min: 90, max: 100, conditionalRules: [{ id: "agc-rate-low", operator: "lt", value: 98, color: "#e8bd68" }] }),
  // 日调频里程(MW)反映机组参与二次调频的贡献量
  metricPreset("fmerit-mileage-flip", "调频里程翻牌卡", "Regulation mileage", "机组日调频里程实时翻牌", "digital-flip", "power.fmeritMileage", "mileage", "MW", { fontSize: 38 }),
  // 新能源功率预测准确率考核 ≥85%,影响日前计划编制
  metricPreset("forecast-accuracy-kpi", "功率预测准确率", "Forecast accuracy", "新能源出力预测准确率", "progress", "power.forecastAccuracy", "accuracy", "%", { min: 0, max: 100, conditionalRules: [{ id: "forecast-low", operator: "lt", value: 85, color: "#e8bd68" }] }),
  metricPreset("unplanned-outage-flip", "非计划停运翻牌卡", "Unplanned outage", "非计划停运次数实时翻牌", "digital-flip", "power.unplannedOutage", "outageCount", "次", { conditionalRules: [{ id: "outage-exists", operator: "gt", value: 0, color: "#ff8170", animation: "pulse" }] }),
  // 分区线损高于 8% 提示窃电、计量误差或网架薄弱
  metricPreset("district-line-loss-kpi", "分区线损指标卡", "District line loss", "配网分区线损率与排查阈值", "value", "power.districtLineLoss", "lineLoss", "%", { min: 0, max: 20, conditionalRules: [{ id: "district-loss-high", operator: "gt", value: 8, color: "#ff8170" }] }),
  // 重载配变占比 >10% 提示增容或负荷转供
  metricPreset("distribution-overload-kpi", "配变重载率", "Distribution overload", "重载配变台数占配变总数比例", "progress", "power.distributionOverload", "overloadRate", "%", { min: 0, max: 100, conditionalRules: [{ id: "dist-overload-high", operator: "gt", value: 10, color: "#e8bd68" }] }),
] as const;

// ── 水务 +6(管网与污水侧补充)────────────────────────────────────────────
const WATER_DEEP = [
  // 二次供水水质合格率考核 ≥95%
  metricPreset("secondary-water-quality", "二次供水合格率", "Secondary supply quality", "二次供水水箱水质抽检合格率", "progress", "water.secondaryQuality", "passRate", "%", { min: 0, max: 100, conditionalRules: [{ id: "secondary-low", operator: "lt", value: 95, color: "#ff8170" }] }),
  // 远传水表在线率 <98% 提示通信或表计故障
  metricPreset("smart-meter-online-kpi", "远传水表在线率", "Smart meter online", "远传水表实时在线比例", "progress", "water.meterOnline", "onlineRate", "%", { min: 0, max: 100, conditionalRules: [{ id: "meter-online-low", operator: "lt", value: 98, color: "#e8bd68" }] }),
  // DMA 分区夜间最小流量异常升高是暗漏的首要信号
  metricPreset("dma-night-flow-kpi", "DMA 夜间最小流量", "DMA night flow", "计量分区夜间最小流量监测", "value", "water.dmaNightFlow", "nightFlow", "m³/h", { min: 0, max: 60, conditionalRules: [{ id: "night-flow-high", operator: "gt", value: 25, color: "#e8bd68" }] }),
  // 再生水利用率反映节水型城市创建水平
  metricPreset("reclaimed-water-rate", "再生水利用率", "Reclaimed water rate", "再生水回用量占污水总量比例", "progress", "water.reclaimedRate", "reuseRate", "%", { min: 0, max: 100 }),
  // 《城镇污水处理厂污染物排放标准》一级 A:COD ≤50 mg/L
  metricPreset("effluent-cod-kpi", "出水 COD 指标卡", "Effluent COD", "污水处理厂出水化学需氧量", "value", "water.effluentCod", "cod", "mg/L", { min: 0, max: 60, conditionalRules: [{ id: "cod-over", operator: "gt", value: 50, color: "#ff8170", animation: "pulse" }] }),
  // 曝气是污水厂最大电耗单元,单耗 >0.4 kWh/m³ 提示风机或曝气器效率
  metricPreset("aeration-energy-kpi", "曝气电耗指标卡", "Aeration energy", "污水处理曝气单耗", "value", "water.aerationEnergy", "aerationEnergy", "kWh/m³", { min: 0, max: 1, conditionalRules: [{ id: "aeration-high", operator: "gt", value: 0.4, color: "#e8bd68" }] }),
] as const;

// ── 化工 +7(设备与安全侧补充)────────────────────────────────────────────
const CHEM_DEEP = [
  // 反应釜压力超设计值 4.5 MPa 触发联锁预警
  metricPreset("reactor-vessel-pressure", "反应釜压力指标卡", "Reactor vessel pressure", "反应釜内压与联锁阈值", "value", "chem.reactorPressure", "vesselPressure", "MPa", { min: 0, max: 6, conditionalRules: [{ id: "vessel-overpressure", operator: "gt", value: 4.5, color: "#ff8170", animation: "pulse" }] }),
  // 换热器端差增大提示结垢或管束泄漏
  metricPreset("heat-exchanger-approach", "换热器端差指标卡", "Exchanger approach", "换热器冷热端差与结垢判断", "value", "chem.exchangerApproach", "approach", "°C", { min: 0, max: 30, conditionalRules: [{ id: "approach-high", operator: "gt", value: 12, color: "#e8bd68" }] }),
  // ISO 10816 振动烈度 >7.1 mm/s 进入 C 区,安排检修
  metricPreset("vibration-severity-kpi", "动设备振动烈度", "Vibration severity", "机泵振动烈度速度有效值", "value", "chem.vibrationSeverity", "severity", "mm/s", { min: 0, max: 20, conditionalRules: [{ id: "vibration-zone-c", operator: "gt", value: 7.1, color: "#ff8170" }] }),
  // 仪表风母管压力低于 0.65 MPa 提示气动阀联锁风险
  metricPreset("instrument-air-pressure", "仪表风母管压力", "Instrument air pressure", "压缩空气母管压力与下限", "value", "chem.instrumentAir", "airPressure", "MPa", { min: 0, max: 1.2, conditionalRules: [{ id: "instrument-air-low", operator: "lt", value: 0.65, color: "#ff8170" }] }),
  // 排烟含氧量 >5% 提示炉膛漏风或配风过大热损失
  metricPreset("flue-gas-oxygen-kpi", "排烟含氧量指标卡", "Flue gas oxygen", "加热炉排烟氧含量", "value", "chem.flueOxygen", "oxygen", "%", { min: 0, max: 15, conditionalRules: [{ id: "flue-o2-high", operator: "gt", value: 5, color: "#e8bd68" }] }),
  // 装置开工率低于 90% 提示非计划波动
  metricPreset("unit-onstream-rate", "装置开工率", "Unit on-stream rate", "主要生产装置运行负荷比例", "progress", "chem.onstreamRate", "onstreamRate", "%", { min: 0, max: 100, conditionalRules: [{ id: "onstream-low", operator: "lt", value: 90, color: "#e8bd68" }] }),
  metricPreset("relief-valve-due-flip", "安全阀校验到期翻牌卡", "Relief valve due", "安全阀校验到期数量翻牌", "digital-flip", "chem.reliefValveDue", "dueCount", "只", { conditionalRules: [{ id: "relief-due", operator: "gt", value: 0, color: "#e8bd68", animation: "pulse" }] }),
] as const;

// ── 医院 +7(手术与质控侧补充)────────────────────────────────────────────
const HOSPITAL_DEEP = [
  // 手术间利用率 <80% 提示排程与接台优化
  metricPreset("or-utilization-kpi", "手术间利用率", "OR utilization", "手术间占用时长占比", "progress", "hospital.orUtilization", "orUtilization", "%", { min: 0, max: 100, conditionalRules: [{ id: "or-util-low", operator: "lt", value: 80, color: "#e8bd68" }] }),
  // 抗菌药物治疗住院患者微生物送检率考核 ≥50%
  metricPreset("antibiotic-culture-rate", "抗菌药物送检率", "Antibiotic culture rate", "抗菌药物治疗前病原学送检比例", "progress", "hospital.antibioticCulture", "cultureRate", "%", { min: 0, max: 100, conditionalRules: [{ id: "culture-rate-low", operator: "lt", value: 50, color: "#ff8170" }] }),
  // 日间手术占比反映床位周转结构,目标 ≥20%
  metricPreset("day-surgery-ratio", "日间手术占比", "Day surgery ratio", "日间手术台数占手术总量比例", "progress", "hospital.daySurgery", "daySurgeryRatio", "%", { min: 0, max: 100, conditionalRules: [{ id: "day-surgery-low", operator: "lt", value: 20, color: "#e8bd68" }] }),
  // 甲级病历率考核 ≥90%
  metricPreset("medical-record-grade-kpi", "甲级病历率", "Grade-A record rate", "病案质控甲级病历占比", "progress", "hospital.recordGrade", "gradeARate", "%", { min: 0, max: 100, conditionalRules: [{ id: "grade-a-low", operator: "lt", value: 90, color: "#e8bd68" }] }),
  // 门诊次均费用管控线 350 元,越线提示费用结构异常
  metricPreset("outpatient-visit-cost", "门诊次均费用指标卡", "Outpatient cost per visit", "门诊人次平均费用", "value", "hospital.outpatientCost", "avgCost", "元", { min: 0, max: 800, conditionalRules: [{ id: "visit-cost-high", operator: "gt", value: 350, color: "#e8bd68" }] }),
  // 危急值接报后 10 分钟内处置,超时触发质控预警
  metricPreset("critical-value-response", "危急值处置时长", "Critical value response", "危急值报告平均处置耗时", "value", "hospital.criticalValue", "responseMinutes", "min", { min: 0, max: 60, conditionalRules: [{ id: "critical-slow", operator: "gt", value: 10, color: "#ff8170", animation: "pulse" }] }),
  metricPreset("nursing-adverse-flip", "护理不良事件翻牌卡", "Nursing adverse events", "护理不良事件实时翻牌", "digital-flip", "hospital.nursingAdverse", "eventCount", "件", { conditionalRules: [{ id: "adverse-exists", operator: "gt", value: 0, color: "#e8bd68" }] }),
] as const;

// ── 政务 +6(好差评与通办侧补充)──────────────────────────────────────────
const GOV_DEEP = [
  // 好差评制度要求差评整改率应达 100%
  metricPreset("rating-rectify-rate", "差评整改率", "Rating rectification", "差评完成整改的比例", "progress", "gov.ratingRectify", "rectifyRate", "%", { min: 0, max: 100, conditionalRules: [{ id: "rectify-incomplete", operator: "lt", value: 100, color: "#ff8170" }] }),
  // 12345 热线诉求按期办结率考核 ≥95%
  metricPreset("hotline-resolution-kpi", "诉求办结率", "Hotline resolution", "12345 热线诉求按期办结比例", "progress", "gov.hotlineResolution", "resolutionRate", "%", { min: 0, max: 100, conditionalRules: [{ id: "hotline-low", operator: "lt", value: 95, color: "#e8bd68" }] }),
  // 电子证照调用率 <60% 提示材料免提交改革滞后
  metricPreset("e-license-usage-kpi", "电子证照调用率", "E-license usage", "办件中电子证照调用比例", "progress", "gov.eLicenseUsage", "usageRate", "%", { min: 0, max: 100, conditionalRules: [{ id: "e-license-low", operator: "lt", value: 60, color: "#e8bd68" }] }),
  metricPreset("cross-province-flip", "跨省通办件量翻牌卡", "Cross-province cases", "跨省通办件量实时翻牌", "digital-flip", "gov.crossProvince", "caseCount", "件", { fontSize: 38 }),
  // 预约办理占比反映大厅分流水平
  metricPreset("appointment-ratio-kpi", "预约办理占比", "Appointment ratio", "预约渠道办理件占比", "progress", "gov.appointmentRatio", "appointmentRatio", "%", { min: 0, max: 100 }),
  metricPreset("agent-assist-flip", "帮办代办件量翻牌卡", "Agent-assisted cases", "帮办代办服务件量翻牌", "digital-flip", "gov.agentAssist", "assistCount", "件", { fontSize: 38 }),
] as const;

// ── 半导体 +7(新行业组:晶圆制造)────────────────────────────────────────
const SEMI_PRESETS = [
  // 晶圆产能利用率 <85% 提示订单或设备综合效率不足
  metricPreset("wafer-capacity-kpi", "晶圆产能利用率", "Wafer capacity utilization", "晶圆产线月度产能利用率", "progress", "semi.waferCapacity", "waferUtilization", "%", { min: 0, max: 100, conditionalRules: [{ id: "wafer-util-low", operator: "lt", value: 85, color: "#e8bd68" }] }),
  // WAT(晶圆验收测试)合格率考核 ≥98%
  metricPreset("wat-pass-rate", "WAT 合格率", "WAT pass rate", "晶圆验收测试合格比例", "progress", "semi.watPass", "watPassRate", "%", { min: 90, max: 100, conditionalRules: [{ id: "wat-low", operator: "lt", value: 98, color: "#ff8170" }] }),
  // CP(晶圆针测)良率低于 92% 提示工艺漂移
  metricPreset("cp-yield-kpi", "CP 良率指标卡", "CP yield", "晶圆针测良率", "value", "semi.cpYield", "cpYield", "%", { min: 0, max: 100, conditionalRules: [{ id: "cp-yield-low", operator: "lt", value: 92, color: "#e8bd68" }] }),
  // FT(成品测试)良率考核 ≥95%
  metricPreset("ft-yield-kpi", "FT 良率指标卡", "FT yield", "成品测试良率", "value", "semi.ftYield", "ftYield", "%", { min: 0, max: 100, conditionalRules: [{ id: "ft-yield-low", operator: "lt", value: 95, color: "#e8bd68" }] }),
  // 缺陷密度(个/cm²)高于 0.8 提示光刻或沉积工序异常
  metricPreset("defect-density-kpi", "缺陷密度指标卡", "Defect density", "单位面积晶圆缺陷数", "value", "semi.defectDensity", "defectDensity", "个/cm²", { min: 0, max: 3, conditionalRules: [{ id: "defect-high", operator: "gt", value: 0.8, color: "#ff8170" }] }),
  // 套刻精度偏差 >3.5 nm 触发光刻工序报警
  metricPreset("overlay-accuracy-kpi", "套刻精度指标卡", "Overlay accuracy", "光刻套刻偏差", "value", "semi.overlayAccuracy", "overlayDeviation", "nm", { min: 0, max: 10, conditionalRules: [{ id: "overlay-high", operator: "gt", value: 3.5, color: "#ff8170", animation: "pulse" }] }),
  metricPreset("cleanroom-excursion-flip", "洁净室超标翻牌卡", "Cleanroom excursions", "洁净室粒子超标次数翻牌", "digital-flip", "semi.cleanroomExcursion", "excursionCount", "次", { conditionalRules: [{ id: "excursion-exists", operator: "gt", value: 0, color: "#ff8170", animation: "pulse" }] }),
] as const;

export const DASHBOARD_INDUSTRY_KPI_PRESETS_3: readonly DashboardComponentPreset[] = [
  ...POWER_DEEP,
  ...WATER_DEEP,
  ...CHEM_DEEP,
  ...HOSPITAL_DEEP,
  ...GOV_DEEP,
  ...SEMI_PRESETS,
] as const;
