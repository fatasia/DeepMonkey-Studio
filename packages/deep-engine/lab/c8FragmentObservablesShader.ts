import { sha256Utf8 } from "../src/shaderPackage/hash.js";
import { sceneShader } from "../src/webgpu/pbrShader.js";

export type FragmentObservable = "geometry" | "single";
const marker = "// C8 isolated fragment observation";
const identities = {
  re: "f324431f2fd3be681d14462f021f9c1cf84b5c981c7ccd85896f5071476ab293",
  opaque: "4a436437d533d5ec900793dac710f8dad603067ebcb012fd9187441eb520284a",
  shade: "b41d2059f024b3b893cd74b3c0fa5b86ef7c23e5e0f54b325e6050e004be94c4",
} as const;
const output = "return select(color, deepApplySceneFog(select(color, baseInput, flag(materialFlags, 64u)), world, materialFlags), applyFog);";
const single = "  var color = brdfWithDielectricF0(n, view, l, base, metal, rough, dielectric) * frame.sunColor.rgb * frame.sunColor.w * visibility;";
function modeGuard(mode: FragmentObservable): void {
  if (mode !== "geometry" && mode !== "single") throw Error("Unknown fragment observable");
}

/** Isolated source output only; retains production geometry, material and light evaluation. */
export function observeDeepFragment(mode: FragmentObservable, source = sceneShader) {
  modeGuard(mode);
  if (source !== sceneShader || source.includes(marker)) throw Error("Actual production Deep source drifted or was instrumented");
  const start = source.indexOf("fn shade("), end = source.indexOf("\n}\nfn clipUv", start);
  const original = source.slice(start, end + 2);
  if (start < 0 || end < 0 || sha256Utf8(original) !== identities.shade || original.split(output).length !== 2 || original.split(single).length !== 2) throw Error("Production shade observation seam drifted");
  const observed = mode === "geometry" ? "vec3f(clamp(dot(n, view), 0.0001, 1.0), clamp(dot(n, l), 0.0, 1.0), rough)" : "deepObservedSingle";
  const instrumented = original.replace(single, `${single}\n  let deepObservedSingle = color;`)
    .replace(output, `return ${observed};`);
  const code = `${marker}\n${source.slice(0, start)}${instrumented}${source.slice(end + 2)}`;
  return { code, originalHash: sha256Utf8(source), instrumentedHash: sha256Utf8(code), mode };
}

export function observeThreeFragment(mode: FragmentObservable, source: { readonly lights_physical_pars_fragment: string; readonly opaque_fragment: string }) {
  modeGuard(mode);
  const original = source.lights_physical_pars_fragment, matches = [...original.matchAll(/^void RE_Direct_Physical\([^]*?^\}/gm)], re = matches[0]?.[0];
  if (original.includes(marker) || matches.length !== 1 || !re || sha256Utf8(re) !== identities.re || sha256Utf8(source.opaque_fragment) !== identities.opaque) throw Error("Actual Three observation seam drifted or was instrumented");
  const expression = mode === "geometry"
    ? "vec3( saturate( dot( geometryNormal, geometryViewDir ) ), saturate( dot( geometryNormal, directLight.direction ) ), material.roughness )"
    : "irradiance * ( BRDF_GGX( directLight.direction, geometryViewDir, geometryNormal, material ) + BRDF_Lambert( material.diffuseContribution ) )";
  const pars = `${marker}\nvec3 deepObservedFragment = vec3( 0.0 );\n${original.replace(re, `${re.slice(0, -1)}\n\tdeepObservedFragment = ${expression};\n}`)}`;
  const opaque = source.opaque_fragment.replace("vec4( outgoingLight, diffuseColor.a )", "vec4( deepObservedFragment, diffuseColor.a )");
  return { lights_physical_pars_fragment: pars, opaque_fragment: opaque,
    originalHash: sha256Utf8(original + source.opaque_fragment), instrumentedHash: sha256Utf8(pars + opaque), mode };
}
