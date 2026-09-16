import type { DashboardButtonGroup } from "./dashboardDataRasterTypes";
import { captureColor, capturePixels, type CaptureRect } from "./dashboardDataCaptureGeometry";

/** The production pager has one text run and uniform solid borders; refuse broader CSS groups. */
export function captureDashboardButtonGroup(element: HTMLElement, style: CSSStyleDeclaration, rect: CaptureRect): DashboardButtonGroup {
  const widths = [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth];
  const colors = [style.borderTopColor, style.borderRightColor, style.borderBottomColor, style.borderLeftColor];
  const borders = [style.borderTopStyle, style.borderRightStyle, style.borderBottomStyle, style.borderLeftStyle];
  const radii = [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius];
  if (element.children.length || new Set(widths).size !== 1 || new Set(colors).size !== 1
    || new Set(radii).size !== 1 || borders.some(value => value !== "solid" && value !== "none")
    || style.backgroundImage !== "none" || style.boxShadow !== "none" || style.textShadow !== "none"
    || style.backgroundClip !== "border-box") throw new Error("Pagination control requires a single-text, uniform rounded border group");
  const radius = capturePixels(radii[0]!, "button radius"), borderWidth = capturePixels(widths[0]!, "button border");
  const opacity = Number(style.opacity);
  if (radius < 0 || borderWidth < 0 || !Number.isFinite(opacity) || opacity < 0 || opacity > 1)
    throw new Error("Invalid pagination group appearance");
  return { rect, radius, borderWidth, opacity, background: captureColor(style.backgroundColor), border: captureColor(colors[0]!) };
}

/** Source-over inside an isolated RGBA control, followed by one group-opacity operation. */
export function compositeDashboardButtonGroup(group: DashboardButtonGroup, text: {
  readonly rect: CaptureRect; readonly width: number; readonly height: number; readonly rgba: Uint8Array;
}) {
  const [left, top, logicalWidth, logicalHeight] = group.rect;
  const width = Math.ceil(logicalWidth), height = Math.ceil(logicalHeight);
  if (!Number.isSafeInteger(text.width) || !Number.isSafeInteger(text.height) || text.width < 1 || text.height < 1
    || text.width * text.height > 1_048_576 || text.rgba.length !== text.width * text.height * 4 || text.rect.some(value => !Number.isFinite(value)))
    throw new Error("Invalid pagination text pixels");
  if (group.rect.some(value => !Number.isFinite(value)) || width <= 0 || height <= 0 || width * height > 1_048_576
    || !Number.isFinite(group.radius) || group.radius < 0 || !Number.isFinite(group.borderWidth) || group.borderWidth < 0
    || !Number.isFinite(group.opacity) || group.opacity < 0 || group.opacity > 1
    || [group.background, group.border].some(color => color.length !== 4 || color.some(value => !Number.isInteger(value) || value < 0 || value > 255)))
    throw new Error("Invalid or oversized pagination button group");
  const rgba = new Uint8Array(width * height * 4), radius = Math.min(group.radius, logicalWidth / 2, logicalHeight / 2);
  const rounded = (x: number, y: number, inset: number) => {
    const w = logicalWidth - inset * 2, h = logicalHeight - inset * 2, r = Math.max(0, radius - inset);
    x -= inset; y -= inset;
    if (x < 0 || y < 0 || x >= w || y >= h) return false;
    const dx = Math.max(r - x, x - (w - r), 0), dy = Math.max(r - y, y - (h - r), 0);
    return dx * dx + dy * dy <= r * r;
  };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const pixel = [0, 0, 0, 0];
    // Area coverage keeps subpixel radii/borders; the entire result receives opacity only once.
    for (let sy = 0; sy < 8; sy++) for (let sx = 0; sx < 8; sx++) {
      const px = x + (sx + 0.5) / 8, py = y + (sy + 0.5) / 8;
      if (!rounded(px, py, 0)) continue;
      const base = group.background.map(value => value / 255);
      if (!rounded(px, py, group.borderWidth)) over(base, group.border.map(value => value / 255));
      const tx = Math.floor(left + px - text.rect[0]), ty = Math.floor(top + py - text.rect[1]);
      if (tx >= 0 && ty >= 0 && tx < text.width && ty < text.height) {
        const offset = (ty * text.width + tx) * 4;
        over(base, Array.from(text.rgba.subarray(offset, offset + 4), value => value / 255));
      }
      for (let channel = 0; channel < 3; channel++) pixel[channel]! += base[channel]! * base[3]! / 64;
      pixel[3]! += base[3]! / 64;
    }
    const offset = (y * width + x) * 4;
    for (let channel = 0; channel < 3; channel++) rgba[offset + channel] = Math.round(pixel[3]! ? pixel[channel]! / pixel[3]! * 255 : 0);
    rgba[offset + 3] = Math.round(pixel[3]! * group.opacity * 255);
  }
  return { width, height, rgba };
}
function over(base: number[], foreground: number[]) {
  const alpha = foreground[3]! + base[3]! * (1 - foreground[3]!);
  for (let channel = 0; channel < 3; channel++) base[channel] = alpha
    ? (foreground[channel]! * foreground[3]! + base[channel]! * base[3]! * (1 - foreground[3]!)) / alpha : 0;
  base[3] = alpha;
}
