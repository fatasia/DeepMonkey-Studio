export interface PbrColorGrading {
  /** Normalized warm/cool shift. */
  readonly temperature: number;
  /** Normalized green/magenta shift. */
  readonly tint: number;
  readonly contrast: number;
  readonly saturation: number;
}

export type PbrColorGradingOptions = "neutral" | "studio" | Partial<PbrColorGrading>;
export const PBR_OUTPUT_UNIFORM_FLOATS = 8;
export const NEUTRAL_PBR_COLOR_GRADING: PbrColorGrading = Object.freeze({
  temperature: 0, tint: 0, contrast: 1, saturation: 1,
});
export const STUDIO_PBR_COLOR_GRADING: PbrColorGrading = Object.freeze({
  temperature: 0.08, tint: 0.02, contrast: 1.08, saturation: 1.05,
});

const LIMITS = Object.freeze({ temperature: [-1, 1], tint: [-1, 1],
  contrast: [0.5, 2], saturation: [0, 2] } as const);

export function resolvePbrColorGrading(options: PbrColorGradingOptions | undefined): PbrColorGrading {
  if (options === undefined || options === "neutral") return NEUTRAL_PBR_COLOR_GRADING;
  if (options === "studio") return STUDIO_PBR_COLOR_GRADING;
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("PBR color grading must be neutral, studio, or an options object.");
  }
  for (const key of Object.keys(options)) {
    if (!Object.prototype.hasOwnProperty.call(LIMITS, key)) throw new TypeError(`Unknown PBR color grading option: ${key}.`);
  }
  const value = <K extends keyof PbrColorGrading>(key: K): number => {
    const candidate = options[key] ?? NEUTRAL_PBR_COLOR_GRADING[key], [minimum, maximum] = LIMITS[key];
    if (!Number.isFinite(candidate) || candidate < minimum || candidate > maximum) {
      throw new RangeError(`PBR color grading ${key} must be within ${minimum}..${maximum}.`);
    }
    return candidate;
  };
  return Object.freeze({ temperature: value("temperature"), tint: value("tint"),
    contrast: value("contrast"), saturation: value("saturation") });
}

/** CPU mirror of the linear-HDR grade used before tone mapping. */
export function applyPbrColorGradingLinear(source: readonly [number, number, number],
  grading: PbrColorGrading): readonly [number, number, number] {
  if (source.length !== 3 || !source.every(Number.isFinite)) throw new TypeError("PBR color grading source must be finite RGB.");
  const selected = resolvePbrColorGrading(grading);
  if (selected.temperature === 0 && selected.tint === 0 && selected.contrast === 1 && selected.saturation === 1) {
    return Object.freeze([...source]) as readonly [number, number, number];
  }
  const color = source.map(value => clamp(value, 0, 65_504));
  const gains = [1 + selected.temperature * 0.14 + selected.tint * 0.07,
    1 - selected.tint * 0.12, 1 - selected.temperature * 0.14 + selected.tint * 0.07];
  const sourceLuma = luminance(color), balanced = color.map((value, index) => value * gains[index]!);
  const balanceScale = sourceLuma / Math.max(luminance(balanced), 1e-6);
  for (let index = 0; index < 3; index++) balanced[index]! *= balanceScale;
  const contrasted = balanced.map(value => value <= 0 ? 0 : 0.18 * 2 ** clamp(
    Math.log2(Math.max(value / 0.18, 1e-6)) * selected.contrast, -20, 20));
  const luma = luminance(contrasted);
  const output = contrasted.map(value => clamp(luma + (value - luma) * selected.saturation, 0, 65_504));
  return Object.freeze(output) as readonly [number, number, number];
}

function luminance(value: readonly number[]): number { return value[0]! * 0.2126 + value[1]! * 0.7152 + value[2]! * 0.0722; }
function clamp(value: number, minimum: number, maximum: number): number { return Math.min(maximum, Math.max(minimum, value)); }
