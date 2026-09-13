/**
 * 模板示例数据的"业务语义词表"(纯数据,无逻辑):10 视角的维度名/类目、期间、漏斗阶段、
 * 层次树。数据可信度来自"维度名像业务",不来自随机数;新增视角时在此登记。
 */

export interface ViewSampleProfile { categoryZh: string; categoryEn: string; categories: readonly { zh: string; en: string }[] }

export const VIEW_SAMPLE_PROFILES: Record<string, ViewSampleProfile> = {
  executive: { categoryZh: "业务单元", categoryEn: "Business unit", categories: [
    { zh: "华东", en: "East" }, { zh: "华北", en: "North" }, { zh: "华南", en: "South" }, { zh: "西部", en: "West" }, { zh: "海外", en: "Overseas" }] },
  operations: { categoryZh: "班次", categoryEn: "Shift", categories: [
    { zh: "早班", en: "Day" }, { zh: "中班", en: "Swing" }, { zh: "晚班", en: "Night" }, { zh: "夜班", en: "Midnight" }] },
  quality: { categoryZh: "质量等级", categoryEn: "Quality grade", categories: [
    { zh: "优", en: "Excellent" }, { zh: "良", en: "Good" }, { zh: "合格", en: "Pass" }, { zh: "待改进", en: "Rework" }] },
  risk: { categoryZh: "风险区域", categoryEn: "Risk area", categories: [
    { zh: "生产区", en: "Production" }, { zh: "仓储区", en: "Warehouse" }, { zh: "公辅区", en: "Utilities" }, { zh: "办公区", en: "Office" }] },
  asset: { categoryZh: "资产类别", categoryEn: "Asset class", categories: [
    { zh: "关键设备", en: "Critical" }, { zh: "一般设备", en: "General" }, { zh: "辅助设备", en: "Auxiliary" }, { zh: "备件", en: "Spares" }] },
  energy: { categoryZh: "能源介质", categoryEn: "Energy medium", categories: [
    { zh: "电力", en: "Power" }, { zh: "蒸汽", en: "Steam" }, { zh: "天然气", en: "Gas" }, { zh: "压缩空气", en: "Air" }] },
  supply: { categoryZh: "供货区域", categoryEn: "Region", categories: [
    { zh: "华东仓", en: "East DC" }, { zh: "华北仓", en: "North DC" }, { zh: "华南仓", en: "South DC" }, { zh: "西部仓", en: "West DC" }] },
  service: { categoryZh: "服务渠道", categoryEn: "Channel", categories: [
    { zh: "在线客服", en: "Online" }, { zh: "服务热线", en: "Hotline" }, { zh: "工单", en: "Ticket" }, { zh: "现场", en: "On-site" }] },
  finance: { categoryZh: "成本中心", categoryEn: "Cost center", categories: [
    { zh: "研发", en: "R&D" }, { zh: "制造", en: "Manufacturing" }, { zh: "销售", en: "Sales" }, { zh: "职能", en: "G&A" }] },
  sustainability: { categoryZh: "核算边界", categoryEn: "Boundary", categories: [
    { zh: "范围一", en: "Scope 1" }, { zh: "范围二", en: "Scope 2" }, { zh: "范围三", en: "Scope 3" }, { zh: "运营", en: "Operations" }] },
};

export const MONTH_PERIODS: readonly { zh: string; en: string }[] = [
  { zh: "1月", en: "Jan" }, { zh: "2月", en: "Feb" }, { zh: "3月", en: "Mar" }, { zh: "4月", en: "Apr" },
  { zh: "5月", en: "May" }, { zh: "6月", en: "Jun" }, { zh: "7月", en: "Jul" }, { zh: "8月", en: "Aug" },
  { zh: "9月", en: "Sep" }, { zh: "10月", en: "Oct" }, { zh: "11月", en: "Nov" }, { zh: "12月", en: "Dec" },
];

export const FUNNEL_STAGES: readonly { zh: string; en: string }[] = [
  { zh: "咨询", en: "Inquiry" }, { zh: "意向", en: "Intent" }, { zh: "方案", en: "Proposal" },
  { zh: "报价", en: "Quote" }, { zh: "成交", en: "Closed" }, { zh: "复购", en: "Repeat" },
];

// ---- 行业节律(波次 D:趋势带的"行业时钟") ---------------------------------------
// 封面上的趋势形状必须带行业语义:电站负荷早晚双峰、门诊量周末低谷、水务清晨/傍晚双峰。
// 节律 = 固有形状(shape,行业事实,不随模板变)+ 偶发事件(event,位置由模板种子确定)。

/** 趋势期轴:hourly=日内 24 期 / weekly=周一至周日 / daily=展期 30 天 / monthly=12 月(通用回退)。 */
export type RhythmAxis = "hourly" | "weekly" | "daily" | "monthly";

/** 模板级偶发事件:dip 停机凹坑 / step 计划检修台阶 / spike 扰动尖峰(开门、越限)。 */
export interface DomainRhythmEvent { kind: "dip" | "step" | "spike"; width: number; factor: number }

