import type {
  DashboardAggregation,
  DashboardDataWidgetConfig,
  DashboardDataWidgetNode,
  DashboardSampleData,
  SceneDashboardWidgetType,
} from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import {
  DAILY_PERIODS, DOMAIN_RHYTHMS, HOURLY_PERIODS, MONTH_PERIODS, WEEKLY_PERIODS,
  HIERARCHY_TREES, FUNNEL_STAGES, VIEW_SAMPLE_PROFILES,
  type DomainRhythm, type DomainRhythmEvent, type RhythmAxis,
} from "./templateSampleDataProfiles";

/**
 * 模板示例数据生成器(纯逻辑,无 DOM/React;studio 层不反向依赖 components,
 * 通过结构化 spec 接收模板定义,DashboardTemplateDefinition 天然满足该结构)。
 * 约束:同 id 确定性一致(FNV-1a + mulberry32);趋势按行业域节律表注入"行业时钟"
 * (早晚双峰/周末低谷/停机凹坑/交易日缺口,见 DOMAIN_RHYTHMS),未列出的域回退
 * 通用周期+噪声;告警语义趋势保证 1-2 个越限期间;与 buildDashboardSampleMetric
 * 的取数语义对齐;行内携带 filterField 联动列;满足 contracts
 * DASHBOARD_SAMPLE_LIMITS(行 ≤100、列 ≤16、128KB)。
 */

/** 结构化模板样例规格(components/dashboardTemplateTypes 的结构子集)。 */
export interface TemplateSampleSpec {
  id: string;
  /** 行业域 id:驱动趋势节律表选择;缺省或未收录的域用通用周期。 */
  domainId?: string;
  viewId: string;
  filterField: string;
  metrics: readonly { zh: string; en: string; unit: string; dataKey: string; role?: string }[];
  layout: {
    primaryChart: SceneDashboardWidgetType;
    secondaryChart: SceneDashboardWidgetType;
    detailType: "rank" | "table" | "scroll-table";
    metricTypes: readonly string[];
  };
}

type SampleRow = DashboardSampleData["rows"][number];

/** 主图为地图时无法真渲染(示例不含 GeoJSON,插入后同样显示"请配置 GeoJSON"),封面保持 SVG 插画。 */
export function templateSupportsRealCover(layout: Pick<TemplateSampleSpec["layout"], "primaryChart">): boolean {
  return layout.primaryChart !== "map";
}

/** 给布局工厂产出的 9 节点追加示例数据;返回新数组,不修改入参。 */
export function applyTemplateSampleData(
  nodes: DashboardDataWidgetNode[],
  spec: TemplateSampleSpec,
  locale: AppLocale,
): DashboardDataWidgetNode[] {
  const context = createSampleContext(spec, locale);
  return nodes.map((node) => {
    if (node.kind !== "data-widget") return node;
    const widget = node.widget;
    if (widget.type === "decoration" || widget.type === "filter" || widget.type === "text" || widget.type === "shape") return node;
    const metricIndex = spec.metrics.findIndex((metric) => widget.key === `${spec.id}.${metric.dataKey}`);
    const patch = metricIndex >= 0
      ? metricSamplePatch(context, metricIndex)
      : chartSamplePatch(context, widget);
    if (!patch) return node;
    // 对齐 applyProductionSample / applyPackPageSample:示例模板的告警脉冲规则随样例一并移除,
    // 避免"gt 0 恒成立"导致指标卡永远红色呼吸(示例行必然 > 0)。
    delete patch.conditionalRules;
    return { ...node, widget: { ...widget, ...patch } as DashboardDataWidgetConfig };
  });
}

interface SampleContext {
  spec: TemplateSampleSpec;
  locale: AppLocale;
  metricNames: string[]; // 4 个指标的翻译列名(即行数据的字段键)
  categoryColumn: string;
  categories: readonly { zh: string; en: string }[];
  periodColumn: string;
  periods: readonly { zh: string; en: string }[];
  /** 行业节律(未收录的域为 undefined,趋势回退通用周期+噪声)。 */
  rhythm: DomainRhythm | undefined;
  random: () => number;
}

