import {
  adaptDeepSlStandardToShaderPackage,
  type DeepSlPackageAdapterResult,
} from "@bim-studio/deep-engine/shader-authoring";
import type { ShaderCompileCapabilities } from "@bim-studio/deep-engine/shader";
import { ShaderPackageExecutor } from "@bim-studio/deep-engine/webgpu";
import { drawDeepSlPbrCase } from "./deepSlPbrGpuDraw.js";
import {
  DEEP_SL_PBR_PROBE_SOURCES,
  evaluatePbrProbe,
  type DeepSlPbrPixelSample,
  type DeepSlPbrProbeCaseId,
} from "./deepSlPbrProbeFixture.js";

const PACKAGE_ID = "deep.lab.deepsl-pbr-probe";
const PASS_IDS = Object.freeze(["webgpu/forwardCcw", "webgpu/shadowCcw"] as const);

function adapterCapabilities(device: GPUDevice): ShaderCompileCapabilities {
  return Object.freeze({
    features: Object.freeze([]),
    limits: Object.freeze({
      maxBindGroups: device.limits.maxBindGroups,
      maxBindingsPerBindGroup: device.limits.maxBindingsPerBindGroup,
      maxInterStageShaderVariables: device.limits.maxInterStageShaderVariables,
    }),
  });
}

export function adaptDeepSlPbrProbeCase(
  id: DeepSlPbrProbeCaseId,
  capabilities: ShaderCompileCapabilities,
): DeepSlPackageAdapterResult {
  return adaptDeepSlStandardToShaderPackage({
    schemaVersion: 1,
    source: DEEP_SL_PBR_PROBE_SOURCES[id],
    packageId: PACKAGE_ID,
    packageVersion: "1.0.0",
    compilerVersion: "1.0.0",
    capabilities,
  });
}

export type DeepSlPbrProbeRecord = Readonly<{
  action: "deepsl-pbr-package-executor";
  success: boolean;
  shaderOrigin: "deepsl-standard-adapter";
  packageCacheKey?: string;
  pipelineCache?: Readonly<{
    entries: number;
    reusedAcrossMaterialDefaults: boolean;
  }>;
  selectedPasses?: readonly Readonly<{
    id: string;
    sampleCount: number;
    resolveRequired: boolean;
    colorFormats: readonly string[];
    depthFormat: string;
  }>[];
  abi?: Readonly<{
    frameBytes: 208;
    geometryStride: 40;
    instanceStride: 144;
    shadowDrawsPerCase: 1;
    forwardDrawsPerCase: 1;
    colorFormat: "rgba16float";
    sampleCount: 4;
    resolveUsed: true;
  }>;
  cases?: readonly Readonly<{
    id: DeepSlPbrProbeCaseId;
    materialDefaults: NonNullable<Extract<DeepSlPackageAdapterResult, { success: true }>["report"]["materialDefaults"]>;
    raw16: readonly number[];
    pixel: readonly number[];
  }>[];
  evaluation?: ReturnType<typeof evaluatePbrProbe>;
  failure?: Readonly<{
    stage: "adapter" | "prepare" | "draw-readback" | "evaluate";
    caseId?: DeepSlPbrProbeCaseId;
    message: string;
  }>;
}>;

