export type CaptureRect = readonly [number, number, number, number];

export function intersectCaptureRects(a: CaptureRect, b: CaptureRect): CaptureRect {
  const x = Math.max(a[0], b[0]), y = Math.max(a[1], b[1]);
  return [x, y, Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - x),
    Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - y)];
}

export function captureColor(value: string): [number, number, number, number] {
  return captureNormalizedColor(value).map(v => Math.round(v * 255)) as [number, number, number, number];
}

/** CSS float channels remain exact until a byte atlas is requested. */
export function captureNormalizedColor(value: string): [number, number, number, number] {
  const match = /^rgba?\(\s*([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/.exec(value);
  if (!match) throw new Error("Capture requires computed sRGB color");
  const result = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4] ?? 1) * 255];
  if (result.some(v => !Number.isFinite(v) || v < 0 || v > 255)) throw new Error("Invalid computed color");
  return result.map(v => v / 255) as [number, number, number, number];
}

export function capturePixels(value: string, field: string): number {
  if (!/^-?(?:\d+(?:\.\d+)?|\.\d+)px$/.test(value) || !Number.isFinite(Number(value.slice(0, -2))))
    throw new Error(`Capture requires resolved ${field} in pixels`);
  return Number.parseFloat(value);
}

/** Only axis-aligned uniform transforms preserve captured CSS typography. */
export function captureTransformScale(style: CSSStyleDeclaration): number {
  if ([style.rotate, style.scale, style.translate].some(value => value && value !== "none")
    || (style.zoom && !["normal", "1"].includes(style.zoom)))
    throw new Error("Independent transforms or zoom require a separate appearance pass");
  if (!style.transform || style.transform === "none") return 1;
  const match = /^matrix\(([^)]+)\)$/.exec(style.transform);
  const values = match?.[1]?.split(",").map(Number);
  if (!values || values.length !== 6 || values.some(value => !Number.isFinite(value))
    || values[1] !== 0 || values[2] !== 0 || values[0]! <= 0 || values[0] !== values[3])
    throw new Error("Rotated, mirrored or nonuniform capture is unsupported");
  return values[0]!;
}

/** Refuse CSS whitespace changes instead of changing a frozen semantic value. */
export function captureTextWrap(style: CSSStyleDeclaration, text: string): "none" | "word" | "word-or-glyph" {
  if (!["normal", "nowrap", "pre", "pre-wrap"].includes(style.whiteSpace)
    || style.wordBreak !== "normal" || (style.hyphens && style.hyphens !== "none" && style.hyphens !== "manual"))
    throw new Error("Unsupported whitespace, word-break or hyphenation");
  if (text.includes("\t") || text.includes("\u00ad"))
    throw new Error("Tabs or discretionary hyphens require matching text layout semantics");
  if (["normal", "nowrap"].includes(style.whiteSpace) && /[\n\r\f]| {2}|^ | $/.test(text))
    throw new Error("CSS whitespace collapse differs from the frozen semantic text");
  if (["nowrap", "pre"].includes(style.whiteSpace)) return "none";
  // Native TextWrap::Word maps directly to cosmic-text Word, with no glyph fallback.
  if (style.overflowWrap === "normal") return "word";
  if (!["anywhere", "break-word"].includes(style.overflowWrap))
    throw new Error("Unsupported overflow-wrap");
  return "word-or-glyph";
}
