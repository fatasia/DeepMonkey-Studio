import type { DashboardDataWidgetNode, WidgetFrame } from "@bim-studio/contracts";
import type { Deep2dColor } from "@bim-studio/deep-engine";
import { DASHBOARD_CONTENT_INSET } from "./dashboardShapeContent";

/**
 * 文字内容 lowering。取值全部对齐 Web 运行时的真实实现,不臆造:
 * - 基础字体族取 `styles/base.css` 首条 font-family(与 native cosmic-text 的系统字体族一致);
 * - textColor 回退 `#eef2f4`(`DashboardCanvasNode` / `DashboardInspectorStyle` 同一默认);
 * - 字号/字重默认取 `dashboardWorkspaceModel` 建组件的真实出厂值(text 28/600,digital-flip 38/700);
 * - `vertical-align` 语义取运行时 `align-items:center` + `white-space:pre-wrap`。
 *
 * **本模块只解算样式与排版事实,不产出显示列表命令。** 原因是跨语言合同的真实形状:
 * native `deep2d::validate_text` 要求文字命令携带 `atlasId + bakedGlyphs`,非空 `text`
 * 但没有 baked glyphs 会被判 `InvalidStructure` 并在渲染前拒绝;图表文字走的是
 * 「光栅化 → 图片图集」通道,同样不是裸 text 命令。TS 侧的 `Deep2dCommand` 目前只声明了
 * `fontId`(未成形文字),因此任何 TS 生产者直接下发 text 命令,都会得到一份
 * 「TS 校验通过、native 拒收」的伪支持产物。
 *
 * 结论:文字像素的产出必须等 P1-18 的字形运行(glyph run)+ 字形图集就绪。
 * 在那之前,本模块提供样式/排版解算与逐字段 deferred 原因,`compiledFields` 保持为空,
 * 能力报告因此不会把文字算成已支持。
 */

export const DASHBOARD_BASE_FONT_STACK =
  'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif';
const TEXT_COLOR_FALLBACK = "#eef2f4";
const TEXT_FONT_SIZE_DEFAULT = 28;
const TEXT_FONT_WEIGHT_DEFAULT = 600;
/**
 * 行高倍数:CSS `normal` 的常用落点。真实垂直居中需要字形实测高度(P1-17 的 measure),
 * 本 pass 先用声明式倍数,并把该口径写进 pass 记录,不当成实测结论。
 */
export const DASHBOARD_LINE_HEIGHT_FACTOR = 1.2;
/** 字体资产的已声明身份;字体包闭包/回退诊断属 P1-19,此处只冻结资源身份。 */
export const DASHBOARD_FONT_ASSET_ID = "deep.builtin.ui-sans.v1";
export const DASHBOARD_FONT_FAMILY = "Microsoft YaHei UI";

/** 文字块的一个排版行:文本 + 在内容框内的顶边偏移(逻辑像素)。 */
export interface TextLineBox {
  readonly text: string;
  readonly top: number;
}

export interface TextLowering {
  /** 解算后的文本行框;字形运行未就绪时不产出像素。 */
  readonly lines: readonly TextLineBox[];
  /** 解算后的样式事实,供 P1-18 字形运行与能力报告直接消费。 */
  readonly style: {
    readonly fontSize: number;
    readonly fontWeight: number;
    readonly color: Deep2dColor;
    readonly align: "start" | "center" | "end";
  } | null;
  /** 内容框(框内缩 17 后的矩形);空框为 null。 */
  readonly box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | null;
  /** 本 pass 真正编译了的字段。字形通道未接通时恒为空,能力报告不得据此记 supported。 */
  readonly compiledFields: readonly string[];
  /** 逐字段未编译原因。 */
  readonly reasons: readonly string[];
  /** 是否产出了受支持文字像素。 */
  readonly contentCompiled: boolean;
}

