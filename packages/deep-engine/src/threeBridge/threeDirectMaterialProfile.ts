import { PBR_BRDF_DIRECT_LIGHTING_WGSL as canonical } from "../lighting/brdfDirectLightingWgsl.js";
import { PBR_DIRECT_DISPLAY_BODY_WGSL as direct } from "../webgpu/pbrDirectDisplayBodyWgsl.js";
import { sha256Utf8 } from "../shaderPackage/hash.js";

/** Explicit host policy; "three-r185" 为历史命名的「three 上游原样」档位(升级不追改 id)。callers retain Three stock unless they opt in. */
export type ThreeDirectMaterialProfile = "three-r185" | "single-scatter" | "world-normal-single-scatter" | "deep-single-scatter";
export interface ThreeDirectMaterialChunks { readonly lights_physical_pars_fragment: string; readonly lights_physical_fragment: string }
// r186(#33983/#33985)重做直接光多散射:移除 BRDF_GGX_Multiscatter,补偿移入 material.multiScatteringCompensation;
// D_GGX/BRDF_GGX 哈希未变(threeGgxVisibilityShader 整函数重写,与上游漂移无关),仅 RE_Direct_Physical 与 fragment 漂移
const identities = { D_GGX: "ccb142af2fbd22c61433902f3be5f675be848fc5dbf0db78acbba78b28d771c9",
  BRDF_GGX: "ba1ddd0747d8108aa9c395b6a2d74d9d6abf865c31c177b153589803c9383bd8",
  RE_Direct_Physical: "3ebb322a2828f548c1efed4aebaff6046dbada7f02128426e727be7edb6757c0" } as const;
const marker = "// C8 explicit direct material profile:";
function definition(source: string, name: keyof typeof identities): { source: string; pattern: RegExp } {
  const pattern = new RegExp(`^(?:float|vec3|void) ${name}\\([^]*?^\\}`, "gm"), matches = [...source.matchAll(pattern)];
  if (matches.length !== 1 || sha256Utf8(matches[0]![0]) !== identities[name]) throw Error(`Three direct material ${name} source drifted`);
  return { source: matches[0]![0], pattern };
}

/** 应用 host 直接光材质策略;默认档为 three 上游原样(档位命名见类型注释)。 */
export function threeDirectMaterialProfile(chunks: ThreeDirectMaterialChunks, profile: ThreeDirectMaterialProfile = "three-r185"): ThreeDirectMaterialChunks {
  if (!["three-r185", "single-scatter", "world-normal-single-scatter", "deep-single-scatter"].includes(profile)) throw Error("Unknown Three direct material profile");
  if (profile === "three-r185") return chunks;
  const pars = chunks.lights_physical_pars_fragment, fragment = chunks.lights_physical_fragment;
  if (pars.includes(marker) || sha256Utf8(fragment) !== "e07d77d6c3e84538fe206c1cee3c4ce1dd62b9fe3f0355f9ec8511e103f99f37") throw Error("Three direct material source drifted or was already adapted");
  const d = definition(pars, "D_GGX"), brdf = definition(pars, "BRDF_GGX"), re = definition(pars, "RE_Direct_Physical");
  // r186 单散射策略等价改法:上游默认 BRDF_GGX × multiScatteringCompensation,策略 = 剥离补偿因子(与 r185 换掉 Multiscatter 同义)
  let adapted = pars.replace(re.pattern, re.source.replace("irradiance * specularBRDF * material.multiScatteringCompensation;", "irradiance * specularBRDF;"));
  let surface = fragment;
  if (profile !== "single-scatter") {
    surface = surface.replace("vec3 dxy = max( abs( dFdx( nonPerturbedNormal ) ), abs( dFdy( nonPerturbedNormal ) ) );",
      "vec3 deepGeometryNormal = inverseTransformDirection( nonPerturbedNormal, viewMatrix );\nvec3 dxy = max( abs( dFdx( deepGeometryNormal ) ), abs( dFdy( deepGeometryNormal ) ) );");
  }
  if (profile === "deep-single-scatter") {
    if (sha256Utf8(canonical) !== "af415d45995fdb86f456cbf26dd8f550cfe9ea2dadf2637ff601e9a775d712c7") throw Error("Canonical direct BRDF identity changed");
    const distribution = canonical.match(/let distribution = ([^;]+);/)?.[1];
    const nv = canonical.match(/let nv = clamp\(dot\(n, v\), ([^,]+), ([^)]+)\)/);
    const floors = [...direct.matchAll(/clamp\((?:roughInput|v\.material\.x), ([^,]+), 1\.0\)/g)].map(match => match[1]);
    if (!distribution || !nv || floors.length !== 3 || new Set(floors).size !== 1) throw Error("Canonical direct material extraction failed");
    adapted = adapted.replace(d.pattern, d.source.replace("return RECIPROCAL_PI * a2 / pow2( denom );", `return ${distribution};`));
    adapted = adapted.replace(brdf.pattern, brdf.source.replace("float dotNV = saturate( dot( normal, viewDir ) );", `float dotNV = clamp( dot( normal, viewDir ), ${nv[1]}, ${nv[2]} );`));
    surface = surface.replace("max( roughnessFactor, 0.0525 )", `max( roughnessFactor, ${floors[0]} )`);
  }
  return { lights_physical_pars_fragment: `${marker} ${profile}\n${adapted}`, lights_physical_fragment: surface };
}
