export interface PbrAuthorColorEffects {
  readonly vignette?: { readonly darkness: number };
  readonly colorGrading?: { readonly hue: number; readonly saturation: number;
    readonly brightness: number; readonly contrast: number };
}

function object(value: unknown, fields: readonly string[], name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !fields.includes(key))) throw new TypeError(`Invalid author ${name}.`);
  return value as Record<string, unknown>;
}
function scalar(value: unknown, min: number, max: number, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isFinite(Math.fround(value))
    || value < min || value > max) throw new RangeError(`Invalid author ${name}.`);
  return Math.fround(value);
}

/** Two vec4s: author/vignette/grade switches + darkness; hue/saturation/brightness/contrast. */
export function packPbrAuthorColorEffects(value: PbrAuthorColorEffects | undefined): Float32Array<ArrayBuffer> {
  const data = new Float32Array(8);
  if (value === undefined) return data;
  const effects = object(value, ["vignette", "colorGrading"], "color effects");
  data[0] = 1;
  if (effects.vignette !== undefined) {
    const vignette = object(effects.vignette, ["darkness"], "vignette");
    data[1] = 1; data[3] = scalar(vignette.darkness, 0, 3, "vignette darkness");
  }
  if (effects.colorGrading !== undefined) {
    const grading = object(effects.colorGrading, ["hue", "saturation", "brightness", "contrast"], "color grading");
    data[2] = 1;
    data[4] = scalar(grading.hue, -180, 180, "hue");
    data[5] = scalar(grading.saturation, -1, 1, "saturation");
    data[6] = scalar(grading.brightness, -1, 1, "brightness");
    data[7] = scalar(grading.contrast, -1, 1, "contrast");
  }
  return data;
}

/** Mirrors Three r185 Vignette/HueSaturation and Studio's brightness/contrast before OutputPass. */
export function applyPbrAuthorColorEffects(source: readonly [number, number, number], uv: readonly [number, number],
  effects: PbrAuthorColorEffects): readonly [number, number, number] {
  if (!Array.isArray(source) || source.length !== 3 || !Array.isArray(uv) || uv.length !== 2
    || ![...source, ...uv].every(value => Number.isFinite(value) && Number.isFinite(Math.fround(value)))) {
    throw new RangeError("Author color and UV must be finite float32 values.");
  }
  const p = packPbrAuthorColorEffects(effects);
  let color = [...source];
  if (p[1]) {
    const radial = (uv[0] - 0.5) ** 2 + (uv[1] - 0.5) ** 2;
    color = color.map(value => value * (1 - radial) + (1 - p[3]!) * radial);
  }
  if (p[2]) {
    if (p[4] !== 0) {
      const angle = p[4]! / 180 * 3.14159265, s = Math.sin(angle), c = Math.cos(angle);
      const weights = [(2 * c + 1) / 3, (-Math.sqrt(3) * s - c + 1) / 3, (Math.sqrt(3) * s - c + 1) / 3];
      color = [0, 2, 1].map(start => color.reduce((sum, value, index) => sum + value * weights[(start + index) % 3]!, 0));
    }
    const average = color.reduce((sum, value) => sum + value, 0) / 3;
    const saturation = p[5]! > 0 ? 1 - 1 / (1.001 - p[5]!) : -p[5]!;
    color = color.map(value => {
      const saturated = value + (average - value) * saturation;
      return p[6] === 0 && p[7] === 0 ? saturated : (saturated + p[6]! - 0.5) * (p[7]! + 1) + 0.5;
    });
  }
  return color as [number, number, number];
}
