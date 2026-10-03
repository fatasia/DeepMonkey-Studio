import { sha256Utf8 } from "../src/shaderPackage/hash.js";
import { observeDeepFragment, type FragmentObservable } from "./c8FragmentObservablesShader.js";

type Vector = readonly [number, number, number];
/** CPU plane model. Inputs are affine perspective numerators, not unit normals. */
export function explicitPlaneDerivatives(numerator: Vector, dx: Vector, dy: Vector, pixel: readonly [number, number]) {
  if (![...numerator, ...dx, ...dy, ...pixel].every(Number.isFinite)) throw Error("Non-finite explicit plane input");
  const offset = pixel.map(v => -(Math.floor(v) % 2));
  const at = (x: number, y: number) => {
    const n = numerator.map((v, i) => v + dx[i]! * x + dy[i]! * y);
    const length = Math.hypot(...n);
    if (length <= 1e-8) throw Error("Degenerate explicit plane normal");
    return n.map(v => v / length);
  };
  const corners = [at(offset[0]!, offset[1]!), at(offset[0]! + 1, offset[1]!),
    at(offset[0]!, offset[1]! + 1), at(offset[0]! + 1, offset[1]! + 1)];
  const delta = (a: number[], b: number[]) => a.map((v, i) => Math.abs(v - b[i]!));
  return { corners, dx: delta(corners[2]!, corners[3]!), dy: delta(corners[0]!, corners[2]!) };
}

// Diagnostic convention: bottom row for dx, left column for dy. This is the
// observed current Three/backend stencil, not a WGSL or all-device guarantee.
export const EXPLICIT_DERIVATIVE_WGSL = /* wgsl */ `
var<private> deepC8ExplicitDx: vec3f;
var<private> deepC8ExplicitDy: vec3f;
fn deepC8SeedExplicitDerivative(rawWorldNormal: vec3f, rasterPosition: vec4f) {
  let numerator = (frame.worldToView * vec4f(rawWorldNormal, 0.0)).xyz * rasterPosition.w;
  let x = dpdxFine(numerator);
  let y = dpdyFine(numerator);
  let parity = vec2f(vec2u(floor(rasterPosition.xy)) & vec2u(1u));
  let origin = numerator - parity.x * x - parity.y * y;
  let topLeft = safeNormalize(origin, vec3f(0.0, 0.0, 1.0));
  let bottomLeft = safeNormalize(origin + y, vec3f(0.0, 0.0, 1.0));
  let bottomRight = safeNormalize(origin + x + y, vec3f(0.0, 0.0, 1.0));
  deepC8ExplicitDx = abs(bottomRight - bottomLeft);
  deepC8ExplicitDy = abs(bottomLeft - topLeft);
}
`;

/** Isolated source candidate; reuses the existing full production/hash guard. */
export function observeDeepExplicitDerivative(mode: FragmentObservable) {
  const baseline = observeDeepFragment(mode);
  let code = baseline.code;
  const vector = ["view-normal", "abs-dx", "abs-dy"].includes(mode);
  const seam = vector
    ? "deepObservedDx = abs(dpdx(normal));\n  deepObservedDy = abs(dpdy(normal));"
    : "let derivative = max(abs(dpdx(normal)), abs(dpdy(normal)));";
  if (code.split(seam).length !== 2) throw Error("Explicit derivative observation seam drifted");
  code = code.replace(seam, vector
    ? "deepObservedDx = deepC8ExplicitDx;\n  deepObservedDy = deepC8ExplicitDy;"
    : "let derivative = max(deepC8ExplicitDx, deepC8ExplicitDy);");
  const expected = ["fragmentMain", "fragmentMainColor", "fragmentMainTransparent", "fragmentMaterial",
    "fragmentMaterialColor", "fragmentMaterialDisplay", "fragmentMaterialTransparent", "fragmentMainDisplay",
    "fragmentMainDisplayNoEffects", "fragmentMainDisplayNoEffectsOneCascade", "fragmentMainDisplayDirectional"];
  const seen: string[] = [];
  code = code.replace(/(@fragment fn (fragment\w+)\(v: (?:Vertex|DirectDisplayVertex),[^{}]+\{)/g, (_match, signature: string, name: string) => {
    seen.push(name);
    return `${signature}\n  deepC8SeedExplicitDerivative(v.normal, v.clip);`;
  });
  if (seen.sort().join() !== expected.sort().join()) throw Error(`Explicit derivative fragment entry set drifted: ${seen.join()}`);
  code = `${EXPLICIT_DERIVATIVE_WGSL}\n${code}`;
  return { ...baseline, code, instrumentedHash: sha256Utf8(code),
    candidate: "affine-numerator-bottom-row-left-column" as const, qualityCertified: false as const };
}
