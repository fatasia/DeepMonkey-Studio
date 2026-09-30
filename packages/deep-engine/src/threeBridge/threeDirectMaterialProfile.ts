import { PBR_BRDF_DIRECT_LIGHTING_WGSL as canonical } from "../lighting/brdfDirectLightingWgsl.js";
import { PBR_DIRECT_DISPLAY_BODY_WGSL as direct } from "../webgpu/pbrDirectDisplayBodyWgsl.js";
import { sha256Utf8 } from "../shaderPackage/hash.js";

export type ThreeDirectMaterialProfile = "three-r185" | "single-scatter" | "world-normal-single-scatter" | "deep-single-scatter";
export interface ThreeDirectMaterialChunks { readonly lights_physical_pars_fragment: string; readonly lights_physical_fragment: string }
const identities = { D_GGX: "ccb142af2fbd22c61433902f3be5f675be848fc5dbf0db78acbba78b28d771c9",
  BRDF_GGX: "ba1ddd0747d8108aa9c395b6a2d74d9d6abf865c31c177b153589803c9383bd8",
  RE_Direct_Physical: "f324431f2fd3be681d14462f021f9c1cf84b5c981c7ccd85896f5071476ab293" } as const;
const marker = "// C8 explicit direct material profile:";
function definition(source: string, name: keyof typeof identities): { source: string; pattern: RegExp } {
  const pattern = new RegExp(`^(?:float|vec3|void) ${name}\\([^]*?^\\}`, "gm"), matches = [...source.matchAll(pattern)];
  if (matches.length !== 1 || sha256Utf8(matches[0]![0]) !== identities[name]) throw Error(`Three direct material ${name} source drifted`);
  return { source: matches[0]![0], pattern };
}

/** Explicit host policy; callers retain Three r185 unless they opt in. */
export function threeDirectMaterialProfile(chunks: ThreeDirectMaterialChunks, profile: ThreeDirectMaterialProfile = "three-r185"): ThreeDirectMaterialChunks {
  if (!["three-r185", "single-scatter", "world-normal-single-scatter", "deep-single-scatter"].includes(profile)) throw Error("Unknown Three direct material profile");
  if (profile === "three-r185") return chunks;
  const pars = chunks.lights_physical_pars_fragment, fragment = chunks.lights_physical_fragment;
  if (pars.includes(marker) || sha256Utf8(fragment) !== "ff8ddc3b4509c5ea976a57b80a7c1c3397a42241b945e4caadca6c69f2bbce7d") throw Error("Three direct material source drifted or was already adapted");
  const d = definition(pars, "D_GGX"), brdf = definition(pars, "BRDF_GGX"), re = definition(pars, "RE_Direct_Physical");
  let adapted = pars.replace(re.pattern, re.source.replace("irradiance * BRDF_GGX_Multiscatter(", "irradiance * BRDF_GGX("));
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
