import type { DeepWgslModuleDescriptor } from "../shader/types.js";
import { exactlyOnce } from "./packageAdapterWgslContract.js";

export interface ClearcoatReferenceInput {
  readonly factor: number;
  readonly roughness: number;
  readonly nDotL: number;
  readonly nDotV: number;
  readonly nDotH: number;
  readonly vDotH: number;
  readonly dfg: readonly [number, number];
}

export interface ClearcoatReferenceResult {
  readonly directBaseAttenuation: number;
  readonly directLobe: number;
  readonly iblBaseAttenuation: number;
  readonly iblLobe: number;
}

const PI = Math.PI;
const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));
const fresnel = (cosine: number): number => 0.04 + 0.96 * (1 - cosine) ** 5;
function distribution(nDotH: number, roughness: number): number {
  const alpha = roughness * roughness, alpha2 = alpha * alpha;
  const denominator = nDotH * nDotH * (alpha2 - 1) + 1;
  return alpha2 / Math.max(PI * denominator * denominator, 0.000001);
}
function geometry(nDotX: number, roughness: number): number {
  const k = (roughness + 1) ** 2 / 8;
  return nDotX / Math.max(nDotX * (1 - k) + k, 0.0001);
}

/** CPU reference for the exact scalar layering factors emitted into WGSL. */
export function evaluateClearcoatReference(input: ClearcoatReferenceInput): ClearcoatReferenceResult {
  const values = [input.factor, input.roughness, input.nDotL, input.nDotV,
    input.nDotH, input.vDotH, ...input.dfg];
  if (values.some((value) => !Number.isFinite(value)) || input.factor < 0 || input.factor > 1
    || input.roughness < 0 || input.roughness > 1) throw new RangeError("Clearcoat reference input is invalid.");
  const factor = input.factor, roughness = clamp(input.roughness, 0.045, 1);
  const nDotL = clamp(input.nDotL, 0, 1), nDotV = clamp(input.nDotV, 0.0001, 1);
  const directFresnel = fresnel(clamp(input.vDotH, 0, 1));
  const directSpecular = distribution(clamp(input.nDotH, 0, 1), roughness)
    * geometry(nDotV, roughness) * geometry(nDotL, roughness) * directFresnel
    / Math.max(4 * nDotV * nDotL, 0.0001);
  const viewFresnel = fresnel(nDotV);
  const dfgSum = Math.max(input.dfg[0] + input.dfg[1], 0.05);
  const energyCompensation = 1 + 0.04 * (1 / dfgSum - 1);
  return Object.freeze({
    directBaseAttenuation: 1 - factor * directFresnel,
    directLobe: factor * directSpecular,
    iblBaseAttenuation: 1 - factor * viewFresnel,
    iblLobe: factor * (0.04 * input.dfg[0] + input.dfg[1]) * energyCompensation,
  });
}

function wgslFloat(value: number): string {
  const result = Math.fround(value).toString();
  return /[.eE]/u.test(result) ? result : `${result}.0`;
}

/** Adds a compile-time v3 clearcoat layer without changing the v1/v2 shader source. */
export function adaptClearcoatWgsl(
  module: DeepWgslModuleDescriptor,
  factor: number,
  roughness: number,
): DeepWgslModuleDescriptor | undefined {
  if (![factor, roughness].every(Number.isFinite) || factor < 0 || factor > 1 || roughness < 0 || roughness > 1) return undefined;
  if (factor === 0) return module;
  const direct = "  let direct = (diffuse + specular) * directRadiance * nDotL * shadow;";
  const indirectSpecular = "  let indirectSpecular = radiance * (f0 * dfg.x + dfg.y) * energyCompensation;";
  const color = "  let color = direct + (indirectDiffuse + indirectSpecular) * occlusion + emission;";
  if (![direct, indirectSpecular, color].every((token) => exactlyOnce(module.code, token))) return undefined;
  const directLayer = [
    `  let deepClearcoatFactor = ${wgslFloat(factor)};`,
    `  let deepClearcoatRoughness = clamp(${wgslFloat(roughness)}, 0.045, 1.0);`,
    "  let deepClearcoatDirectFresnel = 0.04 + 0.96 * pow(1.0 - vDotH, 5.0);",
    "  let deepClearcoatDistribution = deepDistributionGgx(nDotH, deepClearcoatRoughness);",
    "  let deepClearcoatGeometry = deepGeometrySchlickGgx(nDotV, deepClearcoatRoughness)",
    "    * deepGeometrySchlickGgx(nDotL, deepClearcoatRoughness);",
    "  let deepClearcoatDirectSpecular = deepClearcoatDistribution * deepClearcoatGeometry",
    "    * deepClearcoatDirectFresnel / max(4.0 * nDotV * nDotL, 0.0001);",
    "  let deepClearcoatDirectAttenuation = 1.0 - deepClearcoatFactor * deepClearcoatDirectFresnel;",
    "  let direct = ((diffuse + specular) * deepClearcoatDirectAttenuation",
    "    + vec3f(deepClearcoatFactor * deepClearcoatDirectSpecular)) * directRadiance * nDotL * shadow;",
  ].join("\n");
  const iblLayer = [
    indirectSpecular,
    "  let deepClearcoatViewFresnel = 0.04 + 0.96 * pow(1.0 - nDotV, 5.0);",
    "  let deepClearcoatRadiance = textureSampleLevel(deepSpecularEnvironment, deepEnvironmentSampler,",
    "    reflection, deepClearcoatRoughness * maxSpecularLod).rgb;",
    "  let deepClearcoatDfg = textureSampleLevel(deepBrdfLut, deepEnvironmentSampler,",
    "    vec2f(nDotV, deepClearcoatRoughness), 0.0).rg;",
    "  let deepClearcoatEnergy = 1.0 + 0.04 * (1.0 / max(deepClearcoatDfg.x + deepClearcoatDfg.y, 0.05) - 1.0);",
    "  let deepClearcoatIndirect = deepClearcoatRadiance",
    "    * (0.04 * deepClearcoatDfg.x + deepClearcoatDfg.y) * deepClearcoatEnergy;",
  ].join("\n");
  const layeredColor = [
    "  let deepClearcoatIndirectAttenuation = 1.0 - deepClearcoatFactor * deepClearcoatViewFresnel;",
    "  let deepLayeredIndirect = (indirectDiffuse + indirectSpecular) * deepClearcoatIndirectAttenuation",
    "    + deepClearcoatIndirect * deepClearcoatFactor;",
    "  let color = direct + deepLayeredIndirect * occlusion + emission;",
  ].join("\n");
  return Object.freeze({ label: `${module.label}/clearcoat`,
    code: module.code.replace(direct, directLayer).replace(indirectSpecular, iblLayer).replace(color, layeredColor) });
}
