import type { DashboardComponentPreset } from "./dashboardComponentPresetTypes";
import { utilityPreset } from "./dashboardComponentPresetFactory";

/**
 * 区域地图族变体(素材数量波次 F):对既有 8 种制图形态做场景补深,共 12 款。
 * 行政钻取增强 3 / 园区平面 2 / 管廊 2 / 路网 2 / 轨迹 2 / 密度热力 1。
 * 全部落在 map 合同原生 region/scatter/heat/route 模式上,mark 在
 * DashboardComponentPreview 的 MAP_MARK_VARIANTS 中各自命中独立制图构图。
 */

const MAP_FRAME = { width: 560, height: 340 };

export const DASHBOARD_GIS_VARIANT_PRESETS: readonly DashboardComponentPreset[] = [
  // ── 行政区划钻取增强(region + drillFields 三级)────────────────────
  utilityPreset({ id: "county-economy-drill-map", category: "gis", zh: "县域经济钻取地图", en: "County economy drill map", descriptionZh: "省-县-镇三级下钻经济总量分布", type: "map", key: "gis.countyEconomy", previewFamily: "gis", frame: MAP_FRAME, widget: { map: { mode: "region", regionField: "county", valueField: "gdp" }, linkageParameterKey: "filter.county", analysis: { dimensionField: "county", measureField: "gdp", aggregation: "sum", drillFields: ["province", "county", "town"] } } }),
  utilityPreset({ id: "district-grid-drill-map", category: "gis", zh: "街道网格事件钻取地图", en: "Street grid drill map", descriptionZh: "市-街道-网格逐级下钻治理事件量", type: "map", key: "gis.streetGrid", previewFamily: "gis", frame: MAP_FRAME, widget: { map: { mode: "region", regionField: "street", valueField: "events" }, linkageParameterKey: "filter.street", analysis: { dimensionField: "street", measureField: "events", aggregation: "sum", drillFields: ["city", "street", "grid"] } } }),
  utilityPreset({ id: "region-sales-drill-map", category: "gis", zh: "区域销售钻取地图", en: "Region sales drill map", descriptionZh: "大区-省-市逐级下钻销售额", type: "map", key: "gis.regionSales", previewFamily: "gis", frame: MAP_FRAME, widget: { map: { mode: "region", regionField: "province", valueField: "sales" }, linkageParameterKey: "filter.province", analysis: { dimensionField: "province", measureField: "sales", aggregation: "sum", drillFields: ["region", "province", "city"] } } }),
  // ── 园区平面标注(scatter + 平面语义)──────────────────────────────
  utilityPreset({ id: "factory-safety-zone-map", category: "gis", zh: "厂区安全分区标注地图", en: "Factory safety zone map", descriptionZh: "厂区平面标注危化与作业安全分区", type: "map", key: "gis.factorySafety", previewFamily: "gis", frame: MAP_FRAME, widget: { map: { mode: "scatter", longitudeField: "longitude", latitudeField: "latitude", valueField: "riskLevel" }, linkageParameterKey: "filter.zone" } }),
  utilityPreset({ id: "campus-energy-zone-map", category: "gis", zh: "校园能耗分区标注地图", en: "Campus energy zone map", descriptionZh: "校园平面按楼宇标注能耗强度", type: "map", key: "gis.campusEnergy", previewFamily: "gis", frame: MAP_FRAME, widget: { map: { mode: "scatter", longitudeField: "longitude", latitudeField: "latitude", valueField: "energy" }, linkageParameterKey: "filter.building" } }),
  // ── 管廊(route + 舱室语义)────────────────────────────────────────
  utilityPreset({ id: "utility-corridor-map", category: "gis", zh: "综合管廊舱室地图", en: "Utility corridor map", descriptionZh: "综合管廊走向标注电力水务舱室", type: "map", key: "gis.utilityCorridor", previewFamily: "gis", frame: MAP_FRAME, widget: { map: { mode: "route", longitudeField: "longitude", latitudeField: "latitude", valueField: "cabinLoad" }, linkageParameterKey: "filter.cabin" } }),
  utilityPreset({ id: "gas-patrol-map", category: "gis", zh: "燃气管网巡检地图", en: "Gas patrol map", descriptionZh: "燃气管线走向与巡检点状态", type: "map", key: "gis.gasPatrol", previewFamily: "gis", frame: MAP_FRAME, widget: { map: { mode: "route", longitudeField: "longitude", latitudeField: "latitude", valueField: "pressure" } } }),
  // ── 路网(heat + 路况语义)─────────────────────────────────────────
  utilityPreset({ id: "expressway-speed-map", category: "gis", zh: "快速路车速路况地图", en: "Expressway speed map", descriptionZh: "快速路车速聚合成路况热力发现拥堵", type: "map", key: "gis.expresswaySpeed", previewFamily: "gis", frame: MAP_FRAME, widget: { map: { mode: "heat", longitudeField: "longitude", latitudeField: "latitude", valueField: "speed" } } }),
  utilityPreset({ id: "bus-coverage-map", category: "gis", zh: "公交线网覆盖地图", en: "Bus coverage map", descriptionZh: "公交线网覆盖密度与站点客流热力", type: "map", key: "gis.busCoverage", previewFamily: "gis", frame: MAP_FRAME, widget: { map: { mode: "heat", longitudeField: "longitude", latitudeField: "latitude", valueField: "ridership" } } }),
  // ── 轨迹(route + 目标回放语义)────────────────────────────────────
  utilityPreset({ id: "hazmat-trajectory-map", category: "gis", zh: "危化品运输轨迹地图", en: "Hazmat trajectory map", descriptionZh: "危化品车辆轨迹回放与电子围栏", type: "map", key: "gis.hazmatTrajectory", previewFamily: "gis", frame: MAP_FRAME, widget: { map: { mode: "route", longitudeField: "longitude", latitudeField: "latitude", valueField: "speed" }, linkageParameterKey: "filter.vehicle" } }),
  utilityPreset({ id: "agv-patrol-map", category: "gis", zh: "AGV 巡检轨迹地图", en: "AGV patrol map", descriptionZh: "厂区 AGV 巡检轨迹与任务点位", type: "map", key: "gis.agvPatrol", previewFamily: "gis", frame: MAP_FRAME, widget: { map: { mode: "route", longitudeField: "longitude", latitudeField: "latitude", valueField: "progress" } } }),
  // ── 密度热力(heat + 人群语义)─────────────────────────────────────
  utilityPreset({ id: "crowd-density-map", category: "gis", zh: "人群聚集热力地图", en: "Crowd density map", descriptionZh: "重点区域人群聚集密度热力预警", type: "map", key: "gis.crowdDensity", previewFamily: "gis", frame: MAP_FRAME, widget: { map: { mode: "heat", longitudeField: "longitude", latitudeField: "latitude", valueField: "crowd" } } }),
] as const;
