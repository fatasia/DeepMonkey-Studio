import { adaptDeepSlStandardToShaderPackage } from "@bim-studio/deep-engine/shader-authoring";
import { validateDeepShaderPackage } from "@bim-studio/deep-engine/shader-package";
import { DEEP_SL_PBR_PROBE_SOURCES } from "./deepSlPbrProbeFixture.js";
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

/** Extends the existing CSM helper to the v3 compile-time coat; isolated draw proof, never Studio product readiness. */
export async function verifyDeepSlClearcoatPackage(device: GPUDevice) {
  const executor = new ShaderPackageExecutor(device);
  const cases = [];
  const capabilities = { features: [] as string[], limits: { maxBindGroups: device.limits.maxBindGroups,
    maxBindingsPerBindGroup: device.limits.maxBindingsPerBindGroup,
    maxInterStageShaderVariables: device.limits.maxInterStageShaderVariables } };
  const adapt = (factor?: number) => adaptDeepSlStandardToShaderPackage({ schemaVersion: 1,
    source: factor === undefined ? DEEP_SL_PBR_PROBE_SOURCES["rough-red"]
      : DEEP_SL_PBR_PROBE_SOURCES["rough-red"].replace("roughness 0.8;", `roughness 0.8;\n clearcoatFactor ${factor};\n clearcoatRoughness 0.2;`),
    packageId: `deep.lab.coat.${factor === undefined ? "implicit" : factor === 0 ? "zero" : "active"}`,
    packageVersion: "1.0.0", compilerVersion: "1.0.0", targetAbi: "deep.pbr.mesh.v3", capabilities });
  const invalid = adapt(1.5);
  const invalidRejected = !invalid.success && invalid.report.issues.some(issue => issue.code === "invalid-deepsl");
  try {
    for (const factor of [undefined, 0, 0.85] as const) {
      const compiled = adapt(factor);
      if (!compiled.success || !compiled.report.materialDefaults) throw new Error(JSON.stringify(compiled.report));
      const restored = JSON.parse(JSON.stringify(compiled.package));
      if (!validateDeepShaderPackage(restored).valid) throw new Error("Coat package failed serialization restore.");
      const [forward, shadow] = (await executor.prepare(restored, ["webgpu/forwardCcw", "webgpu/shadowCcw"])).passes;
      if (!forward || !shadow) throw new Error("Coat package lacks forward/shadow passes.");
      const sample = await drawDeepSlPbrCase(device, forward, shadow, compiled.report.materialDefaults, {
        shaderAbi: "deep.pbr.mesh.v3", objectId: 0x01020304,
        cascadedShadow: { uniform: csmProbeUniform(), clearDepths: [1, 1, 1, 1], shadowLayer: 3 },
      });
      cases.push({ id: factor === undefined ? "implicit-zero" : factor === 0 ? "explicit-zero" : "active-coat", sample,
        packageCacheKey: compiled.package.packageCacheKey, shaderAbi: compiled.package.shaderAbi.id });
    }
    const baseline = cases[0]!.sample, zero = cases[1]!.sample, active = cases[2]!.sample;
    const zeroBitIdentity = JSON.stringify(baseline.raw16) === JSON.stringify(zero.raw16);
    const coatDelta = Math.max(...active.pixel.slice(0, 3).map((value, i) => Math.abs(value - baseline.pixel[i]!)));
    const finite = cases.every(entry => entry.sample.pixel.every(Number.isFinite) && entry.sample.instanceStride === 160
      && entry.sample.forwardDraws === 1 && entry.sample.shadowDraws === 1);
    return { action: "deepsl-v3-clearcoat-draw", success: finite && invalidRejected && zeroBitIdentity && coatDelta > 0,
      cases, invalidRejected, zeroBitIdentity, coatDelta, invalidIssues: invalid.success ? [] : invalid.report.issues,
      scope: "Actual ShaderPackageExecutor v3/instance160 forward+shadow/readback; not Studio author consumer or Native readiness" };
  } finally { executor.dispose(); }
}
