import type { DashboardComponentPreset } from "./dashboardComponentPresetTypes";
import { utilityPreset } from "./dashboardComponentPresetFactory";

/**
 * 控件预设第二批:日期、下拉、多选与精确查询等筛选交互,全部复用 filter 运行时合同。
 * 运行时不含按钮组/开关/Tab 容器,以筛选器的互斥与多选行为承载同等的视图切换语义。
 */
export const DASHBOARD_UTILITY_PRESETS_2: readonly DashboardComponentPreset[] = [
  utilityPreset({ id: "period-date-filter", category: "control", zh: "统计日期筛选", en: "Statistics date filter", descriptionZh: "按统计日期定位当日经营与生产数据", type: "filter", key: "filter.period", previewFamily: "control", widget: { filterField: "date", filterMode: "date", filterMatch: "exact" } }),
  utilityPreset({ id: "supplier-select-filter", category: "control", zh: "供应类别下拉筛选", en: "Supply category filter", descriptionZh: "按供应类别过滤采购与物料数据", type: "filter", key: "filter.supplyCategory", previewFamily: "control", widget: { filterField: "supplyCategory", filterMode: "select", options: ["全部供应", "原材料", "零部件", "包装辅料"] } }),
  utilityPreset({ id: "line-select-filter", category: "control", zh: "产线单选筛选", en: "Line selector", descriptionZh: "单选切换当前分析的产线", type: "filter", key: "filter.line", previewFamily: "control", widget: { filterField: "line", filterMode: "select", options: ["全部产线", "一号产线", "二号产线", "三号产线"] } }),
  utilityPreset({ id: "category-multi-filter", category: "control", zh: "产品类别多选", en: "Product category filter", descriptionZh: "多选产品类别并集过滤页面组件", type: "filter", key: "filter.productCategory", previewFamily: "control", frame: { width: 280, height: 110 }, widget: { filterField: "category", filterMode: "multi-select", options: ["整机", "部件", "配件", "耗材"] } }),
  utilityPreset({ id: "numeric-input-filter", category: "control", zh: "数值精确查询", en: "Numeric exact query", descriptionZh: "输入数量或编号进行精确匹配", type: "filter", key: "filter.numericValue", previewFamily: "control", frame: { width: 280, height: 76 }, widget: { filterField: "quantity", filterMode: "text", filterMatch: "exact" } }),
  utilityPreset({ id: "runstate-toggle-filter", category: "control", zh: "启停状态筛选", en: "Run state filter", descriptionZh: "在运行与停机状态间过滤设备", type: "filter", key: "filter.runState", previewFamily: "control", frame: { width: 280, height: 92 }, widget: { filterField: "runState", filterMode: "multi-select", options: ["运行", "停机"] } }),
  utilityPreset({ id: "site-quick-filter", category: "control", zh: "厂区快捷切换", en: "Site quick switch", descriptionZh: "在总厂与分厂区之间切换分析范围", type: "filter", key: "filter.site", previewFamily: "control", widget: { filterField: "site", filterMode: "select", options: ["全部厂区", "总装厂区", "零部件厂区"] } }),
  utilityPreset({ id: "analysis-view-filter", category: "control", zh: "分析视角切换", en: "Analysis view switch", descriptionZh: "按总览、质量、能耗、交付切换主题", type: "filter", key: "filter.view", previewFamily: "control", widget: { filterField: "view", filterMode: "select", options: ["总览", "质量", "能耗", "交付"] } }),

  // 级联筛选变体(波次 F):parentFilterKey 表达父子层级,父参数未选时子筛选禁用。
  utilityPreset({ id: "province-city-cascade-filter", category: "control", zh: "省市级联筛选", en: "Province-city cascade", descriptionZh: "选择省份后启用城市级联过滤", type: "filter", key: "filter.city", previewFamily: "control", frame: { width: 280, height: 82 }, widget: { filterField: "city", filterMode: "select", parentFilterKey: "filter.province", options: ["全部城市", "杭州", "宁波", "温州"] } }),
  utilityPreset({ id: "plant-line-cascade-filter", category: "control", zh: "厂线级联筛选", en: "Plant-line cascade", descriptionZh: "选择厂区后启用产线级联过滤", type: "filter", key: "filter.cascadeLine", previewFamily: "control", frame: { width: 280, height: 82 }, widget: { filterField: "cascadeLine", filterMode: "select", parentFilterKey: "filter.plant", options: ["全部产线", "一号产线", "二号产线"] } }),
  // 日期区间筛选对(波次 F):起始与截止两个 date 控件组合承载区间语义。
  utilityPreset({ id: "range-start-date-filter", category: "control", zh: "区间起始日期筛选", en: "Range start date filter", descriptionZh: "日期区间的起始端点过滤", type: "filter", key: "filter.startDate", previewFamily: "control", widget: { filterField: "startDate", filterMode: "date", filterMatch: "exact" } }),
  utilityPreset({ id: "range-end-date-filter", category: "control", zh: "区间截止日期筛选", en: "Range end date filter", descriptionZh: "日期区间的截止端点过滤", type: "filter", key: "filter.endDate", previewFamily: "control", widget: { filterField: "endDate", filterMode: "date", filterMatch: "exact" } }),
] as const;
