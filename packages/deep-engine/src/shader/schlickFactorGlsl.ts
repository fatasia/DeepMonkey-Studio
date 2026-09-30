import { PBR_BRDF_DIRECT_LIGHTING_WGSL } from "../lighting/brdfDirectLightingWgsl.js";
import { sha256Utf8 } from "../shaderPackage/hash.js";

const canonicalFunctionHash = "a0ad3deabcd1d7bc9ac57e920bdb7e90fac233b6035aa482ed67a5b5e24db190";
let cached: string | undefined;

/** The existing scalar expression has identical WGSL/GLSL syntax; no second formula. */
export function schlickFactorGlsl(source = PBR_BRDF_DIRECT_LIGHTING_WGSL): string {
  if (source === PBR_BRDF_DIRECT_LIGHTING_WGSL && cached !== undefined) return cached;
  const functions = [...source.matchAll(/^fn fresnel\([^]*?^\}/gm)];
  const definition = functions[0]?.[0];
  if (functions.length !== 1 || !definition || sha256Utf8(definition) !== canonicalFunctionHash) {
    throw Error("Canonical direct Fresnel source changed");
  }
  const expression = definition.match(/^  let factor = (exp2\([^;\n]+\));$/m)?.[1];
  if (!expression) throw Error("Canonical direct Fresnel factor boundary changed");
  const result = `float deepSharedSchlickFactor( float cosine ) {\n\treturn ${expression};\n}`;
  if (source === PBR_BRDF_DIRECT_LIGHTING_WGSL) cached = result;
  return result;
}