/** 各期轴的期间表与趋势维度列名:列名进 analysis.dimensionField,随轴给业务名。 */
const RHYTHM_PERIOD_TABLES: Record<RhythmAxis, readonly { zh: string; en: string }[]> = {
  hourly: HOURLY_PERIODS, weekly: WEEKLY_PERIODS, daily: DAILY_PERIODS, monthly: MONTH_PERIODS,
};
const RHYTHM_PERIOD_COLUMNS: Record<RhythmAxis, readonly [string, string]> = {
  hourly: ["时刻", "Time"], weekly: ["星期", "Day"], daily: ["日期", "Date"], monthly: ["期间", "Period"],
};

function createSampleContext(spec: TemplateSampleSpec, locale: AppLocale): SampleContext {
  const view = VIEW_SAMPLE_PROFILES[spec.viewId] ?? VIEW_SAMPLE_PROFILES.executive!;
  const random = mulberry32(fnv1a(spec.id));
  const rhythm = spec.domainId ? DOMAIN_RHYTHMS[spec.domainId] : undefined;
  const axis = rhythm?.axis ?? "monthly";
  return {
    spec,
    locale,
    metricNames: spec.metrics.map((metric) => tr(locale, metric.zh, metric.en)),
    categoryColumn: tr(locale, view.categoryZh, view.categoryEn),
    categories: view.categories,
    periodColumn: tr(locale, RHYTHM_PERIOD_COLUMNS[axis][0], RHYTHM_PERIOD_COLUMNS[axis][1]),
    periods: RHYTHM_PERIOD_TABLES[axis],
    rhythm,
    random,
  };
}

type SamplePatch = Partial<DashboardDataWidgetConfig> & { sampleData: DashboardSampleData };

/** 指标卡(值/翻牌/进度/状态):小表 + 聚合,数值单位与小数位跟模板指标定义一致。 */
function metricSamplePatch(context: SampleContext, index: number): SamplePatch {
  const { spec, locale, metricNames, categoryColumn, categories, random } = context;
  const metric = spec.metrics[index]!;
  const field = metricNames[index]!;
  const widgetType = spec.layout.metricTypes[index] ?? "value";
  const sample = (rows: SampleRow[], aggregation: DashboardAggregation = "sum"): SamplePatch => ({
    ...baseSample(spec.id, rows),
    field,
    analysis: { measureField: field, aggregation },
  });
  if (widgetType === "status") {
    // 状态位消费设备信号字面量;首行固定"正常",封面与插入初始观感保持冷静。
    const states = [tr(locale, "正常", "Normal"), tr(locale, "预警", "Warning"), tr(locale, "告警", "Alarm")];
    const rows: SampleRow[] = states.map((state, stateIndex) => ({
      [categoryColumn]: tr(locale, categories[stateIndex % categories.length]!.zh, categories[stateIndex % categories.length]!.en),
      [spec.filterField]: state,
      [field]: state,
    }));
    return sample(rows, "none");
  }
  const shape = metricShape(spec, index, widgetType);
  const rows: SampleRow[] = categories.map((category, categoryIndex) => ({
    [categoryColumn]: tr(locale, category.zh, category.en),
    [spec.filterField]: filterState(context, categoryIndex),
    [field]: round(shape.base + (random() - 0.5) * shape.spread, shape.decimals),
  }));
  return sample(rows, shape.aggregation);
}

/** 主图/次图/明细:按图型给出各自可信的行形状。widget.key 形如 `${spec.id}.primary.${type}`。 */
function chartSamplePatch(context: SampleContext, widget: DashboardDataWidgetConfig): SamplePatch | undefined {
  if (!widget.key.startsWith(`${context.spec.id}.`)) return undefined;
  const kind = widget.key.slice(context.spec.id.length + 1).split(".")[0];
  if (kind === "primary") return primaryChartPatch(context, widget.type);
  if (kind === "secondary") return secondaryChartPatch(context, widget.type);
  if (kind === "detail") return detailPatch(context, widget.type);
  return undefined;
}

function primaryChartPatch(context: SampleContext, type: SceneDashboardWidgetType): SamplePatch | undefined {
  switch (type) {
    case "line": case "area": case "combo": case "bar":
      return trendPatch(context, type);
    case "scatter": return scatterPatch(context);
    case "funnel": return funnelPatch(context);
    case "sankey": return sankeyPatch(context);
    // map 主图无内置 GeoJSON(见 templateSupportsRealCover),样例按趋势带准备,插入后可绑地图
    default: return trendPatch(context, "area");
  }
}

