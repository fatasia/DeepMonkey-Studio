import type { DashboardTemplateDomain } from "./dashboardTemplateTypes";
import { EXTENDED_DASHBOARD_TEMPLATE_DOMAINS } from "./dashboardTemplateDomainPacksExtended";
import { EXPANDED_DASHBOARD_TEMPLATE_DOMAINS } from "./dashboardTemplateDomainPacksExpanded";

export type DomainMetricRows = readonly [string, string, string][];
type DomainMetrics = DashboardTemplateDomain["metrics"];

/** 指标工厂:10 个角色位缺一不可,缺位即抛错(与既有 12 域同一数据契约)。 */
export function domainMetrics(values: DomainMetricRows): DomainMetrics {
  const [volume, efficiency, quality, risk, asset, energy, flow, cost, service, carbon] = values;
  return {
    volume: item(volume),
    efficiency: item(efficiency),
    quality: item(quality),
    risk: item(risk),
    asset: item(asset),
    energy: item(energy),
    flow: item(flow),
    cost: item(cost),
    service: item(service),
    carbon: item(carbon),
  };
}

function item(value: readonly [string, string, string] | undefined) {
  if (!value) {
    throw new Error("模板行业指标不完整");
  }
  const [zh, en, unit] = value;
  return { zh, en, unit };
}

