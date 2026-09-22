import type { SceneMaterialState } from "@bim-studio/contracts";

/** Empty URLs mean source textures, not absent textures; runtime retains original samplers and UVs. */
export function sourceTexturePatch(): SceneMaterialState {
  return {
    baseColorMapUrl: "", baseColorMapName: "", normalMapUrl: "", normalMapName: "",
    emissiveMapUrl: "", emissiveMapName: "", ambientOcclusionMapUrl: "", ambientOcclusionMapName: "",
    roughnessMapUrl: "", roughnessMapName: "", metalnessMapUrl: "", metalnessMapName: "",
    textureRepeat: 1, textureRepeatX: 1, textureRepeatY: 1,
    textureOffsetX: 0, textureOffsetY: 0, textureRotation: 0,
    uvAnimation: { enabled: false, offsetSpeedX: 0, offsetSpeedY: 0, rotationSpeed: 0 },
  };
}
export function sourceMaterialPatch(source: SceneMaterialState): SceneMaterialState {
  return { ...source, ...sourceTexturePatch(), sourceColor: true, sourceEmissive: true, shaderEffect: undefined,
    screen: { enabled: false, sourceType: "image", url: "", autoplay: false, loopMode: "once", muted: true, emissiveIntensity: 1 } };
}
