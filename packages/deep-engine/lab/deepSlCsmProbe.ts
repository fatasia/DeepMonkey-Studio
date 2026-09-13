import { ShaderPackageExecutor } from "@bim-studio/deep-engine/webgpu";
import { drawDeepSlPbrCase } from "./deepSlPbrGpuDraw.js";
import {
  adaptDeepSlCsmProbe, CSM_PROBE_POINTS, CSM_PROBE_STATES, csmProbeUniform, evaluateCsmProbe,
  type CsmProbeCase,
} from "./deepSlCsmProbeFixture.js";

/** Uses production DeepSL lowering and the existing HDR+shadow draw/readback helper. */
export async function verifyDeepSlCsmPackage(device: GPUDevice) {
  const executor = new ShaderPackageExecutor(device);
  const cases: CsmProbeCase[] = [];
  let stage = "adapter";
  try {
    const adapted = adaptDeepSlCsmProbe({ features: [], limits: {
      maxBindGroups: device.limits.maxBindGroups,
      maxBindingsPerBindGroup: device.limits.maxBindingsPerBindGroup,
      maxInterStageShaderVariables: device.limits.maxInterStageShaderVariables,
    } });
    if (!adapted.success || !adapted.report.materialDefaults) {
      throw new Error(adapted.report.issues.map(issue => issue.message).join("; ") || "CSM adapter failed.");
    }
    stage = "prepare";
    const [forward, shadow] = (await executor.prepare(adapted.package,
      ["webgpu/forwardCcw", "webgpu/shadowCcw"])).passes;
    if (!forward || !shadow) throw new Error("CSM package omitted its selected passes.");
    stage = "draw-readback";
    for (const state of CSM_PROBE_STATES) {
      const sample = await drawDeepSlPbrCase(device, forward, shadow, adapted.report.materialDefaults, {
        cascadedShadow: { uniform: csmProbeUniform(), clearDepths: state.depths, shadowLayer: 3 },
        samplePoints: CSM_PROBE_POINTS,
      });
      cases.push(Object.freeze({ id: state.id, sample }));
    }
    stage = "evaluate";
    const evaluation = evaluateCsmProbe(cases);
    return Object.freeze({
      action: "deepsl-csm-package-executor", success: evaluation.verified,
      shaderOrigin: "deepsl-standard-adapter", shaderAbi: adapted.package.shaderAbi.id,
      packageCacheKey: adapted.package.packageCacheKey, abiFingerprint: adapted.package.shaderAbi.contentHash.value,
      abi: Object.freeze({ frameBytes: 208, cascadedShadowBytes: 336, depthArrayLayers: 4,
        frameShadowBinding: 1, cascadedShadowBinding: 7, shadowDynamicOffsets: 0, executedShadowLayer: 3 }),
      samplePoints: CSM_PROBE_POINTS, cases: Object.freeze(cases), evaluation,
    });
  } catch (error) {
    return Object.freeze({ action: "deepsl-csm-package-executor", success: false,
      cases: Object.freeze(cases), failure: Object.freeze({ stage, message: error instanceof Error ? error.message : String(error) }) });
  } finally { executor.dispose(); }
}
