import type { RenderPacket } from "@bim-studio/deep-engine";
import type { SceneMaterialState } from "@bim-studio/contracts";
import { PHYSICAL_LOBE_COLOR_NEUTRAL, PHYSICAL_LOBE_SCALARS, validatePhysicalLobePatch } from "../viewer/materialPhysicalLobeFields";
import { sceneHexToLinearRgb } from "./sceneNeutralAppearance";

type Material = RenderPacket["materials"][number];
type Extended = NonNullable<Material["extendedParameters"]>;
type Advanced = NonNullable<Material["advancedParameters"]>;

/**
 * 编辑器 SceneMaterialState 的 clearcoat / sheen / iridescence / 透射体积 → RenderPacket 材质
 * (extendedParameters + advancedParameters)。语义同 ThreeProjectionBridge:three 以 `> 0` 才装载
 * 各 lobe,sheenColor×sheen,iridescence 厚度取上界,体积仅在 transmission>0 时有效。
 * 全中性(含显式默认值)返回 undefined 两项,旧场景/默认值保存零行为变化。
 */
export function projectPhysicalLobes(source: Material, state: SceneMaterialState, ior: number): { extended?: Extended; advanced?: Advanced } {
  const value = (key: (typeof PHYSICAL_LOBE_SCALARS)[number]["key"]): number | undefined => state[key];
  const sourceExt = source.extendedParameters, sourceAdv = source.advancedParameters;
  const clearcoat = value("clearcoat") ?? sourceExt?.clearcoat.factor ?? 0;
  const clearcoatRoughness = value("clearcoatRoughness") ?? sourceExt?.clearcoat.roughness ?? 0;
  const transmission = value("transmission") ?? sourceExt?.transmission.factor ?? 0;
  const sheenScale = value("sheen");
  const sheenColor = state.sheenColor !== undefined ? sceneHexToLinearRgb(state.sheenColor).map(c => c * (sheenScale ?? 1))
    : sourceAdv?.sheen ? sourceAdv.sheen.color.map(c => c * (sheenScale ?? 1)) : undefined;
  const sheenRoughness = value("sheenRoughness") ?? sourceAdv?.sheen?.roughness ?? 1;
  const iridescence = value("iridescence") ?? sourceAdv?.iridescence?.factor ?? 0;
  const film = { ior: value("iridescenceIOR") ?? sourceAdv?.iridescence?.ior ?? 1.3,
    thickness: value("iridescenceThicknessMax") ?? sourceAdv?.iridescence?.thickness ?? 400 };
  const thickness = value("thickness") ?? sourceAdv?.volume?.thickness ?? 0;
  const attenuationColor = state.attenuationColor !== undefined ? sceneHexToLinearRgb(state.attenuationColor)
    : sourceAdv?.volume?.attenuationColor ?? sceneHexToLinearRgb(PHYSICAL_LOBE_COLOR_NEUTRAL.attenuationColor);
  const attenuationDistance = Object.hasOwn(state, "attenuationDistance") ? state.attenuationDistance
    : sourceAdv?.volume?.attenuationDistance;
  const extended: Extended | undefined = clearcoat > 0 || transmission > 0 ? {
    ior, clearcoat: { factor: clearcoat > 0 ? clearcoat : 0, roughness: clearcoat > 0 ? clearcoatRoughness : 0 },
    anisotropy: sourceExt?.anisotropy ?? { strength: 0, rotation: 0 }, transmission: { factor: transmission } } : undefined;
  const advanced: Advanced = {
    ...(sheenColor && Math.max(...sheenColor) > 0 ? { sheen: { color: sheenColor as [number, number, number], roughness: sheenRoughness } } : {}),
    ...(iridescence > 0 && film.thickness > 0 ? { iridescence: { factor: iridescence, ...film } } : {}),
    ...(transmission > 0 && thickness > 0 ? { volume: { thickness, attenuationColor: attenuationColor as [number, number, number],
      ...(attenuationDistance === undefined ? {} : { attenuationDistance }) } } : {}),
  };
  return { ...(extended ? { extended } : {}), ...(Object.keys(advanced).length ? { advanced } : {}) };
}

/** 状态里是否出现任何 lobe 字段(用于决定是否覆盖源材质的 lobe)。 */
export function stateHasPhysicalLobeFields(state: SceneMaterialState): boolean {
  return PHYSICAL_LOBE_SCALARS.some(field => Object.hasOwn(state, field.key)) || Object.hasOwn(state, "sheenColor") || Object.hasOwn(state, "attenuationColor");
}
/** 无源 lobe 的材质(基础体/铺设)套用状态里的 lobe;全中性返回原对象。同时校验字段(越界抛错带对象 id)。 */
export function withPhysicalLobes(material: Material, state: SceneMaterialState | undefined, id: string, ior: number): Material {
  if (!state || !stateHasPhysicalLobeFields(state)) return material;
  try { validatePhysicalLobePatch(state); } catch (error) { throw new Error(`对象 ${id} 的高级材质参数无效：${error instanceof Error ? error.message : String(error)}`); }
  const lobes = projectPhysicalLobes(material, state, ior);
  return { ...material, ...(lobes.extended ? { extendedParameters: lobes.extended } : {}), ...(lobes.advanced ? { advancedParameters: lobes.advanced } : {}) };
}