function secondaryChartPatch(context: SampleContext, type: SceneDashboardWidgetType): SamplePatch | undefined {
  switch (type) {
    case "pie": return sharePatch(context);
    case "gauge": return gaugePatch(context);
    case "radar": return radarPatch(context);
    case "sunburst": case "treemap": return hierarchyPatch(context);
    case "bar": return sharePatch(context);
    default: return sharePatch(context);
  }
}

/** 趋势带(折线/面积/组合/柱):期间轴按行业域节律(早晚双峰/周末低谷/停机凹坑…),未收录域回退月轴周期+缓变+噪声。 */
function trendPatch(context: SampleContext, type: SceneDashboardWidgetType): SamplePatch {
  const { spec, locale, metricNames, categoryColumn, periodColumn, periods, categories, random, rhythm } = context;
  const field = metricNames[0]!;
  const shape = metricShape(spec, 0, type);
  const periodCount = periods.length;
  // 系列数在所有期间保持一致,否则聚合后会出现断点式的假 0;期数多的轴相应收缩以守住 100 行上限。
  const seriesCount = Math.min(3 + Math.floor(random()), Math.floor(100 / periodCount));
  // 行业偶发事件(停机/检修/开门扰动):全系列同期生效——停机影响整厂;位置由模板种子确定(同 id 复现)。
  const eventPeriods = rhythm?.event ? seededPeriodWindow(rhythm.event, periodCount, random) : undefined;
  // 告警语义趋势:保证 1-2 个越限期间(逐点掷骰在 12-24 期上可能一刺都不出,封面会"看不到事件"),
  // 且尖峰落在节律高值区(业务高峰时段的告警才可见,也不与停机/检修事件同期互相遮形)。
  const alertCandidates = rhythm
    ? rhythm.shape.map((factor, index) => ({ factor, index }))
      .sort((left, right) => right.factor - left.factor)
      .slice(0, Math.max(1, Math.ceil(periodCount / 3)))
      .map(({ index }) => index)
    : periods.map((_, index) => index);
  const alertPeriods = spec.metrics[0]?.role === "risk" ? seededAlertSpikes(alertCandidates, eventPeriods, random) : undefined;
  const alertFactor = alertPeriods ? 1.8 + random() * 0.7 : 1;
  const rows: SampleRow[] = periods.flatMap((period, periodIndex) => {
    const seasonal = rhythm
      ? rhythm.shape[periodIndex]!
      : 1 + 0.12 * Math.sin((periodIndex / periodCount) * Math.PI * 2 + shape.phase);
    // 行业节律已含走势(周末回落/夜间低谷),再叠缓变会把形状抹平;仅通用域保留缓变。
    const drift = rhythm ? 1 : 0.92 + 0.18 * (periodIndex / Math.max(1, periodCount - 1));
    const eventFactor = eventPeriods?.has(periodIndex) ? rhythm!.event!.factor : 1;
    const spike = alertPeriods?.has(periodIndex) ? alertFactor : 1;
    return categories.slice(0, seriesCount).map((category) => {
      const noise = 1 + (random() - 0.5) * shape.noise;
      return {
        [periodColumn]: tr(locale, period.zh, period.en),
        [categoryColumn]: tr(locale, category.zh, category.en),
        [spec.filterField]: filterState(context, periodIndex + category.zh.length),
        [field]: round(shape.base * seasonal * drift * eventFactor * noise * spike, shape.decimals),
      } satisfies SampleRow;
    });
  });
  return {
    ...baseSample(spec.id, rows),
    field,
    unit: tr(locale, spec.metrics[0]!.unit, spec.metrics[0]!.unit),
    analysis: { measureField: field, dimensionField: periodColumn, seriesField: categoryColumn, aggregation: "sum" },
    ...(type === "combo" ? { chart: { showLegend: true } } : {}),
  };
}

