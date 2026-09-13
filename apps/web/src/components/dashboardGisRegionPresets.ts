import type { DashboardComponentPreset } from "./dashboardComponentPresetTypes";
import { utilityPreset } from "./dashboardComponentPresetFactory";

/**
 * 区域地图族(素材数量波次 A):8 种制图形态 × 2 个行业实例 = 16 款。
 * 形态:分省填色 / 城市气泡 / 飞线流向 / 栅格热力 / 行政边界钻取 / 园区平面标注 /
 * 管线走向 / 路网密度。全部使用 map 运行时合同原生 mode(region/scatter/heat/route)
 * 或经纬度字段承载,预览在 DashboardComponentPreview 内按 mark 呈现独立构图。
 */

const MAP_FRAME = { width: 560, height: 340 };

export const DASHBOARD_GIS_REGION_PRESETS: readonly DashboardComponentPreset[] = [
  // ── 分省填色(region)───────────────────────────────────────────────
  utilityPreset({ id: "province-gdp-fill-map", category: "gis", zh: "分省产值填色地图", en: "Province GDP choropleth", descriptionZh: "按省级产值分级填色并支持点选联动", type: "map", key: "gis.provinceGdp", previewFamily: "gis", frame: MAP_FRAME, widget: { map: { mode: "region", regionField: "province", valueField: "gdp" }, linkageParameterKey: "filter.province" } }),
  utilityPreset({ id: "province-energy-fill-map", category: "gis", zh: "分省能耗填色地图", en: "Province energy choropleth", descriptionZh: "按省级综合能耗分级填色观察区域强度", type: "map", key: "gis.provinceEnergy", previewFamily: "gis", frame: MAP_FRAME, widget: { map: { mode: "region", regionField: "province", valueField: "energy" }, linkageParameterKey: "filter.province" } }),
  // ── 城市气泡(scatter)─────────────────────────────────────────────
  utilityPreset({ id: "city-gdp-bubble-map", category: "gis", zh: "城市产值气泡地图", en: "City GDP bubble map", descriptionZh: "气泡大小表达城市产值规模", type: "map", key: "gis.cityGdp", previewFamily: "gis", frame: MAP_FRAME, widget: { map: { mode: "scatter", longitudeField: "longitude", latitudeField: "latitude", valueField: "gdp" }, linkageParameterKey: "filter.city" } }),
  utilityPreset({ id: "city-load-bubble-map", category: "gis", zh: "城市负荷气泡地图", en: "City load bubble map", descriptionZh: "气泡大小表达城市电网负荷分布", type: "map", key: "gis.cityLoad", previewFamily: "gis", frame: MAP_FRAME, widget: { map: { mode: "scatter", longitudeField: "longitude", latitudeField: "latitude", valueField: "load" } } }),
  // ── 飞线流向(route)───────────────────────────────────────────────
  utilityPreset({ id: "flight-flow-map", category: "gis", zh: "飞线流向地图", en: "Flight flow map", descriptionZh: "枢纽间飞线弧表达客流流向与强度", type: "map", key: "gis.flightFlow", previewFamily: "gis", frame: MAP_FRAME, widget: { map: { mode: "route", longitudeField: "longitude", latitudeField: "latitude", valueField: "passengers" } } }),
  utilityPreset({ id: "migration-flow-map", category: "gis", zh: "人口迁徙流向地图", en: "Migration flow map", descriptionZh: "迁徙 OD 飞线表达城市间人流强度", type: "map", key: "gis.migrationFlow", previewFamily: "gis", frame: MAP_FRAME, widget: { map: { mode: "route", longitudeField: "longitude", latitudeField: "latitude", valueField: "volume" } } }),
  // ── 栅格热力(heat)────────────────────────────────────────────────
  utilityPreset({ id: "grid-heat-map", category: "gis", zh: "栅格热力地图", en: "Grid heat map", descriptionZh: "经纬栅格聚合成热力观察客流密度", type: "map", key: "gis.gridHeat", previewFamily: "gis", frame: MAP_FRAME, widget: { map: { mode: "heat", longitudeField: "longitude", latitudeField: "latitude", valueField: "footfall" } } }),
  utilityPreset({ id: "block-heat-map", category: "gis", zh: "街区热力地图", en: "Block heat map", descriptionZh: "街区级热力呈现夜间治安事件密度", type: "map", key: "gis.blockHeat", previewFamily: "gis", frame: MAP_FRAME, widget: { map: { mode: "heat", longitudeField: "longitude", latitudeField: "latitude", valueField: "events" } } }),
  // ── 行政边界钻取(region + drillFields)────────────────────────────
  utilityPreset({ id: "province-drill-map", category: "gis", zh: "行政边界钻取地图", en: "Province drill map", descriptionZh: "省-市-区三级边界逐级下钻产值", type: "map", key: "gis.provinceDrill", previewFamily: "gis", frame: MAP_FRAME, widget: { map: { mode: "region", regionField: "province", valueField: "output" }, linkageParameterKey: "filter.province", analysis: { dimensionField: "province", measureField: "output", aggregation: "sum", drillFields: ["province", "city", "district"] } } }),
  utilityPreset({ id: "city-drill-map", category: "gis", zh: "城市边界钻取地图", en: "City drill map", descriptionZh: "市-区-街道逐级下钻受理办件分布", type: "map", key: "gis.cityDrill", previewFamily: "gis", frame: MAP_FRAME, widget: { map: { mode: "region", regionField: "city", valueField: "cases" }, linkageParameterKey: "filter.city", analysis: { dimensionField: "city", measureField: "cases", aggregation: "sum", drillFields: ["city", "district", "street"] } } }),
  // ── 园区平面标注(scatter + GeoJSON)───────────────────────────────
  utilityPreset({ id: "campus-annotation-map", category: "gis", zh: "园区平面标注地图", en: "Campus annotation map", descriptionZh: "园区平面图上标注建筑与点位状态", type: "map", key: "gis.campusAnnotation", previewFamily: "gis", frame: MAP_FRAME, widget: { map: { mode: "scatter", longitudeField: "longitude", latitudeField: "latitude", valueField: "status" }, linkageParameterKey: "filter.building" } }),
  utilityPreset({ id: "site-layout-map", category: "gis", zh: "场站布局标注地图", en: "Site layout map", descriptionZh: "场站平面布局标注设备与巡检点", type: "map", key: "gis.siteLayout", previewFamily: "gis", frame: MAP_FRAME, widget: { map: { mode: "scatter", longitudeField: "longitude", latitudeField: "latitude", valueField: "zoneCode" } } }),
  // ── 管线走向(route)───────────────────────────────────────────────
  utilityPreset({ id: "pipeline-route-map", category: "gis", zh: "管线走向地图", en: "Pipeline route map", descriptionZh: "供水管线走向与压力沿程标注", type: "map", key: "gis.pipelineRoute", previewFamily: "gis", frame: MAP_FRAME, widget: { map: { mode: "route", longitudeField: "longitude", latitudeField: "latitude", valueField: "pressure" } } }),
  utilityPreset({ id: "corridor-pipeline-map", category: "gis", zh: "廊道管线地图", en: "Corridor pipeline map", descriptionZh: "能源廊道管线走向与输送量", type: "map", key: "gis.corridorPipeline", previewFamily: "gis", frame: MAP_FRAME, widget: { map: { mode: "route", longitudeField: "longitude", latitudeField: "latitude", valueField: "throughput" } } }),
  // ── 路网/轨道密度(heat)───────────────────────────────────────────
  utilityPreset({ id: "road-density-map", category: "gis", zh: "路网密度地图", en: "Road density map", descriptionZh: "路段流量聚合成密度热力发现拥堵带", type: "map", key: "gis.roadDensity", previewFamily: "gis", frame: MAP_FRAME, widget: { map: { mode: "heat", longitudeField: "longitude", latitudeField: "latitude", valueField: "flow" } } }),
  utilityPreset({ id: "transit-density-map", category: "gis", zh: "轨道密度地图", en: "Transit density map", descriptionZh: "轨道站点客流密度热力分布", type: "map", key: "gis.transitDensity", previewFamily: "gis", frame: MAP_FRAME, widget: { map: { mode: "heat", longitudeField: "longitude", latitudeField: "latitude", valueField: "ridership" } } }),
] as const;