/** 文字组件(text)内容解算:作者文本 + 样式 + 排版框。 */
export function lowerDashboardText(node: DashboardDataWidgetNode, revision: number): TextLowering {
  const widget = node.widget;
  const raw = widget.content ?? "";
  const box = textBox(node.frame);
  if (raw.length === 0) return empty(["文字组件内容为空;空文本不产出绘制命令"], box);
  if (!box) return empty(["文字组件内容框为空"], null);
  const fontSize = positiveOr(widget.fontSize, TEXT_FONT_SIZE_DEFAULT);
  const lines = wrapLines(raw, fontSize, box.width);
  // pre-wrap 保留作者换行与行内空白,只去掉尾部空行(不改变可见字形)。
  while (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const blockHeight = lines.length * lineHeight(fontSize);
  // 垂直居中:内容框中心对齐文本块中心(运行时 align-items:center)。
  const blockTop = box.y + Math.max(0, (box.height - blockHeight) / 2);
  const lineBoxes = lines.map((text, index) => ({ text, top: blockTop + index * lineHeight(fontSize) }));
  const style = {
    fontSize, fontWeight: normalizeWeight(widget.fontWeight, TEXT_FONT_WEIGHT_DEFAULT),
    color: resolveTextColor(widget.textColor), align: textAlign(widget.textAlign),
  };
  const reasons = [`字形运行与字形图集未就绪(P1-18):native 要求 atlasId+bakedGlyphs,裸 text 命令会被渲染前拒绝;字体身份 ${DASHBOARD_FONT_ASSET_ID}@${revision}`];
  if ((widget.animation ?? "none") !== "none") reasons.push("组件入场/循环动画为 CSS 关键帧,未编译进显示列表");
  if (!/^#[0-9a-f]{3,8}$/i.test(widget.textColor ?? TEXT_COLOR_FALLBACK)) {
    reasons.push("textColor 非十六进制(CSS 变量/渐变),已解算为默认色");
  }
  if (lines.length !== raw.split("\n").length) reasons.push("文本按内容框宽度自动折行,折行宽度为声明式估算");
  return { lines: lineBoxes, style, box, compiledFields: [], reasons, contentCompiled: false };
}

/** 数值组件(value)的可解算部分:标题行样式与位置。数值本身由数据绑定解析,不在内容 pass 编造。 */
export function lowerDashboardValueText(node: DashboardDataWidgetNode): TextLowering {
  const widget = node.widget;
  const box = textBox(node.frame);
  if (!box) return empty(["数值组件内容框为空"], null);
  const title = widget.title ?? "";
  const reasons = ["数值内容与单位排版等待数据绑定解析(编译期不臆造显示值)",
    "字形运行与字形图集未就绪(P1-18),标题文字同样不产出像素"];
  if (title.length === 0) return { lines: [], style: null, box, compiledFields: [], reasons, contentCompiled: false };
  return {
    // `.dashboard-value` 是 `align-content: space-between` 的网格:标题贴上边。
    lines: [{ text: title, top: box.y }],
    style: { fontSize: VALUE_TITLE_FONT_SIZE, fontWeight: 400, color: VALUE_TITLE_COLOR, align: "start" },
    box, compiledFields: [], reasons, contentCompiled: false,
  };
}

/** `.dashboard-value > span`(platform-components.css)。 */
const VALUE_TITLE_FONT_SIZE = 10;
const VALUE_TITLE_COLOR: Deep2dColor = [0x7f / 255, 0x8c / 255, 0x92 / 255, 1];

/** 与 `widgetBackgroundStyle` 的 textColor 回退保持同一默认。 */
export function resolveTextColor(value: string | undefined): Deep2dColor {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value ?? TEXT_COLOR_FALLBACK);
  return hexToColor(`#${(hex?.[1] ?? TEXT_COLOR_FALLBACK.slice(1))}`);
}

function hexToColor(hex: string): Deep2dColor {
  const body = hex.slice(1);
  const expand = body.length <= 4 ? body.split("").map(character => character + character).join("") : body;
  const channel = (index: number) => parseInt(expand.slice(index * 2, index * 2 + 2), 16) / 255;
  const alpha = expand.length === 8 ? channel(3) : 1;
  return [channel(0), channel(1), channel(2), alpha];
}

/** 字体资源的已冻结身份描述(P1-18 接入字形图集时用于构造真实资源)。 */
export function fontIdentity(revision: number, weight: number, style: "normal" | "italic") {
  return { kind: "font" as const, id: `font:${DASHBOARD_FONT_ASSET_ID}:${weight}:${style}`, revision,
    assetId: DASHBOARD_FONT_ASSET_ID, family: DASHBOARD_FONT_FAMILY, weight, style };
}

/** Em 盒高度。CSS 行框高 = 行高,块高 = 行数 × 行高;该系数是声明式口径,不是实测。 */
export function lineHeight(fontSize: number): number {
  return fontSize * DASHBOARD_LINE_HEIGHT_FACTOR;
}

export function textBox(frame: WidgetFrame) {
  const x = frame.x + DASHBOARD_CONTENT_INSET, y = frame.y + DASHBOARD_CONTENT_INSET;
  const width = frame.width - DASHBOARD_CONTENT_INSET * 2, height = frame.height - DASHBOARD_CONTENT_INSET * 2;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

function textAlign(value: DashboardDataWidgetNode["widget"]["textAlign"]): "start" | "center" | "end" {
  return value === "center" ? "center" : value === "right" ? "end" : "start";
}

function normalizeWeight(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(1000, Math.max(1, Math.round(value)));
}

function positiveOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * 按内容框宽度折行。宽度用**声明式**字宽估算(半角 0.5em / 全角 1em),
 * 真实字形宽度在 P1-17 measure 接线后替换;折行结果因此登记原因,不宣称实测。
 */
export function wrapLines(text: string, fontSize: number, maxWidth: number): string[] {
  const limit = maxWidth / fontSize;
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let current = "", width = 0;
    for (const cluster of Array.from(paragraph)) {
      const advance = clusterWidth(cluster);
      if (width + advance > limit && current.length > 0) {
        lines.push(current);
        current = ""; width = 0;
      }
      current += cluster; width += advance;
    }
    lines.push(current);
  }
  return lines;
}

export function clusterWidth(cluster: string): number {
  const code = cluster.codePointAt(0);
  // 空簇不占宽度;Array.from 不会产出空簇,此处只是把边界写清楚。
  if (code === undefined) return 0;
  // 全角/CJK/emoji 记 1em,其余记 0.5em:粗估口径,不是实测字形宽度。
  return code > 0x2e7f || (code >= 0x3000 && code <= 0x9fff) || code >= 0xf900 ? 1 : 0.5;
}

function empty(reasons: string[], box: TextLowering["box"]): TextLowering {
  return { lines: [], style: null, box, compiledFields: [], reasons, contentCompiled: false };
}