export interface DomainRhythm {
  axis: RhythmAxis;
  /** 行业固有节律,乘性系数(基线 1);长度必须等于轴期数(测试 DOMAIN_RHYTHMS 长度守卫)。 */
  shape: readonly number[];
  event?: DomainRhythmEvent;
}

export const HOURLY_PERIODS: readonly { zh: string; en: string }[] = Array.from({ length: 24 }, (_, hour) => ({
  zh: `${String(hour).padStart(2, "0")}时`, en: `${String(hour).padStart(2, "0")}:00`,
}));

export const WEEKLY_PERIODS: readonly { zh: string; en: string }[] = [
  { zh: "周一", en: "Mon" }, { zh: "周二", en: "Tue" }, { zh: "周三", en: "Wed" }, { zh: "周四", en: "Thu" },
  { zh: "周五", en: "Fri" }, { zh: "周六", en: "Sat" }, { zh: "周日", en: "Sun" },
];

export const DAILY_PERIODS: readonly { zh: string; en: string }[] = Array.from({ length: 30 }, (_, index) => ({
  zh: `第${index + 1}天`, en: `D${index + 1}`,
}));

/** 平稳生产日(白班略高、夜班略低),供"平稳+偶发停机凹坑"族叠加 dip 事件。 */
const HOUR_STABLE_SHIFT: readonly number[] = [
  0.86, 0.83, 0.82, 0.82, 0.84, 0.88, 0.96, 1.02, 1.06, 1.08, 1.08, 1.06,
  1.03, 1.03, 1.05, 1.07, 1.07, 1.05, 1.0, 0.96, 0.92, 0.9, 0.88, 0.86,
];
/** 电网负荷曲线:早峰 9 时、晚峰 19 时、凌晨低谷。 */
const HOUR_LOAD_DOUBLE_PEAK: readonly number[] = [
  0.55, 0.5, 0.48, 0.46, 0.47, 0.55, 0.75, 0.95, 1.25, 1.35, 1.3, 1.15,
  0.95, 0.85, 0.82, 0.85, 0.95, 1.15, 1.35, 1.4, 1.35, 1.2, 0.95, 0.7,
];
/** 枢纽客流:7-9 时 / 17-19 时尖锐双峰,凌晨近停运。 */
const HOUR_RUSH_PEAKS: readonly number[] = [
  0.15, 0.1, 0.08, 0.07, 0.08, 0.18, 0.45, 0.9, 1.45, 1.2, 0.8, 0.7,
  0.72, 0.7, 0.72, 0.78, 0.95, 1.5, 1.7, 1.4, 0.9, 0.6, 0.4, 0.22,
];
/** 供水双峰:清晨 7 时 / 傍晚 19 时,夜间低位。 */
const HOUR_WATER_PEAKS: readonly number[] = [
  0.5, 0.45, 0.42, 0.4, 0.45, 0.7, 1.15, 1.35, 1.2, 1.0, 0.9, 0.85,
  0.82, 0.8, 0.8, 0.82, 0.88, 1.05, 1.3, 1.35, 1.2, 1.0, 0.8, 0.6,
];
/** 冷链库门开启:营业时段高频、夜间低温稳态近零,叠加开门扰动 spike。 */
const HOUR_DOOR_TRAFFIC: readonly number[] = [
  0.08, 0.06, 0.05, 0.05, 0.05, 0.1, 0.4, 0.8, 1.1, 1.25, 1.3, 1.3,
  1.25, 1.2, 1.25, 1.3, 1.25, 1.15, 0.95, 0.7, 0.45, 0.3, 0.18, 0.1,
];
/** 医院:工作日满负荷、周末门诊收缩(周六保留半天)。 */
const WEEK_CLINIC_WORKDAY: readonly number[] = [1.06, 1.1, 1.06, 1.02, 1.0, 0.55, 0.44];
/** 文旅:周末脉冲(周六顶点),周中平淡。 */
const WEEK_WEEKEND_BURST: readonly number[] = [0.72, 0.75, 0.78, 0.8, 1.12, 1.5, 1.32];
/** 政务大厅:工作日办事、周末闭厅。 */
const WEEK_HALL_WORKDAY: readonly number[] = [1.1, 1.05, 1.02, 1.0, 0.98, 0.04, 0.03];
/** 金融:交易日历缺口,周末无交易。 */
const WEEK_TRADING_GAP: readonly number[] = [1.03, 1.06, 1.02, 1.0, 1.04, 0.02, 0.02];
/** 化工连续流程:整年稳态运行(计划检修以 step 事件叠加,不用形状表达)。 */
const MONTH_STEADY_PROCESS: readonly number[] = [1, 1, 1, 1, 0.99, 1, 1, 1, 1.01, 1, 1, 0.99];
/** 农业季节缓变:夏峰冬谷,相邻月差 ≤0.1。 */
const MONTH_SEASON_GLIDE: readonly number[] = [0.72, 0.75, 0.82, 0.92, 1.02, 1.12, 1.2, 1.18, 1.08, 0.95, 0.82, 0.74];
/** 会展展期:开幕日脉冲后缓降、撤展收尾(开幕期固定是行业事实,不用事件表达)。 */
const DAY_EXPO_PULSE: readonly number[] = [
  0.16, 0.14, 2.6, 1.95, 1.6, 1.32, 1.05,
  0.42, 0.4, 0.38, 0.36, 0.34, 0.33, 0.31, 0.3, 0.29, 0.28, 0.27, 0.26, 0.25, 0.25, 0.24, 0.24, 0.23, 0.23,
  0.2, 0.18, 0.15, 0.12, 0.1,
];

