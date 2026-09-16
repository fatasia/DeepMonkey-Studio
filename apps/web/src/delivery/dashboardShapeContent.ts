import type { DashboardDataWidgetNode } from "@bim-studio/contracts";
import type { Deep2dColor, Deep2dPathVerb } from "@bim-studio/deep-engine";

/** Matches the content box in dashboard-native-widget (1px border + 16px padding). */
export const DASHBOARD_CONTENT_INSET = 17;

export function lowerDashboardShape(node: DashboardDataWidgetNode) {
  const widget = node.widget;
  if (widget.type !== "shape") throw new Error(`组件 ${widget.type} 尚无内容编译器`);
  if (widget.content) throw new Error("形状文字需要字体编译");
  if (widget.semanticBinding) throw new Error("语义绑定必须先解析为冻结组件快照");
  const fill = parseHexColor(widget.color);
  const width = node.frame.width - DASHBOARD_CONTENT_INSET * 2;
  const height = node.frame.height - DASHBOARD_CONTENT_INSET * 2;
  if (width <= 0 || height <= 0) throw new Error("组件内容框为空");
  const shape = widget.shape ?? "rectangle";
  if (shape === "line") throw new Error("线形组件的 currentColor 与 CSS 定位尚未编译");
  if (!["rectangle", "rounded", "ellipse"].includes(shape)) throw new Error("未知形状类型");
  const verbs = shape === "ellipse" ? ellipse(width, height)
    : roundedRectangle(width, height, shape === "rounded" ? Math.min(18, width / 2, height / 2) : 0);
  return { fill, verbs, x: node.frame.x + DASHBOARD_CONTENT_INSET, y: node.frame.y + DASHBOARD_CONTENT_INSET };
}

/** 解析 #RGB/#RGBA/#RRGGBB/#RRGGBBAA;其余(CSS 变量、渐变、函数色)显式拒绝。 */
export function parseHexColor(value: string | undefined): Deep2dColor {
  if (!value || !/^#(?:[a-f\d]{3}|[a-f\d]{4}|[a-f\d]{6}|[a-f\d]{8})$/i.test(value))
    throw new Error("形状颜色需要解析后的十六进制颜色，CSS 变量与渐变尚未编译");
  let hex = value.slice(1);
  if (hex.length <= 4) hex = [...hex].map(char => char + char).join("");
  if (hex.length === 6) hex += "ff";
  const channel = (offset: number) => parseInt(hex.slice(offset, offset + 2), 16) / 255;
  return [channel(0), channel(2), channel(4), channel(6)];
}

function roundedRectangle(w: number, h: number, r: number): Deep2dPathVerb[] {
  if (r === 0) return [{ op: "move", x: 0, y: 0 }, { op: "line", x: w, y: 0 },
    { op: "line", x: w, y: h }, { op: "line", x: 0, y: h }, { op: "close" }];
  const k = 0.5522847498307936;
  return [{ op: "move", x: r, y: 0 }, { op: "line", x: w - r, y: 0 },
    { op: "cubic", c1x: w - r + k * r, c1y: 0, c2x: w, c2y: r - k * r, x: w, y: r },
    { op: "line", x: w, y: h - r },
    { op: "cubic", c1x: w, c1y: h - r + k * r, c2x: w - r + k * r, c2y: h, x: w - r, y: h },
    { op: "line", x: r, y: h },
    { op: "cubic", c1x: r - k * r, c1y: h, c2x: 0, c2y: h - r + k * r, x: 0, y: h - r },
    { op: "line", x: 0, y: r },
    { op: "cubic", c1x: 0, c1y: r - k * r, c2x: r - k * r, c2y: 0, x: r, y: 0 }, { op: "close" }];
}

function ellipse(w: number, h: number): Deep2dPathVerb[] {
  const x = w / 2, y = h / 2, k = 0.5522847498307936;
  return [{ op: "move", x: w, y },
    { op: "cubic", c1x: w, c1y: y * (1 + k), c2x: x * (1 + k), c2y: h, x, y: h },
    { op: "cubic", c1x: x * (1 - k), c1y: h, c2x: 0, c2y: y * (1 + k), x: 0, y },
    { op: "cubic", c1x: 0, c1y: y * (1 - k), c2x: x * (1 - k), c2y: 0, x, y: 0 },
    { op: "cubic", c1x: x * (1 + k), c1y: 0, c2x: w, c2y: y * (1 - k), x: w, y }, { op: "close" }];
}
