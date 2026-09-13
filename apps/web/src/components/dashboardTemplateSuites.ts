import type { DashboardTemplateDefinition } from "./dashboardTemplateTypes";

/**
 * 视觉风格库(对标帆软"视觉风格库"专题,内容全部原创):
 * 每套=行业域的独立风格身份(色相+明度+饱和三重区分+原创命名与文案),
 * 32 个行业域每域恰属一套;套件入口卡与量化徽章由此派生。
 * 命名取意传统色彩与自然意象,不引用任何竞品套件名。
 */
export interface DashboardTemplateSuite {
  id: string;
  zh: string;
  en: string;
  descriptionZh: string;
  descriptionEn: string;
  domainIds: readonly string[];
  /** 套件代表色,用于入口卡渐变与徽章描边。 */
  accent: string;
  surface: string;
}

export const DASHBOARD_TEMPLATE_SUITES: readonly DashboardTemplateSuite[] = [
  {
    id: "gilded", zh: "鎏金", en: "Gilded",
    descriptionZh: "暖金经营驾驶舱,业绩大屏的首选基调。",
    descriptionEn: "Warm-gold executive cockpits for revenue dashboards.",
    domainIds: ["operations"],
    accent: "#f0a83e", surface: "#241c0e",
  },
  {
    id: "bronze", zh: "曜铜", en: "Bronze",
    descriptionZh: "铜橙的交通、建造与汽车制造现场,厚重的工业气。",
    descriptionEn: "Copper-orange transport, construction and automotive themes.",
    domainIds: ["transport", "construction", "automotive"],
    accent: "#d98a4f", surface: "#231a10",
  },
  {
    id: "cinnabar", zh: "赤霄", en: "Cinnabar",
    descriptionZh: "朱红的政务与教育公共服务,庄重且清晰。",
    descriptionEn: "Vermillion government and education service themes.",
    domainIds: ["government", "education"],
    accent: "#e2443c", surface: "#261314",
  },
  {
    id: "flaresale", zh: "炽售", en: "Flare Retail",
    descriptionZh: "亮橙红的大促与电商实时战报,转化氛围拉满。",
    descriptionEn: "Bright orange-red e-commerce live campaign boards.",
    domainIds: ["retail"],
    accent: "#f0623f", surface: "#261410",
  },
  {
    id: "ember", zh: "燧火", en: "Ember",
    descriptionZh: "警示红的安全、质量与化工危源哨站,异常一票醒目。",
    descriptionEn: "Alert-red safety, quality and chemical-hazard watchboards.",
    domainIds: ["safety", "quality", "chem-safety"],
    accent: "#e2543c", surface: "#261412",
  },
  {
    id: "emerald", zh: "翠涛", en: "Emerald",
    descriptionZh: "黄绿能碳双控主题,服务双碳叙事。",
    descriptionEn: "Green energy-carbon control themes for dual-carbon goals.",
    domainIds: ["energy", "carbon"],
    accent: "#4ac96a", surface: "#10231a",
  },
  {
    id: "petrosage", zh: "苍滨", en: "Petro Sage",
    descriptionZh: "青灰绿的化工装置现场,耐脏且冷静。",
    descriptionEn: "Sage-teal petrochemical plant boards, calm and sturdy.",
    domainIds: ["petrochemical"],
    accent: "#2fb89a", surface: "#0e221d",
  },
  {
    id: "fieldgreen", zh: "陌青", en: "Field Green",
    descriptionZh: "禾苗青的农业物联主题,生长气息。",
    descriptionEn: "Seedling-green agricultural IoT themes.",
    domainIds: ["agriculture"],
    accent: "#8fbf4a", surface: "#16210f",
  },
  {
    id: "pinemint", zh: "松峦", en: "Pine Mint",
    descriptionZh: "薄荷绿的园区环境监测,清爽透气。",
    descriptionEn: "Mint-green campus and environment monitoring.",
    domainIds: ["campus", "environment"],
    accent: "#55c48e", surface: "#0f231c",
  },
  {
    id: "azure", zh: "青冥", en: "Azure",
    descriptionZh: "青蓝运行监控,制造与电网的主力色。",
    descriptionEn: "Cyan-azure monitoring for production and grid.",
    domainIds: ["production", "power-grid"],
    accent: "#35c9d0", surface: "#0d2126",
  },
  {
    id: "tidecyan", zh: "碧汐", en: "Tide Cyan",
    descriptionZh: "深青的水务厂网与冷链温控主题,水质与潮汐感。",
    descriptionEn: "Deep-cyan water-treatment and cold-chain temperature themes.",
    domainIds: ["water", "cold-chain"],
    accent: "#2fa8c9", surface: "#0c2027",
  },
  {
    id: "mistblue", zh: "雾蓝", en: "Mist Blue",
    descriptionZh: "雾蓝临床主题,医院运营的洁净感。",
    descriptionEn: "Misty clinical blue for hospital operations.",
    domainIds: ["healthcare"],
    accent: "#4aa8d8", surface: "#0e1e2b",
  },
  {
    id: "ocean", zh: "沧澜", en: "Ocean",
    descriptionZh: "钢蓝供应链与仓储,沉稳可靠的吞吐脉搏。",
    descriptionEn: "Steel-blue supply chain and warehouse throughput.",
    domainIds: ["logistics", "warehouse"],
    accent: "#4a8fd8", surface: "#101b2c",
  },
  {
    id: "navy", zh: "玄澜", en: "Deep Navy",
    descriptionZh: "藏蓝鎏边的金融风控与电力交易,稳中有贵气。",
    descriptionEn: "Navy-with-gold financial risk and power trading themes.",
    domainIds: ["finance", "power-trading"],
    accent: "#3d6bb8", surface: "#0f1726",
  },
  {
    id: "violet", zh: "紫电", en: "Violet",
    descriptionZh: "靛紫的高新制造、通信与会展指挥,克制的科技感。",
    descriptionEn: "Indigo-violet semiconductor, telecom and expo themes.",
    domainIds: ["semiconductor", "telecom", "expo"],
    accent: "#8f7ad8", surface: "#1a1630",
  },
  {
    id: "slate", zh: "黛青", en: "Slate",
    descriptionZh: "黛蓝灰的设备运维与资产,低调耐用。",
    descriptionEn: "Slate-blue maintenance and real-estate asset themes.",
    domainIds: ["maintenance", "realestate"],
    accent: "#7d86c9", surface: "#171a2a",
  },
  {
    id: "aurora", zh: "霞光", en: "Aurora",
    descriptionZh: "玫紫渐变的文旅现场,夜游经济的高辨识。",
    descriptionEn: "Magenta tourism and night-economy themes.",
    domainIds: ["tourism"],
    accent: "#d45eb7", surface: "#261223",
  },
  {
    id: "rosemist", zh: "藕荷", en: "Rose Mist",
    descriptionZh: "藕荷粉的医药与实验室,洁净中带温度。",
    descriptionEn: "Rose-mist pharma and laboratory themes.",
    domainIds: ["pharma"],
    accent: "#d472a8", surface: "#241320",
  },
];

const SUITE_BY_DOMAIN = new Map<string, DashboardTemplateSuite>(
  DASHBOARD_TEMPLATE_SUITES.flatMap((suite) => suite.domainIds.map((domainId) => [domainId, suite])),
);

export function resolveTemplateSuite(domainId: string): DashboardTemplateSuite | undefined {
  return SUITE_BY_DOMAIN.get(domainId);
}

/** 套件量化徽章(诚实统计):模板数与族内出现过的主图类型数,均由目录真实推导。 */
export function suiteStats(suite: DashboardTemplateSuite, templates: readonly DashboardTemplateDefinition[]) {
  const members = templates.filter((template) => suite.domainIds.includes(template.domainId));
  return {
    count: members.length,
    chartKinds: new Set(members.map((template) => template.layout.primaryChart)).size,
  };
}
