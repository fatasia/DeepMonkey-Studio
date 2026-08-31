import type { AppLocale } from "../i18n";

export interface DashboardComponentBackgroundAsset {
  id: string;
  zh: string;
  en: string;
  category: "business" | "industrial" | "technology" | "light";
  tags: readonly string[];
  url: string;
}

type SurfaceDefinition = Omit<DashboardComponentBackgroundAsset, "url"> & {
  stroke: string;
  fill: string;
  accent: string;
  motif: "corner" | "notch" | "rail" | "pulse" | "grid" | "glass" | "paper" | "minimal";
};

const DEFINITIONS: readonly SurfaceDefinition[] = [
  {
    id: "executive-slate",
    zh: "经营深灰",
    en: "Executive slate",
    category: "business",
    tags: ["经营", "KPI", "深色"],
    stroke: "#697a83",
    fill: "#11191d",
    accent: "#d8b66a",
    motif: "minimal",
  },
  {
    id: "executive-gold",
    zh: "经营金线",
    en: "Executive gold",
    category: "business",
    tags: ["经营", "金色", "指标"],
    stroke: "#8f7440",
    fill: "#17150f",
    accent: "#e5c373",
    motif: "corner",
  },
  {
    id: "report-ink",
    zh: "报表墨蓝",
    en: "Report ink",
    category: "business",
    tags: ["报表", "表格", "蓝色"],
    stroke: "#38526b",
    fill: "#101820",
    accent: "#72a6d0",
    motif: "rail",
  },
  {
    id: "report-neutral",
    zh: "报表中性灰",
    en: "Report neutral",
    category: "business",
    tags: ["报表", "通用", "灰色"],
    stroke: "#58636a",
    fill: "#171c1f",
    accent: "#a9b3b8",
    motif: "notch",
  },
  {
    id: "factory-steel",
    zh: "工厂钢构",
    en: "Factory steel",
    category: "industrial",
    tags: ["工业", "设备", "钢铁"],
    stroke: "#60747b",
    fill: "#111a1d",
    accent: "#d29b45",
    motif: "notch",
  },
  {
    id: "factory-safety",
    zh: "工业警示",
    en: "Industrial safety",
    category: "industrial",
    tags: ["工业", "告警", "黄色"],
    stroke: "#9a7529",
    fill: "#1a1710",
    accent: "#f0b93f",
    motif: "rail",
  },
  {
    id: "scada-cyan",
    zh: "SCADA 青蓝",
    en: "SCADA cyan",
    category: "industrial",
    tags: ["SCADA", "监控", "青色"],
    stroke: "#26788a",
    fill: "#0d181b",
    accent: "#4fd1e7",
    motif: "pulse",
  },
  {
    id: "alarm-red",
    zh: "告警红框",
    en: "Alarm red",
    category: "industrial",
    tags: ["告警", "故障", "红色"],
    stroke: "#8f3f43",
    fill: "#1b1113",
    accent: "#ff6b70",
    motif: "pulse",
  },
  {
    id: "digital-grid",
    zh: "数字网格",
    en: "Digital grid",
    category: "technology",
    tags: ["科技", "网格", "大屏"],
    stroke: "#295c75",
    fill: "#0b151b",
    accent: "#43b9e8",
    motif: "grid",
  },
  {
    id: "digital-violet",
    zh: "数字紫晶",
    en: "Digital violet",
    category: "technology",
    tags: ["科技", "紫色", "分析"],
    stroke: "#66518b",
    fill: "#151220",
    accent: "#ac88ee",
    motif: "corner",
  },
  {
    id: "digital-teal",
    zh: "数字青绿",
    en: "Digital teal",
    category: "technology",
    tags: ["科技", "青绿", "实时"],
    stroke: "#287469",
    fill: "#0d1917",
    accent: "#52d6bd",
    motif: "grid",
  },
  {
    id: "glass-blue",
    zh: "蓝色玻璃",
    en: "Blue glass",
    category: "technology",
    tags: ["玻璃", "蓝色", "透明"],
    stroke: "#527ca0",
    fill: "#12202c",
    accent: "#8ac8f5",
    motif: "glass",
  },
  { id: "light-card", zh: "浅色卡片", en: "Light card", category: "light", tags: ["浅色", "简洁", "BI"], stroke: "#c9d2d8", fill: "#f7f9fa", accent: "#3278a8", motif: "minimal" },
  {
    id: "light-report",
    zh: "浅色报表",
    en: "Light report",
    category: "light",
    tags: ["浅色", "报表", "打印"],
    stroke: "#cbd1d5",
    fill: "#ffffff",
    accent: "#496b82",
    motif: "paper",
  },
  { id: "light-mint", zh: "浅色薄荷", en: "Light mint", category: "light", tags: ["浅色", "绿色", "运营"], stroke: "#b9d5cf", fill: "#f4faf8", accent: "#298b78", motif: "corner" },
  { id: "light-sand", zh: "浅色暖砂", en: "Light sand", category: "light", tags: ["浅色", "暖色", "经营"], stroke: "#d8ccb8", fill: "#fbf8f2", accent: "#9b6b2f", motif: "paper" },
] as const;

