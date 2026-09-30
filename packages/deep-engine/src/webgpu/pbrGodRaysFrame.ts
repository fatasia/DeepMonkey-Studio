import type { PbrPrimaryDirectionalLight } from "../lighting/pbrSceneLighting.js";
import { transformWorldLightsToView } from "../lighting/worldLights.js";
import { invertMat4 } from "./visibilityBufferEncoding.js";
import type { VolumetricFogLight } from "../fog/volumetricFogPassTypes.js";

/** Evaluated only while author light shafts are enabled. Reuses the surface light's exact frame. */
export function pbrGodRaysFrame(primary: PbrPrimaryDirectionalLight, worldToView: Float32Array): {
  readonly viewToWorld: Float32Array<ArrayBuffer>; readonly light: VolumetricFogLight;
} {
  const direction = transformWorldLightsToView({ directional: [{ directionWorld: primary.rayDirectionWorld,
    color: primary.color, intensity: primary.intensity }] }, worldToView).directional![0]!.directionView;
  return { viewToWorld: invertMat4(worldToView), light: { direction,
    radiance: primary.color.map(value => value * primary.intensity) as unknown as VolumetricFogLight["radiance"] } };
}
