import {
  adaptDeepSlStandardToShaderPackage,
  type DeepSlPackageAdapterResult,
} from "@bim-studio/deep-engine/shader-authoring";
import type { ShaderCompileCapabilities } from "@bim-studio/deep-engine/shader";
import {
  ShaderPackageExecutor,
  type PreparedShaderPackagePass,
} from "@bim-studio/deep-engine/webgpu";
import { drawDeepSlPbrCase } from "./deepSlPbrGpuDraw.js";
import { PBR_PROBE_HEIGHT, PBR_PROBE_WIDTH } from "./deepSlPbrProbeFixture.js";
import {
  evaluateMaterialModesProbe,
  materialModeSource,
  reversedPbrProbeGeometry,
  type DeepSlMaterialModeCaseId,
} from "./deepSlMaterialModesProbeFixture.js";

const PACKAGE_ID = "deep.lab.deepsl-material-modes";

interface ProbeCase {
  readonly id: DeepSlMaterialModeCaseId;
  readonly alpha: number;
  readonly alphaMode: "opaque" | "mask";
  readonly doubleSided: boolean;
  readonly reverseWinding: boolean;
}

const CASES: readonly ProbeCase[] = Object.freeze([
  { id: "mask-below-cutoff", alpha: 0.25, alphaMode: "mask", doubleSided: false, reverseWinding: false },
  { id: "mask-above-cutoff", alpha: 0.75, alphaMode: "mask", doubleSided: false, reverseWinding: false },
  { id: "backface-single-sided", alpha: 1, alphaMode: "opaque", doubleSided: false, reverseWinding: true },
  { id: "backface-double-sided", alpha: 1, alphaMode: "opaque", doubleSided: true, reverseWinding: true },
]);

function capabilities(device: GPUDevice): ShaderCompileCapabilities {
  return Object.freeze({
    features: Object.freeze([]),
    limits: Object.freeze({
      maxBindGroups: device.limits.maxBindGroups,
      maxBindingsPerBindGroup: device.limits.maxBindingsPerBindGroup,
      maxInterStageShaderVariables: device.limits.maxInterStageShaderVariables,
    }),
  });
}

export function adaptMaterialModeProbeCase(
  value: ProbeCase,
  shaderCapabilities: ShaderCompileCapabilities,
): DeepSlPackageAdapterResult {
  return adaptDeepSlStandardToShaderPackage({
    schemaVersion: 1,
    source: materialModeSource(value.alpha, value.alphaMode, value.doubleSided),
    packageId: PACKAGE_ID,
    packageVersion: "1.0.0",
    compilerVersion: "1.0.0",
    capabilities: shaderCapabilities,
  });
}

function selectedPassIds(value: ProbeCase): readonly [string, string] {
  const suffix = value.doubleSided ? "Double" : "Ccw";
  return [`webgpu/forward${suffix}`, `webgpu/shadow${suffix}`];
}

export type DeepSlMaterialModesProbeRecord = Readonly<{
  action: "deepsl-material-modes-package-executor";
  success: boolean;
  gpuReadback?: Readonly<{
    colorFormat: "rgba16float";
    shadowDepthFormat: "depth32float";
    dimensions: readonly [typeof PBR_PROBE_WIDTH, typeof PBR_PROBE_HEIGHT];
  }>;
  cases?: readonly Readonly<{
    id: DeepSlMaterialModeCaseId;
    passIds: readonly [string, string];
    packageCacheKey: string;
    materialFlags: number;
    raw16: readonly number[];
    pixel: readonly number[];
    shadowDepth: number;
  }>[];
  evaluation?: ReturnType<typeof evaluateMaterialModesProbe>;
  failure?: Readonly<{
    stage: "adapter" | "prepare" | "draw-readback" | "evaluate";
    caseId?: DeepSlMaterialModeCaseId;
    message: string;
  }>;
}>;

function requirePasses(
  passes: readonly PreparedShaderPackagePass[],
): readonly [PreparedShaderPackagePass, PreparedShaderPackagePass] {
  const [forward, shadow] = passes;
  if (!forward || !shadow) throw new Error("Material-mode executor omitted a selected forward or shadow pass.");
  return [forward, shadow];
}

/** Executes alpha-cutout and back-face cases on the caller's real WebGPU device. */
export async function verifyDeepSlMaterialModes(device: GPUDevice): Promise<DeepSlMaterialModesProbeRecord> {
  const executor = new ShaderPackageExecutor(device);
  const samples: Array<NonNullable<DeepSlMaterialModesProbeRecord["cases"]>[number]> = [];
  let stage: NonNullable<DeepSlMaterialModesProbeRecord["failure"]>["stage"] = "adapter";
  let caseId: DeepSlMaterialModeCaseId | undefined;
  try {
    for (const value of CASES) {
      caseId = value.id;
      stage = "adapter";
      const adapted = adaptMaterialModeProbeCase(value, capabilities(device));
      if (!adapted.success || !adapted.report.materialDefaults) {
        throw new Error(adapted.report.issues.map((issue) => `${issue.code}: ${issue.message}`).join("; ")
          || "Material-mode adapter omitted defaults.");
      }
      const passIds = selectedPassIds(value);
      stage = "prepare";
      const [forward, shadow] = requirePasses((await executor.prepare(adapted.package, passIds)).passes);
      stage = "draw-readback";
      const drawn = await drawDeepSlPbrCase(device, forward, shadow, adapted.report.materialDefaults, {
        ...(value.reverseWinding ? { geometry: reversedPbrProbeGeometry() } : {}),
      });
      samples.push(Object.freeze({
        id: value.id,
        passIds,
        packageCacheKey: adapted.package.packageCacheKey,
        materialFlags: adapted.report.materialDefaults.roughnessAlphaCutoffHandednessFlags[3],
        raw16: drawn.raw16,
        pixel: drawn.pixel,
        shadowDepth: drawn.shadowDepth,
      }));
    }
    stage = "evaluate";
    const evaluation = evaluateMaterialModesProbe(samples);
    if (!evaluation.verified) throw new Error(`Material-mode GPU readback failed: ${JSON.stringify(evaluation)}`);
    return Object.freeze({
      action: "deepsl-material-modes-package-executor",
      success: true,
      gpuReadback: Object.freeze({
        colorFormat: "rgba16float", shadowDepthFormat: "depth32float",
        dimensions: Object.freeze([PBR_PROBE_WIDTH, PBR_PROBE_HEIGHT] as const),
      }),
      cases: Object.freeze(samples),
      evaluation,
    });
  } catch (error) {
    return Object.freeze({
      action: "deepsl-material-modes-package-executor",
      success: false,
      failure: Object.freeze({
        stage,
        ...(caseId ? { caseId } : {}),
        message: error instanceof Error ? error.message : String(error),
      }),
    });
  } finally {
    executor.dispose();
  }
}