export const DASHBOARD_COMPONENT_BACKGROUNDS: readonly DashboardComponentBackgroundAsset[] = DEFINITIONS.map((definition) => ({
  id: definition.id,
  zh: definition.zh,
  en: definition.en,
  category: definition.category,
  tags: definition.tags,
  url: svgDataUrl(definition),
}));

export function dashboardComponentBackgroundText(asset: DashboardComponentBackgroundAsset, locale: AppLocale): string {
  return locale === "zh-CN" ? asset.zh : asset.en;
}

function svgDataUrl(definition: SurfaceDefinition): string {
  const motif = surfaceMotif(definition.motif, definition.stroke, definition.accent);
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360" preserveAspectRatio="none">`,
    `<defs><linearGradient id="g-${definition.id}" x1="0" y1="0" x2="1" y2="1">`,
    `<stop stop-color="${definition.fill}"/>`,
    `<stop offset="1" stop-color="${definition.fill}" stop-opacity=".78"/>`,
    `</linearGradient></defs>`,
    `<rect x="1" y="1" width="638" height="358" rx="12" fill="url(#g-${definition.id})" stroke="${definition.stroke}" stroke-width="2"/>`,
    motif,
    `</svg>`,
  ].join("");
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function surfaceMotif(motif: SurfaceDefinition["motif"], stroke: string, accent: string): string {
  if (motif === "corner")
    return `<path d="M1 54V13Q1 1 13 1h76M551 1h76q12 0 12 12v41M639 306v41q0 12-12 12h-76M89 359H13q-12 0-12-12v-41" fill="none" stroke="${accent}" stroke-width="5"/><path d="M22 20h110M508 340h110" stroke="${stroke}" stroke-width="2"/>`;
  if (motif === "notch")
    return `<path d="M1 38L38 1h122l18 12h284l18-12h122l37 37M639 322l-37 37H38L1 322" fill="none" stroke="${accent}" stroke-width="3"/><circle cx="24" cy="180" r="4" fill="${accent}"/><circle cx="616" cy="180" r="4" fill="${accent}"/>`;
  if (motif === "rail")
    return `<path d="M18 34h604M18 326h604" stroke="${stroke}" stroke-width="2"/><path d="M18 34h150M472 326h150" stroke="${accent}" stroke-width="5"/><path d="M30 48v264M610 48v264" stroke="${stroke}" stroke-dasharray="3 9"/>`;
  if (motif === "pulse")
    return `<path d="M20 316h120l22-26 25 42 28-82 30 66h375" fill="none" stroke="${accent}" stroke-width="3"/><path d="M20 44h90M530 44h90" stroke="${stroke}" stroke-width="3"/><circle cx="320" cy="44" r="4" fill="${accent}"/>`;
  if (motif === "grid")
    return `<path d="M80 1v358M160 1v358M240 1v358M320 1v358M400 1v358M480 1v358M560 1v358M1 72h638M1 144h638M1 216h638M1 288h638" stroke="${stroke}" stroke-width="1" opacity=".16"/><path d="M1 72h80V1M559 359v-72h80" fill="none" stroke="${accent}" stroke-width="3"/>`;
  if (motif === "glass") return `<path d="M18 20h604L438 180H18z" fill="#fff" opacity=".045"/><path d="M30 330h260M350 330h260" stroke="${accent}" stroke-width="2" opacity=".8"/>`;
  if (motif === "paper")
    return `<path d="M24 48h592M24 88h592M24 128h592M24 168h592M24 208h592M24 248h592M24 288h592" stroke="${stroke}" stroke-width="1" opacity=".22"/><path d="M24 48h180" stroke="${accent}" stroke-width="3"/>`;
  return `<path d="M18 18h76M18 18v76M622 342h-76M622 342v-76" fill="none" stroke="${accent}" stroke-width="3"/><path d="M112 18h416" stroke="${stroke}" opacity=".45"/>`;
}