/** 占比(饼/柱):类目行,值全为正。 */
function sharePatch(context: SampleContext): SamplePatch {
  const { spec, locale, metricNames, categoryColumn, categories, random } = context;
  const field = metricNames[0]!;
  const shape = metricShape(spec, 0, "bar");
  const rows: SampleRow[] = categories.map((category, index) => ({
    [categoryColumn]: tr(locale, category.zh, category.en),
    [spec.filterField]: filterState(context, index),
    [field]: round(shape.base * (1.4 - index * 0.18) * (0.9 + random() * 0.25), shape.decimals),
  }));
  return {
    ...baseSample(spec.id, rows),
    field,
    unit: tr(locale, spec.metrics[0]!.unit, spec.metrics[0]!.unit),
    analysis: { measureField: field, dimensionField: categoryColumn, aggregation: "sum" },
    chart: { showDataLabels: true },
  };
}

/** 仪表盘:类目行取平均(0-100 口径),表盘指针落在可信区间。 */
function gaugePatch(context: SampleContext): SamplePatch {
  const { spec, locale, metricNames, categoryColumn, categories, random } = context;
  const index = spec.metrics[1]?.unit === "%" ? 1 : 0;
  const field = metricNames[index]!;
  const rows: SampleRow[] = categories.map((category, categoryIndex) => ({
    [categoryColumn]: tr(locale, category.zh, category.en),
    [spec.filterField]: filterState(context, categoryIndex + 1),
    [field]: round(72 + random() * 24, 1),
  }));
  return {
    ...baseSample(spec.id, rows),
    field,
    unit: tr(locale, spec.metrics[index]!.unit, spec.metrics[index]!.unit),
    analysis: { measureField: field, dimensionField: categoryColumn, aggregation: "average" },
  };
}

/** 雷达/漏斗/散点共用的"单度量样本序列"行工厂:名称列 + 筛选列 + 度量列。 */
function singleMeasureRows(
  context: SampleContext,
  nameColumn: { zh: string; en: string },
  names: readonly { zh: string; en: string }[],
  value: (index: number) => number,
  decimals: 0 | 1 = 0,
): SampleRow[] {
  const field = context.metricNames[0]!;
  return names.map((name, index) => ({
    [tr(context.locale, nameColumn.zh, nameColumn.en)]: tr(context.locale, name.zh, name.en),
    [context.spec.filterField]: filterState(context, index),
    [field]: round(value(index), decimals),
  }));
}

/** 雷达:6 个维度位(样本序列末 6 位),0-100 区间拉开形状。 */
function radarPatch(context: SampleContext): SamplePatch {
  const { spec, metricNames, random } = context;
  const field = metricNames[0]!;
  const rows = singleMeasureRows(context, { zh: "维度", en: "Dimension" },
    [1, 2, 3, 4, 5, 6].map((index) => ({ zh: `${index}`, en: `${index}` })), (index) => 52 + random() * 46);
  return { ...baseSample(spec.id, rows), field, unit: tr(context.locale, spec.metrics[0]!.unit, spec.metrics[0]!.unit), analysis: { measureField: field, aggregation: "none" } };
}

/** 漏斗:6 个阶段单调递减(转化语义)。 */
function funnelPatch(context: SampleContext): SamplePatch {
  const { spec, metricNames, random } = context;
  const field = metricNames[0]!;
  const rows = singleMeasureRows(context, { zh: "阶段", en: "Stage" }, FUNNEL_STAGES,
    (index) => shapeFunnelBase(spec) * Math.pow(0.78, index) * (0.92 + random() * 0.16));
  return { ...baseSample(spec.id, rows), field, unit: tr(context.locale, spec.metrics[0]!.unit, spec.metrics[0]!.unit), analysis: { measureField: field, aggregation: "none" } };
}

/** 散点:24 个样本点(渲染按 [序号, 值] 取数),两簇分布。 */
function scatterPatch(context: SampleContext): SamplePatch {
  const { spec, metricNames, random } = context;
  const field = metricNames[0]!;
  const shape = metricShape(spec, 0, "scatter");
  const rows = singleMeasureRows(context, { zh: "样本", en: "Sample" },
    Array.from({ length: 24 }, (_, index) => ({ zh: `${index + 1}`, en: `${index + 1}` })),
    (index) => shape.base * (index % 2 === 0 ? 0.72 : 1.18) * (0.85 + random() * 0.3), shape.decimals);
  return { ...baseSample(spec.id, rows), field, analysis: { measureField: field, aggregation: "none" } };
}

