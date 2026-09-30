import { PBR_BRDF_DIRECT_LIGHTING_WGSL } from "../lighting/brdfDirectLightingWgsl.js";
import { sha256Utf8 } from "../shaderPackage/hash.js";

const identity = "915630280aad91faa1e49050dbae9564538df2f4dd883d0c2f159c3bd6ff4d27";
let cached: Readonly<{ wgsl: string; glsl: string; sourceHash: string }> | undefined;

/** Shared correlated Smith statements; preserve multiplication and parentheses. */
export function ggxVisibilityLibrary(source = PBR_BRDF_DIRECT_LIGHTING_WGSL) {
  if (source === PBR_BRDF_DIRECT_LIGHTING_WGSL && cached) return cached;
  const matches = [...source.matchAll(/^  let gv =[^]*?^  let visibility =[^;]+;/gm)];
  const statements = matches[0]?.[0];
  if (matches.length !== 1 || !statements || sha256Utf8(statements) !== identity) throw Error("Canonical GGX visibility source changed");
  const library = Object.freeze({
    wgsl: `fn deepSharedGgxVisibility(a2: f32, nv: f32, nl: f32) -> f32 {\n${statements}\n  return visibility;\n}`,
    glsl: `float deepSharedGgxVisibility( float a2, float nv, float nl ) {\n${statements.replaceAll("let ", "float ")}\n  return visibility;\n}`,
    sourceHash: identity,
  });
  if (source === PBR_BRDF_DIRECT_LIGHTING_WGSL) cached = library;
  return library;
}
