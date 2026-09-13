import type { DashboardTemplateDomain } from "./dashboardTemplateTypes";
import { domainMetrics, type DomainMetricRows } from "./dashboardTemplateDomainPacks";

/**
 * 扩量行业域(第 13-20 域 + 波次 B 第 29-32 域):行业色调对齐帆软官方映射(党建=红、零售电商=红黄、
 * 金融=深蓝等),accent 与既有 12 域的等距色环错开——近邻对(青蓝 vs 水务、红 vs 安全、橙 vs 质量)依靠
 * 色相偏移 + 明度饱和差 + surface 冷暖三重区分,规则与既有 12 域一致。
 * surface 仍为同色相深底(明度 6-9%),保证封面渐变的"域色空气感"。
 * 2026-09-12 波次 B 追加:电力交易/化工安全/冷链物流/会展活动(指标为真实行业 KPI,视角由全局
 * 10 视角矩阵自动展开,详见 docs/asset-quantity-wave-spec-2026-09-12.md)。
 */
export const EXTENDED_DASHBOARD_TEMPLATE_DOMAINS: readonly DashboardTemplateDomain[] = [
  {
    id: "healthcare",
    nameZh: "医疗健康监测",
    nameEn: "Healthcare monitoring",
    categoryZh: "医疗健康",
    categoryEn: "Healthcare",
    /* 医用青蓝 hsl(201,76%,57%):比水务 #3cb6dc(194°)更偏蓝、比物流 #4aa5f2(207°)更暗更青,
       surface 偏蓝靛,与水务的青黑底形成冷暖差。 */
    accent: "#3da9e5",
    surface: "#101f31",
    metrics: domainMetrics([
      ["在院患者", "Inpatients", "人"], ["平均候诊时长", "Average wait time", "分钟"],
      ["诊断符合率", "Diagnostic concordance", "%"], ["危急值告警", "Critical value alerts", "条"],
      ["在线医疗设备", "Online medical devices", "台"], ["重点科室能耗", "Department energy", "kWh"],
      ["门诊流量", "Outpatient flow", "人次"], ["次均费用", "Cost per visit", "元"],
      ["患者满意度", "Patient satisfaction", "%"], ["医废碳排", "Medical waste carbon", "kgCO₂e"],
    ] as DomainMetricRows),
  },
  {
    id: "government",
    nameZh: "政务服务驾驶舱",
    nameEn: "Government service cockpit",
    categoryZh: "政务服务",
    categoryEn: "Government",
    /* 政务红 hsl(357,74%,56%):比安全珊瑚红 #ee5d55(3°)更正、更深,靠近党建正红。 */
    accent: "#e23c44",
    surface: "#241219",
    metrics: domainMetrics([
      ["办件量", "Cases handled", "件"], ["按时办结率", "On-time closure", "%"],
      ["一次办结率", "First-pass completion", "%"], ["超期预警", "Overdue warnings", "件"],
      ["在线服务终端", "Online service kiosks", "台"], ["大厅能耗", "Service hall energy", "kWh"],
      ["受理流量", "Intake flow", "件"], ["大厅运营成本", "Hall operating cost", "万元"],
      ["群众满意率", "Public satisfaction", "%"], ["办公碳排", "Office carbon", "kgCO₂e"],
    ] as DomainMetricRows),
  },
  {
    id: "retail",
    nameZh: "零售电商运营",
    nameEn: "Retail and e-commerce",
    categoryZh: "零售电商",
    categoryEn: "Retail",
    /* 促销橘红 hsl(10,82%,58%):红黄系主色,比安全红(3°)更偏橘、更深,
       surface 暖橘黑与安全的暖红黑靠饱和度区分。 */
    accent: "#ec5a3c",
    surface: "#2a1712",
    metrics: domainMetrics([
      ["销售额", "Sales", "万元"], ["坪效", "Sales per m²", "元/㎡"],
      ["好评率", "Positive review rate", "%"], ["缺货预警", "Stockout warnings", "项"],
      ["在营门店", "Active stores", "家"], ["门店能耗", "Store energy", "kWh"],
      ["客流量", "Foot traffic", "人次"], ["获客成本", "Acquisition cost", "元"],
      ["会员复购率", "Member repeat rate", "%"], ["包装碳排", "Packaging carbon", "kgCO₂e"],
    ] as DomainMetricRows),
  },
  {
    id: "finance",
    nameZh: "金融风控与经营",
    nameEn: "Finance risk and operations",
    categoryZh: "金融服务",
    categoryEn: "Finance",
    /* 钢蓝 hsl(219,62%,55%):比物流天蓝(207°)更深更沉、比仓库靛蓝(228°)更暗,
       明度差 17 个点构成"深蓝金"的沉稳底色。 */
    accent: "#4577d3",
    surface: "#0f1a30",
    metrics: domainMetrics([
      ["资产管理规模", "Assets under management", "亿元"], ["结算时效", "Settlement timeliness", "%"],
      ["合规达标率", "Compliance rate", "%"], ["风险告警", "Risk alerts", "条"],
      ["在营网点", "Active branches", "家"], ["数据中心能耗", "Data center energy", "MWh"],
      ["交易笔数", "Transaction count", "万笔"], ["运营成本", "Operating cost", "万元"],
      ["客户满意度", "Client satisfaction", "%"], ["运营碳排", "Operating carbon", "tCO₂e"],
    ] as DomainMetricRows),
  },
  {
    id: "telecom",
    nameZh: "通信网络运营",
    nameEn: "Telecom network operations",
    categoryZh: "通信运营",
    categoryEn: "Telecom",
    /* 蓝紫 hsl(272,60%,64%):与设备运维紫 #a284f2(256°)相距 16°,更冷更柔,
       surface 偏紫黑。 */
    accent: "#a06cda",
    surface: "#201431",
    metrics: domainMetrics([
      ["在网用户", "Subscribers", "万户"], ["网络利用率", "Network utilization", "%"],
      ["接通率", "Connection rate", "%"], ["故障告警", "Fault alarms", "条"],
      ["在线基站", "Online base stations", "座"], ["基站能耗", "Base station energy", "MWh"],
      ["数据流量", "Data traffic", "TB"], ["运营成本", "Operating cost", "万元"],
      ["客户满意度", "Customer satisfaction", "%"], ["网络碳排", "Network carbon", "tCO₂e"],
    ] as DomainMetricRows),
  },
  {
    id: "transport",
    nameZh: "交通枢纽调度",
    nameEn: "Transport hub dispatch",
    categoryZh: "交通枢纽",
    categoryEn: "Transport",
    /* 信号橙 hsl(24,90%,55%):比质量橙 #f09040(27°)更深更艳(质量橙偏黄),
       surface 中性橙黑与质量的黄橙黑区分。 */
    accent: "#f47825",
    surface: "#241610",
    metrics: domainMetrics([
      ["到发客流", "Passenger throughput", "万人次"], ["准点率", "Punctuality", "%"],
      ["设备完好率", "Equipment readiness", "%"], ["拥堵告警", "Congestion alerts", "处"],
      ["在线安检设备", "Online security gates", "台"], ["枢纽能耗", "Hub energy", "MWh"],
      ["换乘流量", "Transfer flow", "人次"], ["运营成本", "Operating cost", "万元"],
      ["乘客满意度", "Passenger satisfaction", "%"], ["枢纽碳排", "Hub carbon", "tCO₂e"],
    ] as DomainMetricRows),
  },
  {
    id: "tourism",
    nameZh: "文化旅游态势",
    nameEn: "Culture and tourism",
    categoryZh: "文化旅游",
    categoryEn: "Tourism",
    /* 紫红 hsl(315,58%,60%):距最近的通信蓝紫(272°)43°,独占洋红区,
       surface 偏品红的暗紫黑。 */
    accent: "#d45eb7",
    surface: "#261223",
    metrics: domainMetrics([
      ["接待游客", "Visitors received", "人次"], ["展馆利用率", "Venue utilization", "%"],
      ["服务达标率", "Service compliance", "%"], ["安全预警", "Safety alerts", "处"],
      ["在线导览设备", "Online guides", "台"], ["景区能耗", "Scenic area energy", "MWh"],
      ["票务流量", "Ticketing flow", "张"], ["运营成本", "Operating cost", "万元"],
      ["游客满意度", "Visitor satisfaction", "%"], ["景区碳排", "Scenic carbon", "tCO₂e"],
    ] as DomainMetricRows),
  },
  {
    id: "agriculture",
    nameZh: "农业生产监测",
    nameEn: "Agriculture monitoring",
    categoryZh: "农业农村",
    categoryEn: "Agriculture",
    /* 草绿 hsl(95,55%,52%):黄绿(#b8d44e,73°)与园区绿(#5cc96a,128°)之间的"叶绿",
       surface 偏橄榄的暗绿黑。 */
    accent: "#79c841",
    surface: "#14200e",
    metrics: domainMetrics([
      ["农产品产量", "Produce output", "t"], ["灌溉效率", "Irrigation efficiency", "%"],
      ["质检合格率", "Quality pass rate", "%"], ["病虫害预警", "Pest warnings", "条"],
      ["在线农机", "Online machinery", "台"], ["设施能耗", "Facility energy", "kWh"],
      ["冷链流量", "Cold chain flow", "t"], ["亩均成本", "Cost per mu", "元"],
      ["订单履约率", "Order fulfillment", "%"], ["农业碳排", "Farming carbon", "tCO₂e"],
    ] as DomainMetricRows),
  },
  {
    /* 波次 B(2026-09-12):以下 4 域为第 29-32 域。 */
    id: "power-trading",
    nameZh: "电力交易运营",
    nameEn: "Power trading operations",
    categoryZh: "电力交易",
    categoryEn: "Power trading",
    /* 深蓝 hsl(236,50%,56%):取 warehouse 靛蓝(227°,S79 L72 高明高饱)与 maintenance 紫(256°)
       之间的空隙,同"深蓝鎏金"的玄澜套件基调;较 finance 钢蓝(219°)偏左 17°。 */
    accent: "#575ec7",
    surface: "#12142c",
    metrics: domainMetrics([
      ["中长期成交电量", "Contracted energy", "万kWh"], ["负荷预测准确率", "Load forecast accuracy", "%"],
      ["偏差考核达标率", "Deviation assessment compliance", "%"], ["现货价格告警", "Spot price alerts", "条"],
      ["机组检修计划", "Unit maintenance plans", "项"], ["新能源出力", "Renewable output", "MW"],
      ["现货出清电量", "Spot cleared energy", "MWh"], ["售电收益", "Retail revenue", "万元"],
      ["辅助服务收益", "Ancillary services revenue", "万元"], ["售电碳强度", "Retail carbon intensity", "gCO₂/kWh"],
    ] as DomainMetricRows),
  },
  {
    id: "chem-safety",
    nameZh: "化工安全管控",
    nameEn: "Chemical process safety",
    categoryZh: "化工安全",
    categoryEn: "Chemical safety",
    /* 橙红 hsl(15,78%,52%):橙红族已挤(政务红 357°/安全红 3°/零售橘红 10°/信号橙 24°/质量橙 27°),
       本域取 15° 并压到全族最低明度(52%),以"最深最沉的警示橙红"与两侧拉开,对齐危化警示色。 */
    accent: "#e45525",
    surface: "#27120b",
    metrics: domainMetrics([
      ["特殊作业许可", "Special work permits", "张"], ["承包商隐患整改及时率", "Contractor hazard closure", "%"],
      ["HAZOP 分析覆盖率", "HAZOP coverage", "%"], ["可燃气体告警", "Combustible gas alarms", "条"],
      ["受控重大危险源", "Major hazard installations", "处"], ["安全装备能耗", "Safety equipment energy", "kWh"],
      ["工艺报警流量", "Process alarm flow", "条"], ["职业健康投入", "Occupational health spend", "万元"],
      ["应急演练完成率", "Drill completion", "%"], ["安全碳强度", "Safety carbon intensity", "kgCO₂e/小时"],
    ] as DomainMetricRows),
  },
  {
    id: "cold-chain",
    nameZh: "冷链物流监控",
    nameEn: "Cold chain logistics",
    categoryZh: "冷链物流",
    categoryEn: "Cold chain",
    /* 冰青 hsl(188,50%,66%):蓝青区(电光青 182°/水务 194°/医用青蓝 201°)唯一空隙,以全家族
       最低饱和(50%)+ 最高明度(66%)做成"淡冰"质感,与两侧浓青形成温度差。 */
    accent: "#7dc8d4",
    surface: "#0d2129",
    metrics: domainMetrics([
      ["冷藏车在途", "Reefer trucks en route", "台"], ["库存周转天数", "Inventory turnover days", "天"],
      ["温区达标率", "Temperature zone compliance", "%"], ["断链告警", "Cold chain break alerts", "条"],
      ["调度月台", "Scheduled docks", "个"], ["制冷能耗", "Refrigeration energy", "kWh"],
      ["库门开启", "Door openings", "次"], ["临期货损", "Near-expiry shrinkage", "万元"],
      ["订单履约率", "Order fulfillment", "%"], ["冷链碳排", "Cold chain carbon", "tCO₂e"],
    ] as DomainMetricRows),
  },
  {
    id: "expo",
    nameZh: "会展活动指挥",
    nameEn: "Expo and events command",
    categoryZh: "会展活动",
    categoryEn: "Expo and events",
    /* 紫金 hsl(293,49%,63%):通信蓝紫(268°)与文旅洋红(315°)之间 47° 空隙正中,独占紫区,
       surface 暗紫黑保留"紫电"套件的科技底色。 */
    accent: "#c670d2",
    surface: "#1f1231",
    metrics: domainMetrics([
      ["进馆客流", "Visitor flow", "人次"], ["展位利用率", "Booth utilization", "%"],
      ["餐饮抽检合格率", "Catering inspection pass", "%"], ["安保告警", "Security alerts", "起"],
      ["在办场次", "Live sessions", "场"], ["场馆能耗", "Venue energy", "MWh"],
      ["舆情声量", "Sentiment volume", "条"], ["签约金额", "Contracted value", "亿元"],
      ["观众满意度", "Visitor satisfaction", "%"], ["活动碳足迹", "Event carbon footprint", "tCO₂e"],
    ] as DomainMetricRows),
  },
];