/**
 * 按 domainId 的行业节律表:只收录有明确"行业时钟"的域;未列出的域在生成器里
 * 回退通用周期+噪声。production 的 executive 视角走手写样例管线(dashboardProductionSample),
 * 不消费本表,但同域其余视角仍按停机凹坑生成。
 */
export const DOMAIN_RHYTHMS: Record<string, DomainRhythm> = {
  // 生产制造族:平稳日班形状 + 偶发停机凹坑(连续 2 期深坑)。
  production: { axis: "hourly", shape: HOUR_STABLE_SHIFT, event: { kind: "dip", width: 2, factor: 0.12 } },
  maintenance: { axis: "hourly", shape: HOUR_STABLE_SHIFT, event: { kind: "dip", width: 2, factor: 0.12 } },
  semiconductor: { axis: "hourly", shape: HOUR_STABLE_SHIFT, event: { kind: "dip", width: 2, factor: 0.12 } },
  automotive: { axis: "hourly", shape: HOUR_STABLE_SHIFT, event: { kind: "dip", width: 2, factor: 0.12 } },
  pharma: { axis: "hourly", shape: HOUR_STABLE_SHIFT, event: { kind: "dip", width: 2, factor: 0.12 } },
  // 电力交易/交通/水务:各自的日内双峰时钟。
  "power-trading": { axis: "hourly", shape: HOUR_LOAD_DOUBLE_PEAK },
  transport: { axis: "hourly", shape: HOUR_RUSH_PEAKS },
  water: { axis: "hourly", shape: HOUR_WATER_PEAKS },
  // 冷链:营业时段开门高频 + 开门扰动尖峰,夜间低温稳态。
  "cold-chain": { axis: "hourly", shape: HOUR_DOOR_TRAFFIC, event: { kind: "spike", width: 1, factor: 1.8 } },
  // 医院/政务/金融:周节律(工作日 vs 周末)。
  healthcare: { axis: "weekly", shape: WEEK_CLINIC_WORKDAY },
  government: { axis: "weekly", shape: WEEK_HALL_WORKDAY },
  finance: { axis: "weekly", shape: WEEK_TRADING_GAP },
  // 文旅:周末脉冲。
  tourism: { axis: "weekly", shape: WEEK_WEEKEND_BURST },
  // 化工:连续稳态 + 计划检修台阶;化工安全同为连续流程(安全监控无降负荷事件)。
  petrochemical: { axis: "monthly", shape: MONTH_STEADY_PROCESS, event: { kind: "step", width: 2, factor: 0.55 } },
  "chem-safety": { axis: "monthly", shape: MONTH_STEADY_PROCESS },
  // 农业:季节缓变。
  agriculture: { axis: "monthly", shape: MONTH_SEASON_GLIDE },
  // 会展:开幕日脉冲(30 天展期轴)。
  expo: { axis: "daily", shape: DAY_EXPO_PULSE },
};

export interface HierarchyTree { level1Zh: string; level1En: string; level2Zh: string; level2En: string; groups: readonly { zh: string; en: string }[]; children: readonly { zh: string; en: string }[] }

/** 旭日/树图的两级语义按布局视角给业务名,避免"分类 A/B"式的假数据。 */
export const HIERARCHY_TREES: Record<string, HierarchyTree> = {
  energy: {
    level1Zh: "能源介质", level1En: "Medium", level2Zh: "用途", level2En: "Usage",
    groups: [{ zh: "电力", en: "Power" }, { zh: "蒸汽", en: "Steam" }, { zh: "天然气", en: "Gas" }, { zh: "压缩空气", en: "Air" }],
    children: [{ zh: "生产", en: "Production" }, { zh: "供暖", en: "Heating" }, { zh: "照明", en: "Lighting" }],
  },
  finance: {
    level1Zh: "成本中心", level1En: "Cost center", level2Zh: "科目", level2En: "Item",
    groups: [{ zh: "研发", en: "R&D" }, { zh: "制造", en: "Manufacturing" }, { zh: "销售", en: "Sales" }, { zh: "职能", en: "G&A" }],
    children: [{ zh: "人工", en: "Labor" }, { zh: "材料", en: "Material" }, { zh: "物流", en: "Logistics" }],
  },
  supply: {
    level1Zh: "区域仓", level1En: "DC", level2Zh: "运输方式", level2En: "Mode",
    groups: [{ zh: "华东仓", en: "East DC" }, { zh: "华北仓", en: "North DC" }, { zh: "华南仓", en: "South DC" }],
    children: [{ zh: "公路", en: "Road" }, { zh: "铁路", en: "Rail" }, { zh: "水运", en: "Water" }, { zh: "航空", en: "Air" }],
  },
};
