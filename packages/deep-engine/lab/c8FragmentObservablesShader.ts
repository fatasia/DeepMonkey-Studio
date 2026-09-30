import { sha256Utf8 } from "../src/shaderPackage/hash.js";
import { sceneShader } from "../src/webgpu/pbrShader.js";

export type FragmentObservable = "geometry" | "single" | "rough-single" | "view-normal" | "abs-dx" | "abs-dy";
export type FragmentDerivative = "fine" | "coarse";
const marker = "// C8 isolated fragment observation";
const identities = {
  re: "f324431f2fd3be681d14462f021f9c1cf84b5c981c7ccd85896f5071476ab293",
  opaque: "4a436437d533d5ec900793dac710f8dad603067ebcb012fd9187441eb520284a",
  shade: "b41d2059f024b3b893cd74b3c0fa5b86ef7c23e5e0f54b325e6050e004be94c4",
  physical: "ff8ddc3b4509c5ea976a57b80a7c1c3397a42241b945e4caadca6c69f2bbce7d",
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
  const singleExpression = "irradiance * ( BRDF_GGX( directLight.direction, geometryViewDir, geometryNormal, material ) + BRDF_Lambert( material.diffuseContribution ) )";
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
