import { sha256Utf8 } from "../src/shaderPackage/hash.js";
import { sceneShader } from "../src/webgpu/pbrShader.js";

export type FragmentObservable = "geometry" | "single" | "rough-single" | "view-normal" | "abs-dx" | "abs-dy";
export type FragmentDerivative = "fine" | "coarse";
const marker = "// C8 isolated fragment observation";
const identities = {
  // Installed Three r186: observe the original direct operands before MS
  // compensation, including its Fresnel diffuse-layer energy partition.
  re: "3ebb322a2828f548c1efed4aebaff6046dbada7f02128426e727be7edb6757c0",
  opaque: "4a436437d533d5ec900793dac710f8dad603067ebcb012fd9187441eb520284a",
  // Current production shade with normalized input; the full body
  // remains pinned so changes cannot silently bypass this observation seam.
  // F5 方案 A:L1 方向可见度门接入镜面项(用户批准),观察缝 pin 随生产源演进重锚。
  // SDK default gain is one; only the probe irradiance branch uses constant.w.
  shade: "202af7f921182e6a096343e4697b78c0b6f0bd32fbc389f603debdb406815660",
  physical: "e07d77d6c3e84538fe206c1cee3c4ce1dd62b9fe3f0355f9ec8511e103f99f37",
} as const;
const output = "return select(color, deepApplySceneFog(select(color, baseInput, flag(materialFlags, 64u)), world, materialFlags), applyFog);";
const single = "  var color = brdfWithDielectricF0(n, view, l, base, metal, rough, dielectric) * frame.sunColor.rgb * frame.sunColor.w * visibility;";
function modeGuard(mode: FragmentObservable): void {
  if (!["geometry", "single", "rough-single", "view-normal", "abs-dx", "abs-dy"].includes(mode)) throw Error("Unknown fragment observable");
}
const vectorMode = (mode: FragmentObservable) => mode === "view-normal" || mode === "abs-dx" || mode === "abs-dy";

/** Isolated source output only; retains production geometry, material and light evaluation. */
export function observeDeepFragment(mode: FragmentObservable, source = sceneShader, derivative?: FragmentDerivative) {
  modeGuard(mode);
  if (derivative !== undefined && derivative !== "fine" && derivative !== "coarse") throw Error("Unknown fragment derivative candidate");
  if (vectorMode(mode) && derivative !== undefined) throw Error("Derivative vector observations require actual default operators");
  if (source !== sceneShader || source.includes(marker)) throw Error("Actual production Deep source drifted or was instrumented");
  const start = source.indexOf("fn shade("), end = source.indexOf("\n}\nfn clipUv", start);
  const original = source.slice(start, end + 2);
  if (start < 0 || end < 0 || sha256Utf8(original) !== identities.shade || original.split(output).length !== 2 || original.split(single).length !== 2) throw Error("Production shade observation seam drifted");
  const vector = mode === "view-normal" ? "deepObservedNormal * 0.5 + 0.5" : mode === "abs-dx" ? "deepObservedDx" : "deepObservedDy";
  const observed = vectorMode(mode) ? vector : mode === "geometry" ? "vec3f(clamp(dot(n, view), 0.0001, 1.0), clamp(dot(n, l), 0.0, 1.0), rough)" : mode === "rough-single" ? "vec3f(rough, deepObservedSingle.rg)" : "deepObservedSingle";
  const instrumented = original.replace(single, `${single}\n  let deepObservedSingle = color;`)
    .replace(output, `return ${observed};`);
  let code = `${marker}\n${source.slice(0, start)}${instrumented}${source.slice(end + 2)}`;
  if (vectorMode(mode)) {
    const seam = "let derivative = max(abs(dpdx(normal)), abs(dpdy(normal)));";
    if (code.split(seam).length !== 2) throw Error("Canonical geometry derivative seam drifted");
    code = `var<private> deepObservedNormal: vec3f;\nvar<private> deepObservedDx: vec3f;\nvar<private> deepObservedDy: vec3f;\n${code}`
      .replace(seam, "deepObservedNormal = normal;\n  deepObservedDx = abs(dpdx(normal));\n  deepObservedDy = abs(dpdy(normal));\n  let derivative = max(deepObservedDx, deepObservedDy);");
  }
  if (derivative) {
    const seam = "let derivative = max(abs(dpdx(normal)), abs(dpdy(normal)));";
    if (code.split(seam).length !== 2) throw Error("Canonical geometry derivative seam drifted");
    const suffix = derivative === "fine" ? "Fine" : "Coarse";
    code = code.replace(seam, `let derivative = max(abs(dpdx${suffix}(normal)), abs(dpdy${suffix}(normal)));`);
  }
  return { code, originalHash: sha256Utf8(source), instrumentedHash: sha256Utf8(code), mode };
}

export function observeThreeFragment(mode: FragmentObservable, source: { readonly lights_physical_pars_fragment: string; readonly opaque_fragment: string; readonly lights_physical_fragment?: string }) {
  modeGuard(mode);
  const original = source.lights_physical_pars_fragment, matches = [...original.matchAll(/^void RE_Direct_Physical\([^]*?^\}/gm)], re = matches[0]?.[0];
  if (original.includes(marker) || matches.length !== 1 || !re || sha256Utf8(re) !== identities.re || sha256Utf8(source.opaque_fragment) !== identities.opaque) throw Error("Actual Three observation seam drifted or was instrumented");
  const singleExpression = "irradiance * ( specularBRDF + BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F ) )";
  const expression = mode === "geometry"
    ? "vec3( saturate( dot( geometryNormal, geometryViewDir ) ), saturate( dot( geometryNormal, directLight.direction ) ), material.roughness )"
    : mode === "rough-single" ? `vec3( material.roughness, ( ${singleExpression} ).rg )` : singleExpression;
  const pars = `${marker}\nvec3 deepObservedFragment = vec3( 0.0 );\n${vectorMode(mode) ? original : original.replace(re, `${re.slice(0, -1)}\n\tdeepObservedFragment = ${expression};\n}`)}`;
  const opaque = source.opaque_fragment.replace("vec4( outgoingLight, diffuseColor.a )", "vec4( deepObservedFragment, diffuseColor.a )");
  let physical: string | undefined;
  if (vectorMode(mode)) {
    const seam = "vec3 dxy = max( abs( dFdx( nonPerturbedNormal ) ), abs( dFdy( nonPerturbedNormal ) ) );", input = source.lights_physical_fragment;
    if (!input || sha256Utf8(input) !== identities.physical || input.split(seam).length !== 2) throw Error("Actual Three geometry derivative seam drifted");
    const vector = mode === "view-normal" ? "nonPerturbedNormal * 0.5 + 0.5" : mode === "abs-dx" ? "deepObservedDx" : "deepObservedDy";
    physical = input.replace(seam, `vec3 deepObservedDx = abs( dFdx( nonPerturbedNormal ) );\nvec3 deepObservedDy = abs( dFdy( nonPerturbedNormal ) );\nvec3 dxy = max( deepObservedDx, deepObservedDy );\ndeepObservedFragment = ${vector};`);
  }
  return { lights_physical_pars_fragment: pars, opaque_fragment: opaque,
    ...(physical ? { lights_physical_fragment: physical } : {}),
    originalHash: sha256Utf8(original + source.opaque_fragment + (physical ? source.lights_physical_fragment : "")), instrumentedHash: sha256Utf8(pars + opaque + (physical ?? "")), mode };
}