/** 桑基:两级流向(类目 → 干线 → 渠道),source/target/value 列名不进 UI。 */
function sankeyPatch(context: SampleContext): SamplePatch {
  const { spec, locale, categories, random } = context;
  const hubs = [tr(locale, "干线运输", "Line haul"), tr(locale, "区域仓配", "Regional hub")];
  const targets = [tr(locale, "城配", "City delivery"), tr(locale, "直发", "Direct ship"), tr(locale, "越库", "Cross dock")];
  const rows: SampleRow[] = [
    ...categories.slice(0, 4).map((category, index) => ({
      source: tr(locale, category.zh, category.en),
      target: hubs[index % 2]!,
      value: round(600 + random() * 700, 0),
    })),
    ...hubs.flatMap((hub) => targets.map((target) => ({
      source: hub,
      target,
      value: round(260 + random() * 420, 0),
    }))),
  ];
  return {
    ...baseSample(spec.id, rows),
    field: "value",
    analysis: { measureField: "value", dimensionField: "source", seriesField: "target", aggregation: "sum" },
  };
}

/** 旭日/树图:两级层次(层级键按布局语义给业务名),drillFields 驱动 buildDashboardHierarchy。 */
function hierarchyPatch(context: SampleContext): SamplePatch {
  const { spec, locale, random } = context;
  const tree = HIERARCHY_TREES[spec.viewId] ?? HIERARCHY_TREES.finance!;
  const level1 = tr(locale, tree.level1Zh, tree.level1En);
  const level2 = tr(locale, tree.level2Zh, tree.level2En);
  const rows: SampleRow[] = tree.groups.flatMap((group) =>
    tree.children.map((child, childIndex) => ({
      [level1]: tr(locale, group.zh, group.en),
      [level2]: tr(locale, child.zh, child.en),
      [spec.filterField]: filterState(context, childIndex + group.zh.length),
      value: round(180 + random() * 640, 0),
    })));
  return {
    ...baseSample(spec.id, rows),
    field: "value",
    unit: tr(locale, spec.metrics[0]!.unit, spec.metrics[0]!.unit),
    analysis: { measureField: "value", dimensionField: level1, drillFields: [level1, level2], aggregation: "sum" },
  };
}

/** 明细(排行/表格/滚动表):排行按值降序,表格带全指标列;表头即翻译后的指标名。 */
function detailPatch(context: SampleContext, type: SceneDashboardWidgetType): SamplePatch {
  const { spec, locale, metricNames, categoryColumn, categories, random } = context;
  const entityColumn = type === "rank" ? "name" : categoryColumn;
  const shape = metricShape(spec, 0, "bar");
  const rows: SampleRow[] = categories.concat(categories).slice(0, 8).map((category, index) => {
    const row: SampleRow = {
      [entityColumn]: tr(locale, `${category.zh}${index >= categories.length ? "Ⅱ" : ""}`, `${category.en} ${index >= categories.length ? "II" : ""}`.trim()),
      [spec.filterField]: filterState(context, index),
    };
    for (const [metricIndex, name] of metricNames.entries()) {
      const metricShape0 = metricShape(spec, metricIndex, spec.layout.metricTypes[metricIndex] ?? "value");
      row[name] = round(metricShape0.base * (0.8 + random() * 0.4), metricShape0.decimals);
    }
    if (type === "rank") row[metricNames[0]!] = round(shape.base * (1.6 - index * 0.14) * (0.9 + random() * 0.2), shape.decimals);
    return row;
  });
  if (type === "rank") rows.sort((left, right) => Number(right[metricNames[0]!]) - Number(left[metricNames[0]!]));
  const hasPercent = spec.metrics.some((metric) => metric.unit === "%");
  return {
    ...baseSample(spec.id, rows),
    field: metricNames[0]!,
    analysis: { measureField: metricNames[0]!, aggregation: "none" },
    ...(type === "rank" ? {} : {
      report: { mode: "detail", pageSize: 10, stripedRows: true, valueFormat: "number", decimalPlaces: hasPercent ? 1 : 0 } as const,
    }),
  };
}

// ---- 形状与工具 -----------------------------------------------------------------

