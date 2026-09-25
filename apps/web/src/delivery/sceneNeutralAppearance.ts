import type { SceneModelEffectsState } from "@bim-studio/contracts";

const neutralMaterial: Readonly<Record<string, number | boolean>> = {
  hue: 0, saturation: 0, brightness: 0, contrast: 0, normalScale: 1, wireframe: false,
  textureRepeat: 1, textureRepeatX: 1, textureRepeatY: 1,
  textureOffsetX: 0, textureOffsetY: 0, textureRotation: 0,
};

/** Saved scene colors are CSS sRGB; Deep material packets use linear RGB. */
export function sceneHexToLinearRgb(value: string): [number, number, number] {
  if (!/^#[\da-f]{6}$/i.test(value)) throw new Error(`场景颜色必须为 #RRGGBB：${value}`);
  // Keep authored 3D material values byte-for-byte compatible with the current Three color transfer.
  const linear = (offset: number) => {
    const channel = parseInt(value.slice(offset, offset + 2), 16) / 255;
    return channel < 0.04045 ? channel * 0.0773993808
      : Math.pow(channel * 0.9478672986 + 0.0521327014, 2.4);
  };
  return [linear(1), linear(3), linear(5)];
}

/** 编辑器会保存默认值；仅精确中性值可省略，未知或激活的外观仍交给能力门禁。 */
export function isNeutralMaterialField(key: string, value: unknown): boolean {
  if (/^(baseColor|normal|emissive|ambientOcclusion|roughness|metalness)Map(Url|Name)$/.test(key) && value === "") return true;
  if ((key === "uvAnimation" || key === "screen") && value && typeof value === "object" && "enabled" in value && value.enabled === false) return true;
  return Object.hasOwn(neutralMaterial, key) && value === neutralMaterial[key];
}

export function hasActiveSceneEffects(effects: SceneModelEffectsState | undefined): boolean {
  return activeSceneEffectFields(effects).length > 0;
}

export function activeSceneEffectFields(effects: SceneModelEffectsState | undefined): string[] {
  if (!effects) return [];
  const flags = new Set(["outline", "glow", "xray", "scanline", "heatmap", "edgeLight"]);
  return Object.entries(effects).filter(([key, value]) => {
    if (value === undefined || key === "color" || key === "intensity") return false;
    if (flags.has(key)) return value !== false;
    if (key === "dissolve") return value !== 0;
    return true;
  }).map(([key]) => key).sort();
}

/** Web Viewer 现有 glow/edgeLight 都投影到 HDR emissive，随后由 Bloom 产生光晕。 */
export function staticSceneEffectEmissive(effects: SceneModelEffectsState | undefined):
  { readonly color: string; readonly strength: number } | undefined {
  if (!effects?.glow && !effects?.edgeLight) return undefined;
  if (!/^#[\da-f]{6}$/iu.test(effects.color)) throw new Error(`对象效果颜色必须为 #RRGGBB：${effects.color}`);
  if (!Number.isFinite(effects.intensity) || effects.intensity < 0) throw new Error("对象效果强度必须为非负有限数值");
  const strength = effects.intensity * (effects.edgeLight ? 1.4 : 0.8);
  if (!Number.isFinite(Math.fround(strength)) || strength > 256) throw new Error("对象效果强度超过 HDR 材质范围");
  return { color: effects.color, strength };
}

/** 已由静态材质完整承接的效果不再进入发布阻断。 */
export function unsupportedStaticSceneEffectFields(effects: SceneModelEffectsState | undefined): string[] {
  return activeSceneEffectFields(effects).filter(field => field !== "glow" && field !== "edgeLight" && field !== "outline");
}
