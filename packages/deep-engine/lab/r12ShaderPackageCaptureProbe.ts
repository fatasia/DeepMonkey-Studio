import { FrameCaptureSession } from "../src/r12/frameCapture.js";
import { frameCaptureSourceMapRefsByPass } from "../src/r12/shaderSourceMap.js";
import { ShaderPackageExecutor } from "../src/webgpu/shaderPackageExecutor.js";
import { adaptDeepSlPbrProbeCase } from "./deepSlPbrProbe.js";
import { drawDeepSlPbrCase } from "./deepSlPbrGpuDraw.js";

/** A standalone package-executor receipt, deliberately separate from built-in PBR capture. */
export async function runR12ShaderPackageCaptureProbe() {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error("A real WebGPU adapter is required.");
  const device = await adapter.requestDevice();
  const executor = new ShaderPackageExecutor(device);
  const capture = new FrameCaptureSession();
  try {
    const adapted = adaptDeepSlPbrProbeCase("rough-red", { features: [], limits: {
      maxBindGroups: device.limits.maxBindGroups,
      maxBindingsPerBindGroup: device.limits.maxBindingsPerBindGroup,
      maxInterStageShaderVariables: device.limits.maxInterStageShaderVariables,
    } });
    if (!adapted.success || !adapted.report.materialDefaults) throw new Error("DeepSL package adaptation failed.");
    const ids = ["webgpu/forwardCcw", "webgpu/shadowCcw"] as const;
    const prepared = await executor.prepare(adapted.package, ids);
    const [forward, shadow] = prepared.passes;
    if (!forward || !shadow) throw new Error("Prepared forward/shadow passes missing.");
    const refs = frameCaptureSourceMapRefsByPass(adapted.package,
      ids.map(id => ({ capturePassId: id, shaderPassId: id })));
    capture.beginFrame("package-real-gpu", performance.now());
    const pixels = await drawDeepSlPbrCase(device, forward, shadow, adapted.report.materialDefaults);
    // The helper executes shadow then forward and resolves GPU readback before returning.
    // Record only after successful execution; this is a completion receipt, not pass timing.
    for (const id of [...ids].reverse()) capture.recordPass({ passId: id,
      kind: id === shadow.id ? "shadow" : "forward", executor: "ShaderPackageExecutor",
      reads: [], writes: [], execution: { kind: "draw", vertexCount: 3, instanceCount: 1 },
      sourceMapRefs: refs.get(id)! });
    const record = capture.endFrame(performance.now());
    const firstRef = record.passes.flatMap(pass => pass.sourceMapRefs)[0];
    const matches = firstRef ? capture.findBySourceMap(firstRef) : [];
    return { success: !!firstRef && matches.length > 0, record, matches, pixels,
      packageCacheKey: adapted.package.packageCacheKey,
      scope: "Actual package GPU draws + readback and post-completion source lookup; not built-in PbrRenderer source-map integration" };
  } finally { executor.dispose(); device.destroy(); }
}
