import type { DashboardComponentPreset } from "./dashboardComponentPresetTypes";
import { decorationPreset } from "./dashboardComponentPresetFactory";

/**
 * 装饰造型族(素材数量波次 A):边框 8 / 标题条 8 / 光效 8 = 24 款。
 * mark 全部显式命名且 (type+family+mark) 全局唯一;造型全部走既有装饰
 * 运行时的净化 SVG 程序化绘制(弧顶、舰首、蜂窝、角标链、雷达环、数据雨等),
 * 禁止引用任何竞品素材;光效通过 animation 脉冲/扫掠表达动效语义。
 */

/** 循环脉冲动效(装饰呼吸/扫掠共用)。 */
const LOOP = { animation: "pulse" as const, animationAutoplay: true, animationLoop: true };

export const DASHBOARD_DECORATION_PRESETS_3: readonly DashboardComponentPreset[] = [
  // ── 边框 8(family=frame)────────────────────────────────────────────
  decorationPreset({ id: "arc-crown-frame", zh: "弧顶边框", en: "Arc crown frame", descriptionZh: "顶部拱弧造型承载塔台与展厅分区", family: "frame", mark: "ARC", style: "border", content: "", width: 560, height: 320, color: "#58a0e8" }),
  decorationPreset({ id: "bow-prow-frame", zh: "舰首边框", en: "Bow prow frame", descriptionZh: "舰首劈浪造型用于航行与运输主题区", family: "frame", mark: "BOW", style: "header-wing", content: "", width: 580, height: 300, color: "#52b2c8" }),
  decorationPreset({ id: "command-center-frame", zh: "指挥中心边框", en: "Command center frame", descriptionZh: "宽幅指挥舱边框承载主态势大区", family: "frame", mark: "CMD", style: "border", content: "", width: 860, height: 460, color: "#57a5e6" }),
  decorationPreset({ id: "hex-cell-frame", zh: "六边蜂窝边框", en: "Hex cell frame", descriptionZh: "六边蜂窝角部呼应蜂窝结构主题", family: "frame", mark: "HEXA", style: "bracket", content: "", width: 500, height: 300, color: "#d8a84e" }),
  decorationPreset({ id: "chamfer-corner-frame", zh: "斜切角边框", en: "Chamfered corner frame", descriptionZh: "四角斜切呈现工业机甲面板质感", family: "frame", mark: "CHAM", style: "corner", content: "", width: 540, height: 320, color: "#719bb2" }),
  decorationPreset({ id: "twin-line-frame", zh: "双线边框", en: "Twin line frame", descriptionZh: "内外双线勾勒的克制型数据面板", family: "frame", mark: "DUO", style: "border", content: "", width: 520, height: 300, color: "#6a9fe8" }),
  decorationPreset({ id: "corner-chain-frame", zh: "角标链边框", en: "Corner chain frame", descriptionZh: "角部链环元素串联多面板视觉", family: "frame", mark: "CHAIN", style: "corner", content: "", width: 520, height: 300, color: "#52c18a" }),
  decorationPreset({ id: "energy-ring-frame", zh: "能量环边框", en: "Energy ring frame", descriptionZh: "角部能量环呼吸提示核心分区供能", family: "frame", mark: "RING", style: "neon", content: "", width: 540, height: 320, color: "#4cc4d4", widget: { ...LOOP, animationDuration: 3000 } }),

  // ── 标题条 8(family=title)──────────────────────────────────────────
  decorationPreset({ id: "bridge-console-title", zh: "舰桥标题条", en: "Bridge console title", descriptionZh: "舰桥操纵台造型承载驾驶舱页首", family: "title", mark: "BRIDGE", style: "header-wing", content: "驾驶舱", width: 560, height: 76, color: "#57a5e6" }),
  decorationPreset({ id: "emblem-title", zh: "徽章标题条", en: "Emblem title", descriptionZh: "左侧徽章托底用于荣誉与资质分区", family: "title", mark: "BADGE", style: "title", content: "安全荣誉榜", width: 500, height: 72, color: "#d8a84e" }),
  decorationPreset({ id: "flag-banner-title", zh: "旗帜标题条", en: "Flag banner title", descriptionZh: "旗帜横幅表达战役与攻坚主题", family: "title", mark: "FLAG", style: "scan", content: "生产攻坚", width: 520, height: 72, color: "#e8785c" }),
  decorationPreset({ id: "arch-gate-title", zh: "拱形标题条", en: "Arch gate title", descriptionZh: "拱门造型用于展厅与通道分区", family: "title", mark: "ARCH", style: "bracket", content: "参观通道", width: 480, height: 70, color: "#a083e8" }),
  decorationPreset({ id: "wing-led-title", zh: "双翼灯带标题条", en: "Wing LED title", descriptionZh: "双翼灯带呼吸表达总控区氛围", family: "title", mark: "WLED", style: "header-wing", content: "总控中心", width: 620, height: 76, color: "#52b2c8", widget: { ...LOOP, animationDuration: 2600 } }),
  decorationPreset({ id: "prism-facet-title", zh: "棱镜标题条", en: "Prism facet title", descriptionZh: "棱镜折面高光承载数据洞察分区", family: "title", mark: "PRISM", style: "neon", content: "数据洞察", width: 520, height: 72, color: "#b48ae6" }),
  decorationPreset({ id: "chain-link-title", zh: "链条标题条", en: "Chain link title", descriptionZh: "链条节扣造型用于供应链分区", family: "title", mark: "CLINK", style: "frame-notch", content: "供应链协同", width: 520, height: 70, color: "#719bb2" }),
  decorationPreset({ id: "step-terrace-title", zh: "阶梯标题条", en: "Step terrace title", descriptionZh: "阶梯抬升造型表达层级与进阶", family: "title", mark: "STAIR", style: "title", content: "产能爬坡", width: 520, height: 72, color: "#52c18a" }),

  // ── 光效 8(family=light ×6 / scan ×2)───────────────────────────────
  decorationPreset({ id: "meteor-streak-light", zh: "流星划痕光效", en: "Meteor streak light", descriptionZh: "流星划过点缀大屏转换与庆祝时刻", family: "light", mark: "METEOR", style: "dots", content: "", width: 420, height: 60, color: "#f0c25a", widget: { ...LOOP, animationDuration: 1800 } }),
  decorationPreset({ id: "ripple-diffuse-ring", zh: "波纹扩散环", en: "Ripple diffuse ring", descriptionZh: "波纹扩散表达事件影响半径", family: "light", mark: "RIPPLE", style: "neon", content: "", width: 200, height: 110, color: "#4cc4d4", widget: { ...LOOP, animationDuration: 2200 } }),
  decorationPreset({ id: "radar-sweep-ring", zh: "雷达扫描环", en: "Radar sweep ring", descriptionZh: "雷达扫掠环监测周边目标分布", family: "scan", mark: "RSCAN", style: "scan", content: "周边目标", width: 320, height: 220, color: "#4cc4d4", widget: { ...LOOP, animationDuration: 3000 } }),
  decorationPreset({ id: "data-rain-stream", zh: "数据雨光效", en: "Data rain light", descriptionZh: "数据雨营造实时流入的计算氛围", family: "light", mark: "RAIN", style: "dots", content: "", width: 480, height: 140, color: "#58a0e8", widget: { ...LOOP, animationDuration: 2000 } }),
  decorationPreset({ id: "glow-corner-accent", zh: "辉光角效", en: "Glow corner accent", descriptionZh: "角部辉光晕染突出面板重点", family: "light", mark: "GCORN", style: "corner", content: "", width: 160, height: 100, color: "#f0c25a" }),
  decorationPreset({ id: "particle-orbit-ring", zh: "粒子环绕环", en: "Particle orbit ring", descriptionZh: "粒子环绕表达设备运行轨道", family: "light", mark: "ORBIT", style: "dots", content: "", width: 240, height: 140, color: "#68bec6", widget: { ...LOOP, animationDuration: 2600 } }),
  decorationPreset({ id: "light-shutter-curtain", zh: "扫光幕帘", en: "Light shutter curtain", descriptionZh: "幕帘式扫光用于舞台与发布分区", family: "scan", mark: "SHUTTER", style: "scan", content: "发布区", width: 560, height: 64, color: "#58a0e8", widget: { ...LOOP, animationDuration: 2400 } }),
  decorationPreset({ id: "energy-flow-bar", zh: "能量条", en: "Energy flow bar", descriptionZh: "分段能量条表达供需平衡状态", family: "light", mark: "EBAR", style: "segment", content: "", width: 520, height: 24, color: "#52c18a", widget: { ...LOOP, animationDuration: 2200 } }),
] as const;