/** Executes adapter-generated Standard PBR packages without using PbrRenderer. */
export async function verifyDeepSlPbrPackage(device: GPUDevice): Promise<DeepSlPbrProbeRecord> {
  const executor = new ShaderPackageExecutor(device);
  const ids = Object.keys(DEEP_SL_PBR_PROBE_SOURCES) as DeepSlPbrProbeCaseId[];
  const cases: Array<NonNullable<DeepSlPbrProbeRecord["cases"]>[number]> = [];
  let stage: NonNullable<DeepSlPbrProbeRecord["failure"]>["stage"] = "adapter";
  let caseId: DeepSlPbrProbeCaseId | undefined;
  let packageCacheKey: string | undefined;
  let firstPipelines: readonly [GPURenderPipeline, GPURenderPipeline] | undefined;
  let pipelinesReused = true;
  let selectedPasses: DeepSlPbrProbeRecord["selectedPasses"];
  let executedAbi: DeepSlPbrProbeRecord["abi"];
  try {
    for (const id of ids) {
      caseId = id;
      stage = "adapter";
      const adapted = adaptDeepSlPbrProbeCase(id, adapterCapabilities(device));
      if (!adapted.success || !adapted.report.materialDefaults) {
        throw new Error(adapted.report.issues.map((issue) => `${issue.code}: ${issue.message}`).join("; ")
          || "DeepSL adapter omitted material defaults.");
      }
      if (packageCacheKey !== undefined && packageCacheKey !== adapted.package.packageCacheKey) {
        throw new Error("Material-only DeepSL changes unexpectedly changed the executable package cache key.");
      }
      packageCacheKey = adapted.package.packageCacheKey;

      stage = "prepare";
      const prepared = await executor.prepare(adapted.package, PASS_IDS);
      const [forward, shadow] = prepared.passes;
      if (!forward || !shadow) throw new Error("Executor did not return the selected forward and shadow passes.");
      if (firstPipelines) {
        pipelinesReused = pipelinesReused
          && forward.pipeline === firstPipelines[0]
          && shadow.pipeline === firstPipelines[1];
      } else {
        firstPipelines = [forward.pipeline, shadow.pipeline];
        selectedPasses = Object.freeze(prepared.passes.map((pass) => Object.freeze({
          id: pass.id,
          sampleCount: pass.attachmentProfile.sampleCount,
          resolveRequired: pass.resolveRequired,
          colorFormats: Object.freeze(pass.attachmentProfile.colorAttachments.map((attachment) => attachment.format)),
          depthFormat: pass.attachmentProfile.depthAttachment.format,
        })));
      }

      stage = "draw-readback";
      const sample = await drawDeepSlPbrCase(device, forward, shadow, adapted.report.materialDefaults);
      executedAbi ??= Object.freeze({
        frameBytes: sample.frameBytes,
        geometryStride: sample.geometryStride,
        instanceStride: sample.instanceStride,
        shadowDrawsPerCase: sample.shadowDraws,
        forwardDrawsPerCase: sample.forwardDraws,
        colorFormat: sample.colorFormat,
        sampleCount: sample.sampleCount,
        resolveUsed: sample.resolveUsed,
      });
      cases.push(Object.freeze({
        id,
        materialDefaults: adapted.report.materialDefaults,
        raw16: sample.raw16,
        pixel: sample.pixel,
      }));
    }

    stage = "evaluate";
    const samples: DeepSlPbrPixelSample[] = cases.map(({ id, pixel }) => ({ id, pixel }));
    const evaluation = evaluatePbrProbe(samples);
    if (!pipelinesReused) throw new Error("Executor did not reuse the identical adapter package pipelines.");
    if (!evaluation.verified) {
      throw new Error(`PBR readback assertion failed: ${JSON.stringify(evaluation)}`);
    }
    if (!packageCacheKey) throw new Error("Adapter package identity was unavailable after execution.");
    if (!selectedPasses || !executedAbi) throw new Error("Executor pass profile was unavailable after execution.");
    return Object.freeze({
      action: "deepsl-pbr-package-executor",
      success: true,
      shaderOrigin: "deepsl-standard-adapter",
      packageCacheKey,
      pipelineCache: Object.freeze({ entries: executor.cacheSize, reusedAcrossMaterialDefaults: true }),
      selectedPasses,
      abi: executedAbi,
      cases: Object.freeze(cases),
      evaluation,
    });
  } catch (error) {
    return Object.freeze({
      action: "deepsl-pbr-package-executor",
      success: false,
      shaderOrigin: "deepsl-standard-adapter",
      ...(packageCacheKey ? { packageCacheKey } : {}),
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
