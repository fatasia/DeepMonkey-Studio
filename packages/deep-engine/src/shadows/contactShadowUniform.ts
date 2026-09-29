import { CONTACT_SHADOW_UNIFORM_BYTES } from "./contactShadowWgsl.js";
import type { ContactShadowQualityTier } from "./contactShadowQuality.js";
import type { ShadowVec3 } from "./types.js";

/** extent → 步进半径/厚度(radius 按 tier 分档,与 AO radius 同派生纪律)。 */
export function contactShadowSceneParameters(extent: number, tier: ContactShadowQualityTier):
  Readonly<{ radius: number; thickness: number }> {
  if (!Number.isFinite(extent) || extent <= 0) throw new RangeError("Contact shadow extent must be positive.");
  const radiusScale = tier === "quality" ? 0.05 : tier === "balanced" ? 0.035 : 0.025;
  return { radius: Math.max(0.05, Math.min(8, extent * radiusScale)),
    thickness: Math.max(0.005, Math.min(2, extent * 0.004)) };
}

/** 世界光行进方向 → 视空间表面指向光源单位向量(方向变换,平移不参与)。 */
export function surfaceToLightView(rayDirectionWorld: ShadowVec3,
  worldToView: readonly number[]): readonly [number, number, number] {
  const world = [-rayDirectionWorld[0]!, -rayDirectionWorld[1]!, -rayDirectionWorld[2]!];
  const x = worldToView[0]! * world[0]! + worldToView[4]! * world[1]! + worldToView[8]! * world[2]!;
  const y = worldToView[1]! * world[0]! + worldToView[5]! * world[1]! + worldToView[9]! * world[2]!;
  const z = worldToView[2]! * world[0]! + worldToView[6]! * world[1]! + worldToView[10]! * world[2]!;
  const length = Math.hypot(x, y, z);
  if (!(length > 0)) throw new RangeError("Contact shadow light direction must be nonzero.");
  return [x / length, y / length, z / length];
}

/** uniform 打包单源(与 CONTACT_SHADOW_WGSL 的 ContactParams 逐 float 对应,单测钉死)。 */
export function packContactShadowUniform(input: {
  readonly projection: Float32Array<ArrayBuffer>;
  readonly lightView: readonly [number, number, number, number];
  readonly thickness: number; readonly strength: number; readonly falloff: number; readonly radius: number;
  readonly width: number; readonly height: number;
}): Float32Array<ArrayBuffer> {
  if (input.projection.length !== 16) throw new RangeError("Contact shadow projection must have 16 floats.");
  const data = new Float32Array(new ArrayBuffer(CONTACT_SHADOW_UNIFORM_BYTES));
  data.set(input.projection, 0);
  data.set([input.lightView[0], input.lightView[1], input.lightView[2], input.lightView[3]], 16);
  data.set([input.thickness, input.strength, input.falloff, input.radius], 20);
  data.set([input.width, input.height, Math.ceil(input.width / 2), Math.ceil(input.height / 2)], 24);
  return data;
}