/** 既有 12 域(等距色环取色,见各域注释)。 */
const BASE_DASHBOARD_TEMPLATE_DOMAINS: readonly DashboardTemplateDomain[] = [
  {
    id: "operations",
    nameZh: "经营驾驶舱",
    nameEn: "Operations cockpit",
    categoryZh: "经营分析",
    categoryEn: "Operations",
    /* 商用大屏配色体系:12 域按等距色环取色(金42°/青174°/黄绿74°/红4°/蓝208°/紫258°/草绿127°/薄荷158°/橙26°/靛228°/青蓝191°/柠黄46°),
       饱和度 60-75%、明度 55-62% 统一;surface 为同色相深底(明度 6-9%),保证封面渐变的"域色空气感"。
       近邻对(金 vs 柠黄、青 vs 薄荷)靠明度饱和差与底色冷暖区分。 */
    accent: "#d9a04a",
    surface: "#191d26",
    metrics: domainMetrics([
      ["营收", "Revenue", "万元"], ["目标达成", "Target attainment", "%"],
      ["订单履约", "Order fulfillment", "%"], ["经营风险", "Business risks", "项"],
      ["关键客户", "Key accounts", "家"], ["经营能耗", "Operating energy", "kWh"],
      ["订单流量", "Order flow", "单"], ["毛利", "Gross margin", "%"],
      ["客户满意度", "Customer satisfaction", "%"], ["经营碳强度", "Operating carbon intensity", "kgCO₂e/万元"],
    ]),
  },
  {
    id: "production",
    nameZh: "生产运行监控",
    nameEn: "Production monitoring",
    categoryZh: "工业生产",
    categoryEn: "Manufacturing",
    accent: "#35d0c0",
    surface: "#0d2126",
    metrics: domainMetrics([
      ["今日产量", "Daily output", "件"], ["OEE", "OEE", "%"],
      ["一次良率", "First-pass yield", "%"], ["活动告警", "Active alerts", "条"],
      ["在线设备", "Online assets", "台"], ["单位能耗", "Energy per unit", "kWh/件"],
      ["在制流量", "WIP flow", "件"], ["制造成本", "Manufacturing cost", "元/件"],
      ["准时交付", "On-time delivery", "%"], ["单位碳排", "Carbon per unit", "kgCO₂e/件"],
    ]),
  },
  {
    id: "energy",
    nameZh: "能源效率分析",
    nameEn: "Energy efficiency",
    categoryZh: "能源管理",
    categoryEn: "Energy",
    accent: "#b8d44e",
    surface: "#161d10",
    metrics: domainMetrics([
      ["供能量", "Energy supplied", "MWh"], ["供能效率", "Supply efficiency", "%"],
      ["供能质量", "Power quality", "%"], ["峰值告警", "Peak alerts", "条"],
      ["在线回路", "Online circuits", "条"], ["综合能耗", "Total consumption", "tce"],
      ["介质流量", "Utility flow", "m³/h"], ["能源成本", "Energy cost", "万元"],
      ["供能服务率", "Service level", "%"], ["碳排放", "Carbon emissions", "tCO₂e"],
    ]),
  },
  {
    id: "safety",
    nameZh: "安全态势中心",
    nameEn: "Safety command center",
    categoryZh: "安全生产",
    categoryEn: "Safety",
    accent: "#ee5d55",
    surface: "#261413",
    metrics: domainMetrics([
      ["巡检覆盖", "Inspection coverage", "%"], ["整改达成", "Closure attainment", "%"],
      ["合规率", "Compliance rate", "%"], ["重大风险", "Critical risks", "处"],
      ["受控设备", "Controlled assets", "台"], ["安全能耗", "Safety energy", "kWh"],
      ["事件流量", "Incident flow", "件"], ["安全投入", "Safety spend", "万元"],
      ["响应时效", "Response SLA", "%"], ["安全碳强度", "Safety carbon intensity", "kgCO₂e/小时"],
    ]),
  },
  {
    id: "logistics",
    nameZh: "供应链物流中心",
    nameEn: "Supply chain control tower",
    categoryZh: "供应链",
    categoryEn: "Supply chain",
    accent: "#4aa5f2",
    surface: "#0f1d2c",
    metrics: domainMetrics([
      ["在途订单", "In-transit orders", "单"], ["准时交付", "OTIF", "%"],
      ["签收准确率", "Delivery accuracy", "%"], ["运输异常", "Transport exceptions", "单"],
      ["可用车辆", "Available vehicles", "台"], ["运输能耗", "Transport energy", "L"],
      ["线路流量", "Route flow", "单"], ["物流成本", "Logistics cost", "万元"],
      ["客户服务率", "Customer service", "%"], ["运输碳排", "Transport carbon", "tCO₂e"],
    ]),
  },
  {
    id: "maintenance",
    nameZh: "设备健康运维",
    nameEn: "Asset health operations",
    categoryZh: "设备运维",
    categoryEn: "Maintenance",
    accent: "#a284f2",
    surface: "#1b1629",
    metrics: domainMetrics([
      ["已维护设备", "Maintained assets", "台"], ["计划达成", "Plan attainment", "%"],
      ["修复质量", "Repair quality", "%"], ["预测故障", "Predicted failures", "台"],
      ["在线设备", "Online assets", "台"], ["维护能耗", "Maintenance energy", "kWh"],
      ["工单流量", "Work-order flow", "单"], ["维护成本", "Maintenance cost", "万元"],
      ["响应 SLA", "Response SLA", "%"], ["维护碳排", "Maintenance carbon", "kgCO₂e"],
    ]),
  },
  {
    id: "campus",
    nameZh: "园区综合运营",
    nameEn: "Campus operations",
    categoryZh: "园区运营",
    categoryEn: "Campus",
    accent: "#5cc96a",
    surface: "#0f241a",
    metrics: domainMetrics([
      ["在园人数", "Occupancy", "人"], ["空间效率", "Space efficiency", "%"],
      ["服务达标", "Service compliance", "%"], ["待处置事件", "Open events", "件"],
      ["在线设施", "Online facilities", "台"], ["园区能耗", "Campus energy", "MWh"],
      ["人车流量", "People and vehicle flow", "人次"], ["运营成本", "Operating cost", "万元"],
      ["服务满意度", "Service satisfaction", "%"], ["园区碳排", "Campus carbon", "tCO₂e"],
    ]),
  },
  {
    id: "carbon",
    nameZh: "碳资产与减排",
    nameEn: "Carbon management",
    categoryZh: "双碳管理",
    categoryEn: "Carbon",
    accent: "#38d69b",
    surface: "#0c2420",
    metrics: domainMetrics([
      ["核算覆盖", "Accounting coverage", "%"], ["减排达成", "Abatement attainment", "%"],
      ["数据质量", "Data quality", "%"], ["碳风险", "Carbon risks", "项"],
      ["计量设备", "Metering assets", "台"], ["能源消耗", "Energy consumption", "MWh"],
      ["排放流量", "Emission flow", "tCO₂e"], ["碳成本", "Carbon cost", "万元"],
      ["客户披露率", "Disclosure service", "%"], ["净碳排", "Net carbon", "tCO₂e"],
    ]),
  },
  {
    id: "quality",
    nameZh: "质量追溯与改善",
    nameEn: "Quality traceability",
    categoryZh: "质量管理",
    categoryEn: "Quality",
    accent: "#f09040",
    surface: "#261811",
    metrics: domainMetrics([
      ["检验批次", "Inspection lots", "批"], ["过程能力", "Process capability", "CpK"],
      ["合格率", "Conformance", "%"], ["不合格项", "Nonconformities", "项"],
      ["检验设备", "Inspection assets", "台"], ["质量能耗", "Quality energy", "kWh"],
      ["批次流量", "Lot flow", "批"], ["质量成本", "Cost of quality", "万元"],
      ["客诉闭环", "Complaint closure", "%"], ["质量碳强度", "Quality carbon intensity", "kgCO₂e/件"],
    ]),
  },
  {
    id: "warehouse",
    nameZh: "仓储与库存协同",
    nameEn: "Warehouse orchestration",
    categoryZh: "仓储管理",
    categoryEn: "Warehouse",
    accent: "#7e97f0",
    surface: "#151828",
    metrics: domainMetrics([
      ["库存件数", "Inventory units", "件"], ["库容利用", "Capacity utilization", "%"],
      ["账实准确", "Inventory accuracy", "%"], ["缺货预警", "Stockout warnings", "项"],
      ["可用库位", "Available locations", "个"], ["仓储能耗", "Warehouse energy", "kWh"],
      ["出入库流量", "Inbound and outbound flow", "件"], ["库存金额", "Inventory value", "万元"],
      ["发运服务率", "Fulfillment service", "%"], ["库存碳强度", "Inventory carbon intensity", "kgCO₂e/件"],
    ]),
  },
  {
    id: "water",
    nameZh: "水务运行监控",
    nameEn: "Water operations",
    categoryZh: "公用工程",
    categoryEn: "Utilities",
    accent: "#3cb6dc",
    surface: "#0d2029",
    metrics: domainMetrics([
      ["今日供水", "Water supplied", "m³"], ["供水效率", "Supply efficiency", "%"],
      ["水质达标", "Quality compliance", "%"], ["管网告警", "Network alerts", "条"],
      ["在线泵站", "Online pump stations", "座"], ["泵站能耗", "Pumping energy", "kWh"],
      ["管网流量", "Network flow", "m³/h"], ["水务成本", "Water cost", "万元"],
      ["供水服务率", "Water service", "%"], ["水务碳排", "Water carbon", "tCO₂e"],
    ]),
  },
  {
    id: "construction",
    nameZh: "智慧工地总览",
    nameEn: "Smart construction",
    categoryZh: "工程建设",
    categoryEn: "Construction",
    accent: "#f4c542",
    surface: "#241d0e",
    metrics: domainMetrics([
      ["完成工程量", "Completed work", "m²"], ["进度达成", "Schedule attainment", "%"],
      ["验收合格", "Acceptance pass rate", "%"], ["现场风险", "Site risks", "项"],
      ["在线机械", "Online machinery", "台"], ["施工能耗", "Construction energy", "MWh"],
      ["材料流量", "Material flow", "t"], ["建造成本", "Construction cost", "万元"],
      ["履约服务率", "Contract service", "%"], ["施工碳排", "Construction carbon", "tCO₂e"],
    ]),
  },
];

/** 32 域聚合目录:既有 12 域 + 扩量 8 域 + 第二批 8 域 + 波次 B 4 域(餐饮/文娱因同质重叠于 2026-09-12 裁删)。 */
export const DASHBOARD_TEMPLATE_DOMAINS: readonly DashboardTemplateDomain[] = [
  ...BASE_DASHBOARD_TEMPLATE_DOMAINS,
  ...EXTENDED_DASHBOARD_TEMPLATE_DOMAINS,
  ...EXPANDED_DASHBOARD_TEMPLATE_DOMAINS,
];
