import type { Deep2dColor } from "@bim-studio/deep-engine";

/** CSS sRGB components to linear path/tint RGB. Alpha stays straight and unchanged. */
export function cssSrgbToLinearColor(color: readonly number[]): Deep2dColor {
  if (color.length !== 4 || color.some(value => !Number.isFinite(value) || value < 0 || value > 1))
    throw new Error("Expected four normalized CSS sRGB components");
  const linear = (value: number) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  return [linear(color[0]!), linear(color[1]!), linear(color[2]!), color[3]!];
}
