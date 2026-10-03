import { sceneShader } from "../src/webgpu/pbrShader.js";
import { sha256Utf8 } from "../src/shaderPackage/hash.js";
import { observeDeepF32Mrt } from "./c8F32MrtShader.js";

export const F32_INPUT_MODES = ["normal", "view", "geometry-normal", "dx", "dy", "brdf-dots"] as const;
export type F32InputMode = typeof F32_INPUT_MODES[number];
// F5 方案 A:L1 门接入镜面项后生产源演进重锚(用户批准);漂移守卫语义不变。
// 2026-10-03 二次重锚:e59ce4df 落 F5 方案 A(L1 SH 方向可见度门进 shade,规格
// docs/specs/f5-directional-l1-implementation-20261003.md)时本钉仍指旧源,导致 c8F32Inputs
// 全族 7 例红;新源 14eebbd0… 为该提交后的生产 sceneShader 实测 sha256。
const knownProductionHash = "14eebbd030b4d92609fda85b4eff4f651da321ed228973d7a42ca25cc005a2df";
const derivative = "  let derivative = max(abs(dpdx(normal)), abs(dpdy(normal)));";
const dots = "  let nh = clamp(dot(n, h), 0.0, 1.0); let vh = clamp(dot(v, h), 0.0, 1.0);";
const fullCapture = "  deepC8F32Witness = deepC8Full;";
function once(source: string, seam: string, replacement: string): string {
  if (source.split(seam).length !== 2) throw Error(`Exact F32 input seam drifted: ${seam}`);
  return source.replace(seam, replacement);
}
/** Actual locals feed the added attachment. Default derivatives run once and feed the original max. */
export function observeDeepF32Inputs(mode: F32InputMode, source = sceneShader) {
  if (!F32_INPUT_MODES.includes(mode)) throw Error("Unknown exact F32 input mode");
  const baseline = observeDeepF32Mrt("full", source);
  if (baseline.originalHash !== knownProductionHash) throw Error("Exact F32 input production source drifted from pinned production baseline");
  let code = `var<private> deepC8F32Inputs: vec4f;\n${baseline.code}`;
  code = once(code, "out.witness = vec4f(deepC8F32Witness, out.color.a);", "out.witness = deepC8F32Inputs;");
  if (mode === "normal" || mode === "view") {
    code = once(code, fullCapture, `${fullCapture}\n  deepC8F32Inputs = vec4f(${mode === "normal" ? "n" : "view"}, rough);`);
  } else if (mode === "brdf-dots") {
    code = once(code, dots, `${dots}\n  deepC8F32Inputs = vec4f(nv, nl, nh, vh);`);
  } else {
    const observation = mode === "geometry-normal" ? `${derivative}\n  deepC8F32Inputs = vec4f(normal, 0.0);`
      : `  let deepC8InputDx = abs(dpdx(normal));\n  let deepC8InputDy = abs(dpdy(normal));\n  let derivative = max(deepC8InputDx, deepC8InputDy);\n  deepC8F32Inputs = vec4f(${mode === "dx" ? "deepC8InputDx" : "deepC8InputDy"}, 0.0);`;
    code = once(code, derivative, observation);
    code = once(code, fullCapture, `${fullCapture}\n  deepC8F32Inputs.w = rough;`);
  }
  return { mode, code, originalHash: baseline.originalHash, instrumentedHash: sha256Utf8(code), baselineInstrumentedHash: baseline.instrumentedHash,
    lanes: mode === "brdf-dots" ? ["nv", "nl", "nh", "vh"] : ["x", "y", "z", "rough"],
    basis: mode === "normal" || mode === "view" ? "world" : mode === "brdf-dots" ? "dimensionless-actual-brdf-locals" : "view",
    derivative: "default", coverage: "original-color-only; witness.w is data" };
}
