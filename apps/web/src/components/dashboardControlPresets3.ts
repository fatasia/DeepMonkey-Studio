import type { DashboardComponentPreset } from "./dashboardComponentPresetTypes";
import { utilityPreset } from "./dashboardComponentPresetFactory";

/**
 * 控件族(素材数量波次 A):12 款筛选交互,覆盖级联、日期、数值、多选、
 * 下拉、层级树、开关组、评分档、轮播、图层、视角与步进检索。
 * 全部落在 filter 运行时合同(select / multi-select / text / date +
 * parentFilterKey 层级联动),不虚构运行时不存在的控件形态。
 */
export const DASHBOARD_CONTROL_PRESETS_3: readonly DashboardComponentPreset[] = [
  utilityPreset({ id: "region-industry-cascade", category: "control", zh: "区域行业级联筛选", en: "Region-industry cascade", descriptionZh: "受区域参数约束的行业分类级联筛选", type: "filter", key: "filter.industry", previewFamily: "control", frame: { width: 280, height: 82 }, widget: { filterField: "industry", parentFilterKey: "filter.region", filterMode: "select", options: ["全部行业", "制造", "能源", "水务", "医疗"] } }),
  utilityPreset({ id: "report-date-range", category: "control", zh: "报表日期区间筛选", en: "Report date filter", descriptionZh: "按报表业务日期定位统计区间起点", type: "filter", key: "filter.reportDate", previewFamily: "control", widget: { filterField: "reportDate", filterMode: "date", filterMatch: "exact" } }),
  utilityPreset({ id: "output-numeric-filter", category: "control", zh: "产量数值筛选", en: "Output numeric filter", descriptionZh: "输入产量数值对记录做精确过滤", type: "filter", key: "filter.outputValue", previewFamily: "control", frame: { width: 280, height: 76 }, widget: { filterField: "output", filterMode: "text", filterMatch: "exact" } }),
  utilityPreset({ id: "process-tag-multi", category: "control", zh: "工艺标签多选", en: "Process tag filter", descriptionZh: "多选工艺标签并集过滤工单数据", type: "filter", key: "filter.processTag", previewFamily: "control", frame: { width: 280, height: 110 }, widget: { filterField: "processTag", filterMode: "multi-select", options: ["喷涂", "焊接", "装配", "检测"] } }),
  utilityPreset({ id: "customer-search-select", category: "control", zh: "客户名称下拉", en: "Customer selector", descriptionZh: "长客户列表下拉单选过滤订单视图", type: "filter", key: "filter.customer", previewFamily: "control", widget: { filterField: "customer", filterMode: "select", options: ["全部客户", "华东重工", "华南快消", "西北能源"] } }),
  utilityPreset({ id: "floor-tree-select", category: "control", zh: "楼层层级选择", en: "Floor level selector", descriptionZh: "受楼栋参数约束的楼层树形逐级选择", type: "filter", key: "filter.floor", previewFamily: "control", frame: { width: 280, height: 82 }, widget: { filterField: "floor", parentFilterKey: "filter.building", filterMode: "select", options: ["全部楼层", "F1", "F2", "F3"] } }),
  utilityPreset({ id: "interlock-toggle-group", category: "control", zh: "联锁开关组", en: "Interlock toggle group", descriptionZh: "按联锁投用状态组合过滤回路", type: "filter", key: "filter.interlockState", previewFamily: "control", frame: { width: 280, height: 92 }, widget: { filterField: "interlockState", filterMode: "multi-select", options: ["联锁投用", "联锁切除"] } }),
  utilityPreset({ id: "rating-tier-filter", category: "control", zh: "评分档位筛选", en: "Rating tier filter", descriptionZh: "按评价星级档位过滤服务工单", type: "filter", key: "filter.ratingTier", previewFamily: "control", frame: { width: 280, height: 110 }, widget: { filterField: "rating", filterMode: "multi-select", options: ["五星", "四星", "三星", "三星以下"] } }),
  utilityPreset({ id: "patrol-carousel-switch", category: "control", zh: "巡检轮播切换", en: "Patrol carousel switch", descriptionZh: "切换监控轮播的时段与巡检分组", type: "filter", key: "filter.carouselPlan", previewFamily: "control", widget: { filterField: "carouselPlan", filterMode: "select", options: ["全天轮播", "白天班巡播", "夜间班巡播"] } }),
  utilityPreset({ id: "layer-toggle-group", category: "control", zh: "图层开关组", en: "Layer toggle group", descriptionZh: "勾选设备、管线、安防图层过滤显示", type: "filter", key: "filter.layerGroup", previewFamily: "control", frame: { width: 280, height: 110 }, widget: { filterField: "layerGroup", filterMode: "multi-select", options: ["设备图层", "管线图层", "安防图层", "能耗图层"] } }),
  utilityPreset({ id: "camera-view-switch", category: "control", zh: "相机视角切换", en: "Camera view switch", descriptionZh: "切换三维联动相机的预设视角", type: "filter", key: "filter.cameraView", previewFamily: "control", widget: { filterField: "cameraView", filterMode: "select", options: ["全景俯瞰", "车间巡航", "装卸特写"] } }),
  utilityPreset({ id: "batch-step-search", category: "control", zh: "批次步进查询", en: "Batch step search", descriptionZh: "按批次前缀逐段步进检索记录", type: "filter", key: "filter.batchPrefix", previewFamily: "control", frame: { width: 280, height: 76 }, widget: { filterField: "batchNo", filterMode: "text", filterMatch: "contains" } }),
] as const;
