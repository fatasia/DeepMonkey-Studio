import type { DashboardTemplateDomain } from "./dashboardTemplateTypes";
import { domainMetrics, type DomainMetricRows } from "./dashboardTemplateDomainPacks";

/**
 * 第二批扩量行业域(第 21-28 域)。2026-09-12 质量审计裁删:餐饮连锁(与零售电商 6/10 指标重叠、
 * 橙色族 10°/16°/24° 过挤)与文娱体育(与文化旅游 5/10 指标重叠、品红族过挤)两域并入归属定位后删除,
 * 目录由 30 域收敛为 28 域(质量优先,见 docs/delivery-report-2026-09-12.md)。
 * 色环策略与既有域一致:利用未占用的色相空隙(55/112/145/182/214/243/285/330 等),
 * 汽车制造改用低饱和钢蓝(S 32%),以饱和/明度轴与近邻的蓝族区分。
 */
export const EXPANDED_DASHBOARD_TEMPLATE_DOMAINS: readonly DashboardTemplateDomain[] = [
  {
    id: "power-grid",
    nameZh: "电力电网调度",
    nameEn: "Power grid dispatch",
    categoryZh: "电力电网",
    categoryEn: "Power grid",
    /* 电光青 hsl(182,68%,52%):填补生产青(171°)与水务青蓝(194°)之间的空隙,行业色对齐外部参考"电网=青绿"。 */
    accent: "#31d2d7",
    surface: "#0c2226",
    metrics: domainMetrics([
      ["今日供电量", "Power supplied", "MWh"], ["负荷率", "Load factor", "%"],
      ["频率合格率", "Frequency compliance", "%"], ["跳闸告警", "Trip alerts", "条"],
      ["在线变电站", "Online substations", "座"], ["网损能耗", "Network loss", "MWh"],
      ["潮流流量", "Power flow", "MW"], ["购电成本", "Power purchase cost", "万元"],
      ["供电可靠率", "Supply reliability", "%"], ["电网碳排", "Grid carbon", "tCO₂e"],
    ] as DomainMetricRows),
  },
  {
    id: "petrochemical",
    nameZh: "石油化工生产",
    nameEn: "Petrochemical operations",
    categoryZh: "石油化工",
    categoryEn: "Petrochemical",
    /* 化工橄榄绿 hsl(112,50%,47%):低明度拉开与黄绿能源(73°)和农业草绿(95°)的距离。 */
    accent: "#44b43c",
    surface: "#12230f",
    metrics: domainMetrics([
      ["加工量", "Feedstock processed", "t"], ["综合收率", "Overall yield", "%"],
      ["合格率", "Product compliance", "%"], ["泄漏告警", "Leak alerts", "处"],
      ["在线储罐", "Online tanks", "座"], ["装置能耗", "Unit energy", "kgce/t"],
      ["物料流量", "Material flow", "t/h"], ["加工成本", "Processing cost", "元/t"],
      ["装置负荷率", "Unit load rate", "%"], ["过程碳排", "Process carbon", "tCO₂e"],
    ] as DomainMetricRows),
  },
  {
    id: "automotive",
    nameZh: "汽车制造工场",
    nameEn: "Automotive manufacturing",
    categoryZh: "汽车制造",
    categoryEn: "Automotive",
    /* 低饱和钢蓝 hsl(214,32%,60%):以饱和度轴(32% vs 全局 60-88%)与天蓝/深蓝族拉开,金属工业感。 */
    accent: "#7895ba",
    surface: "#161b24",
    metrics: domainMetrics([
      ["整车下线", "Vehicles produced", "台"], ["节拍达成", "Takt attainment", "%"],
      ["一次下线合格率", "First-time pass rate", "%"], ["停线预警", "Line-stop warnings", "次"],
      ["在线机器人", "Online robots", "台"], ["焊装能耗", "Welding energy", "kWh"],
      ["零部件流量", "Parts flow", "套"], ["单车成本", "Cost per vehicle", "元"],
      ["订单交付率", "Order fulfillment", "%"], ["制造碳排", "Manufacturing carbon", "tCO₂e"],
    ] as DomainMetricRows),
  },
  {
    id: "semiconductor",
    nameZh: "半导体晶圆制造",
    nameEn: "Semiconductor fabrication",
    categoryZh: "半导体",
    categoryEn: "Semiconductor",
    /* 紫晶 hsl(285,60%,64%):填补设备紫(256°)与通信蓝紫(272°)、文旅紫红(315°)之间的空隙。 */
    accent: "#8b72d4",
    surface: "#1a1630",
    metrics: domainMetrics([
      ["晶圆产出", "Wafer output", "片"], ["设备利用率", "Utilization", "%"],
      ["良率", "Die yield", "%"], ["洁净度告警", "Cleanroom alerts", "条"],
      ["在线机台", "Online tools", "台"], ["洁净室能耗", "Fab energy", "MWh"],
      ["在制品流量", "WIP flow", "批"], ["单片成本", "Cost per wafer", "元"],
      ["准时交付", "On-time delivery", "%"], ["制造碳排", "Fab carbon", "tCO₂e"],
    ] as DomainMetricRows),
  },
  {
    id: "pharma",
    nameZh: "医药制造质量",
    nameEn: "Pharmaceutical manufacturing",
    categoryZh: "医药制造",
    categoryEn: "Pharmaceutical",
    /* 玫红 hsl(340,64%,60%):独占 330-350 区间,与文旅紫红(315°)相距 25°。 */
    accent: "#d16287",
    surface: "#26121b",
    metrics: domainMetrics([
      ["批次产量", "Batch output", "批"], ["放行达成", "Release attainment", "%"],
      ["检验合格率", "QC pass rate", "%"], ["偏差告警", "Deviation alerts", "起"],
      ["在线产线", "Online lines", "条"], ["洁净能耗", "Cleanroom energy", "MWh"],
      ["物料流量", "Material flow", "批"], ["批次成本", "Batch cost", "万元"],
      ["批交及时率", "Batch delivery", "%"], ["生产碳排", "Production carbon", "tCO₂e"],
    ] as DomainMetricRows),
  },
  {
    id: "realestate",
    nameZh: "地产项目经营",
    nameEn: "Real estate portfolio",
    categoryZh: "房地产建筑",
    categoryEn: "Real estate",
    /* 蓝紫 hsl(243,55%,64%):填补仓库靛蓝(228°)与设备紫(256°)之间的空隙,藏蓝金的地产语言。 */
    accent: "#736dd9",
    surface: "#171630",
    metrics: domainMetrics([
      ["在售货值", "Inventory value", "亿元"], ["去化率", "Absorption rate", "%"],
      ["交付合格率", "Handover quality", "%"], ["工抵预警", "Payment warnings", "项"],
      ["在建项目", "Active projects", "个"], ["工地能耗", "Site energy", "MWh"],
      ["来访流量", "Visit flow", "组"], ["货值成本", "Cost of sales", "万元"],
      ["客户满意率", "Client satisfaction", "%"], ["开发碳排", "Development carbon", "tCO₂e"],
    ] as DomainMetricRows),
  },
  {
    id: "environment",
    nameZh: "环境监测治理",
    nameEn: "Environmental monitoring",
    categoryZh: "环保监测",
    categoryEn: "Environment",
    /* 环保绿 hsl(145,58%,50%):填补园区绿(128°)与碳薄荷(158°)之间的空隙,行业色对齐外部参考"环保=青绿"。 */
    accent: "#4ab588",
    surface: "#0f231c",
    metrics: domainMetrics([
      ["监测点位", "Monitoring sites", "个"], ["达标天数", "Compliant days", "天"],
      ["数据有效率", "Data availability", "%"], ["超标告警", "Exceedance alerts", "次"],
      ["在线监测仪", "Online analyzers", "台"], ["站房能耗", "Station energy", "kWh"],
      ["排放流量", "Emission flow", "万m³"], ["治理成本", "Abatement cost", "万元"],
      ["预警响应率", "Alert response", "%"], ["减排碳当量", "Carbon abated", "tCO₂e"],
    ] as DomainMetricRows),
  },
  {
    id: "education",
    nameZh: "教育校区运营",
    nameEn: "Education campus operations",
    categoryZh: "教育培训",
    categoryEn: "Education",
    /* 书本明黄 hsl(55,70%,59%):填补工程柠黄(44°)与能源黄绿(73°)之间的空隙,高明度教育语言。 */
    accent: "#eed03f",
    surface: "#26220e",
    metrics: domainMetrics([
      ["在校人数", "Enrollment", "人"], ["教室利用率", "Room utilization", "%"],
      ["课程达标率", "Course compliance", "%"], ["安全预警", "Campus alerts", "起"],
      ["在线终端", "Online terminals", "台"], ["校区能耗", "Campus energy", "MWh"],
      ["出入流量", "Gate flow", "人次"], ["生均成本", "Cost per student", "元"],
      ["家长满意率", "Parent satisfaction", "%"], ["校区碳排", "Campus carbon", "tCO₂e"],
    ] as DomainMetricRows),
  },
];