interface MetricShape { base: number; spread: number; decimals: 0 | 1; noise: number; phase: number; aggregation: "sum" | "average" }

/** 计数型单位(条/处/单/项/件/台/家/起):整数、告警槽位语义。 */
const COUNT_UNITS: ReadonlySet<string> = new Set(["条", "处", "单", "项", "件", "台", "家", "起"]);

/** 按指标序位(模板 4 指标的槽位语义)+ 渲染类型给数值形状;进度/仪表强制 0-100 口径。 */
function metricShape(spec: TemplateSampleSpec, index: number, widgetType: string): MetricShape {
  const unit = spec.metrics[index]?.unit ?? "";
  const seed = (fnv1a(`${spec.id}:${index}`) % 1000) / 1000;
  const shape = (base: number, spread: number, decimals: 0 | 1, noise: number, aggregation: "sum" | "average"): MetricShape =>
    ({ base, spread, decimals, noise, phase: seed * Math.PI * 2, aggregation });
  if (widgetType === "progress" || widgetType === "gauge" || unit === "%") {
    const high = unit === "%" && spec.layout.metricTypes[index] !== "progress";
    return shape(high ? 90 : 78, high ? 9 : 14, 1, 0.05, "average");
  }
  if (COUNT_UNITS.has(unit)) {
    const alertish = index === 3; // 模板第 4 槽位固定承载告警/风险语义(alertRules 也挂在这)
    return shape(alertish ? 4 : 42, alertish ? 6 : 26, 0, 0.22, alertish ? "average" : "sum");
  }
  if (unit === "万元" || unit === "元/件") {
    return shape(unit === "万元" ? 2600 : 46, unit === "万元" ? 900 : 12, 0, 0.12, "sum");
  }
  return shape(320 + seed * 400, 120, 0, 0.14, "sum");
}

const shapeFunnelBase = (spec: TemplateSampleSpec): number => (COUNT_UNITS.has(spec.metrics[0]?.unit ?? "") ? 860 : 4200);

/** 事件窗口:在期轴上按模板种子选一段连续期(位置随模板变化,同 id 复现)。 */
function seededPeriodWindow(event: DomainRhythmEvent, periodCount: number, random: () => number): Set<number> {
  const start = Math.floor(random() * Math.max(1, periodCount - event.width + 1));
  return new Set(Array.from({ length: event.width }, (_, offset) => start + offset));
}

/** 告警越限期:1-2 个散点期间,候选池为节律高值区,避开事件窗口(两种事件叠同期会互相遮形)。 */
function seededAlertSpikes(candidates: readonly number[], exclude: ReadonlySet<number> | undefined, random: () => number): Set<number> {
  const pool = candidates.filter((index) => !exclude?.has(index));
  const picked = new Set<number>();
  if (pool.length === 0) return picked;
  const wanted = Math.min(1 + (random() < 0.45 ? 1 : 0), pool.length);
  for (let guard = 0; picked.size < wanted && guard < 32; guard++) {
    picked.add(pool[Math.floor(random() * pool.length)]!);
  }
  return picked;
}

/** 筛选联动列:值域与布局工厂的筛选器选项(全部/正常/预警/告警)对齐,以"正常"为主。 */
function filterState(context: SampleContext, index: number): string {
  const roll = mulberry32(fnv1a(`${context.spec.id}:filter:${index}`))();
  if (roll < 0.7) return tr(context.locale, "正常", "Normal");
  return roll < 0.9 ? tr(context.locale, "预警", "Warning") : tr(context.locale, "告警", "Alarm");
}

/** sourceId 是身份不是数据,允许随机段(与 applyProductionSample 语义一致);同模板节点共享一组。 */
const baseSample = (templateId: string, rows: SampleRow[]): { sampleData: DashboardSampleData } =>
  ({ sampleData: { sourceId: `sample:${templateId}:${crypto.randomUUID()}`, rows } });

const round = (value: number, decimals: 0 | 1): number => Math.round(value * 10 ** decimals) / 10 ** decimals;

/** FNV-1a 32 位:模板 ID → 稳定种子。 */
function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32:小而稳的确定性 PRNG(测试可复现)。 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    const mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    return ((Math.imul(mixed ^ (mixed >>> 7), 61 | mixed) ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}
