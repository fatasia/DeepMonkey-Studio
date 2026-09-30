import { ggxVisibilityLibrary } from "../shader/ggxVisibilityGlsl.js";
import { sha256Utf8 } from "../shaderPackage/hash.js";

const marker = "// C8 paired correlated Smith visibility";
const definition = /^float V_GGX_SmithCorrelated\([^]*?^\}/gm;
const identity = "ebf0767138a484c2827aec86667923a5b0154eab8b89ec323ca81de095e11e45";

export function threeGgxVisibilityShader(source: string): string {
  const matches = [...source.matchAll(definition)], original = matches[0]?.[0];
  if (source.includes(marker) || matches.length !== 1 || !original || sha256Utf8(original) !== identity) {
    throw Error("Three GGX visibility source changed or was already adapted");
  }
  return source.replace(definition, `${marker}\n${ggxVisibilityLibrary().glsl}\nfloat V_GGX_SmithCorrelated( const in float alpha, const in float dotNL, const in float dotNV ) {\n\tfloat a2 = pow2( alpha );\n\treturn deepSharedGgxVisibility( a2, dotNV, dotNL );\n}`);
}
