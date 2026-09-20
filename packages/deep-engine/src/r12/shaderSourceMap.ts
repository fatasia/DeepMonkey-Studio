import type { FrameCaptureSourceMapRef } from "./frameCapture.js";
import type { DeepShaderPackageV2, ShaderPackagePass } from "../shaderPackage/types.js";

const BINDING_ID = /^[A-Za-z][A-Za-z0-9_.:/-]*$/u;
function validBindingId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 256 && BINDING_ID.test(value)
    && !["__proto__", "constructor", "prototype"].includes(value);
}

/**
 * The executable shader package keeps moduleId on the pass and source-map
 * entries keep only stage/node/line. R12 stores the fully qualified identity
 * so a capture can be queried without reopening the package envelope.
 */
export function frameCaptureSourceMapRefsForShaderPass(
  pass: Pick<ShaderPackagePass, "moduleId" | "sourceMap">,
): readonly FrameCaptureSourceMapRef[] {
  return Object.freeze(pass.sourceMap.map((entry) => Object.freeze({
    moduleId: pass.moduleId,
    stage: entry.stage,
    nodeId: entry.nodeId,
    generatedLine: entry.generatedLine,
  })));
}

export interface FrameCaptureShaderPassBinding {
  /** ID used by PbrActualPassDescription / PassCaptureInput. */
  readonly capturePassId: string;
  /** Canonical technique/pass ID in DeepShaderPackageV2. */
  readonly shaderPassId: string;
}

/**
 * Builds the map consumed by PbrFrameCapture from explicit pass bindings.
 * A missing or duplicate binding fails closed; silently dropping a source map
 * would make a capture look complete while making source lookup impossible.
 */
export function frameCaptureSourceMapRefsByPass(
  packageValue: Pick<DeepShaderPackageV2, "passes">,
  bindings: readonly FrameCaptureShaderPassBinding[],
): ReadonlyMap<string, readonly FrameCaptureSourceMapRef[]> {
  const shaderPasses = new Map(packageValue.passes.map((pass) => [pass.id, pass] as const));
  if (shaderPasses.size !== packageValue.passes.length) throw new Error("Duplicate shader package pass in frame capture binding.");
  const result = new Map<string, readonly FrameCaptureSourceMapRef[]>();
  for (const binding of bindings) {
    if (!validBindingId(binding.capturePassId)) {
      throw new Error("Frame capture shader binding requires a capturePassId.");
    }
    if (!validBindingId(binding.shaderPassId)) {
      throw new Error(`Frame capture shader binding ${binding.capturePassId} requires a shaderPassId.`);
    }
    if (result.has(binding.capturePassId)) {
      throw new Error(`Duplicate frame capture shader binding ${binding.capturePassId}.`);
    }
    const pass = shaderPasses.get(binding.shaderPassId);
    if (!pass) {
      throw new Error(`Shader package pass ${binding.shaderPassId} is not available for frame capture.`);
    }
    result.set(binding.capturePassId, frameCaptureSourceMapRefsForShaderPass(pass));
  }
  return result;
}
