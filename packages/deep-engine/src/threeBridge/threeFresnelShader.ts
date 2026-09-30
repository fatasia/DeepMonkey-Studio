import { schlickFactorGlsl } from "../shader/schlickFactorGlsl.js";
import { sha256Utf8 } from "../shaderPackage/hash.js";

const marker = "// C8 paired material Fresnel factor";
const functions = /^(vec3|float) F_Schlick\([^]*?^\}/gm;
const identities: Record<string, string> = {
  vec3: "b3b76923a3129798a005a73a240c52744b37021a9cfd99b08cebae225b0181f4",
  float: "913933a3368f5385c44ace54bc5187f79e742147e05cc33b7f33cb3bec6f6398",
};

/** Preserve Three F0/F90 mixing, roughness and BRDF host semantics. */
export function threeFresnelShader(source: string): string {
  const matches = [...source.matchAll(functions)];
  if (source.includes(marker) || matches.length !== 2
    || new Set(matches.map(match => match[1])).size !== 2
    || matches.some(match => sha256Utf8(match[0]) !== identities[match[1]!])) {
    throw Error("Three material Fresnel source changed or was already adapted");
  }
  let first = true;
  return source.replace(functions, definition => {
    const prefix = first ? `${marker}\n${schlickFactorGlsl()}\n` : ""; first = false;
    return prefix + definition.replace(/float fresnel = exp2\([^;]+\);/, "float fresnel = deepSharedSchlickFactor( dotVH );");
  });
}
