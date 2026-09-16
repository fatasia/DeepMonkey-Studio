/// <reference types="@webgpu/types" />
import {
  createShaderAuthoringSession,
  type ShaderTextAuthoringDocument,
} from "@bim-studio/deep-engine/shader-authoring";
import {
  ShaderHotReloadRuntime,
  ShaderPackageExecutor,
  shaderCapabilitiesForDevice,
  type ShaderHotReloadRequestResult,
} from "@bim-studio/deep-engine/webgpu";

const OPAQUE = `shader deep.hot.probe {
  surface standard;
  baseColor [0.2, 0.4, 0.8, 1];
  metallic 0.3;
  roughness 0.6;
  alpha opaque;
  doubleSided false;
  baseColorTexture off;
}`;
const BLEND = OPAQUE.replace("alpha opaque", "alpha blend");
const DOUBLE_SIDED = BLEND.replace("doubleSided false", "doubleSided true");
// Keep the newest-request case inside the Shader IR v1 feature set. Alpha mask is intentionally
// rejected by that schema, so use a material edit that still exercises a distinct package.
const LATEST = DOUBLE_SIDED.replace("roughness 0.6", "roughness 0.45");
const INVALID_WGSL = "@vertex fn invalidCandidate( -> @builtin(position) vec4f { return vec4f(0.0); }";

interface GpuTrace {
  shaderModules: number;
  injectedInvalidModules: number;
  errorScopePushes: number;
  errorScopePops: number;
  pipelineWarmups: number;
  injectInvalidNextModule: boolean;
}

export interface ShaderHotReloadProbeChecks {
  readonly initialPublish: boolean;
  readonly successfulReplacement: boolean;
  readonly gpuFailurePreservedActive: boolean;
  readonly latestRequestOnly: boolean;
  readonly identicalPackageNoOp: boolean;
  readonly compilationInfoFailure: boolean;
  readonly validationScopesBalanced: boolean;
  readonly pipelineWarmupObserved: boolean;
  readonly deviceLossInvalidated: boolean;
  readonly disposeFinal: boolean;
}

export interface ShaderHotReloadProbeResult {
  readonly action: "shader-hot-reload-runtime";
  readonly success: boolean;
  readonly execution: "dedicated-browser-gpu-device";
  readonly checks: ShaderHotReloadProbeChecks;
  readonly gpuTrace: Readonly<Omit<GpuTrace, "injectInvalidNextModule">>;
  readonly requestStatuses: readonly ShaderHotReloadRequestResult["status"][];
  /** Compact request diagnostics make a real-device failure actionable in the lab report. */
  readonly requestDiagnostics: readonly Readonly<{ status: string; codes: readonly string[]; messages: readonly string[] }>[];
  readonly publishedPackageHashes: readonly string[];
  readonly gpuDiagnosticCodes: readonly string[];
  readonly failure?: Readonly<{ stage: string; message: string }>;
}

export function evaluateShaderHotReloadChecks(checks: ShaderHotReloadProbeChecks): boolean {
  return Object.values(checks).every(Boolean);
}

function sourceDocument(source: string): ShaderTextAuthoringDocument {
  return { schemaVersion: 1, id: "deep.hot.probe", mode: "text", language: "deepsl", source };
}

function instrumentRealDevice(real: GPUDevice, trace: GpuTrace): GPUDevice {
  return new Proxy(real, {
    get(target, property) {
      if (property === "createShaderModule") return (descriptor: GPUShaderModuleDescriptor) => {
        trace.shaderModules += 1;
        const inject = trace.injectInvalidNextModule;
        if (inject) {
          trace.injectInvalidNextModule = false;
          trace.injectedInvalidModules += 1;
        }
        return target.createShaderModule(inject ? { ...descriptor, code: INVALID_WGSL } : descriptor);
      };
      if (property === "pushErrorScope") return (filter: GPUErrorFilter) => {
        trace.errorScopePushes += 1;
        target.pushErrorScope(filter);
      };
      if (property === "popErrorScope") return async () => {
        trace.errorScopePops += 1;
        return target.popErrorScope();
      };
      if (property === "createRenderPipelineAsync") return (descriptor: GPURenderPipelineDescriptor) => {
        trace.pipelineWarmups += 1;
        return target.createRenderPipelineAsync(descriptor);
      };
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function requestDedicatedDevice(): Promise<GPUDevice> {
  const gpu = navigator.gpu;
  if (!gpu) throw new Error("WebGPU is unavailable for the hot reload probe.");
  const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("No WebGPU adapter is available for the hot reload probe.");
  return adapter.requestDevice();
}

function frozenTrace(trace: GpuTrace): ShaderHotReloadProbeResult["gpuTrace"] {
  return Object.freeze({
    shaderModules: trace.shaderModules,
    injectedInvalidModules: trace.injectedInvalidModules,
    errorScopePushes: trace.errorScopePushes,
    errorScopePops: trace.errorScopePops,
    pipelineWarmups: trace.pipelineWarmups,
  });
}

/** Runs the editor-to-GPU hot reload transaction on an isolated, real browser GPUDevice. */
export async function verifyShaderHotReloadRuntime(): Promise<ShaderHotReloadProbeResult> {
  let stage = "request-device";
  let realDevice: GPUDevice | undefined;
  let runtime: ShaderHotReloadRuntime | undefined;
  const statuses: ShaderHotReloadRequestResult["status"][] = [];
  const requestDiagnostics: Array<Readonly<{ status: string; codes: readonly string[]; messages: readonly string[] }>> = [];
  const hashes: string[] = [];
  const gpuDiagnosticCodes: string[] = [];
  const trace: GpuTrace = { shaderModules: 0, injectedInvalidModules: 0, errorScopePushes: 0,
    errorScopePops: 0, pipelineWarmups: 0, injectInvalidNextModule: false };
  try {
    realDevice = await requestDedicatedDevice();
    const device = instrumentRealDevice(realDevice, trace);
    const targetCapabilities = shaderCapabilitiesForDevice(realDevice);
    const created = createShaderAuthoringSession(sourceDocument(OPAQUE), { capabilities: targetCapabilities });
    if (!created.success || !created.session) throw new Error("Hot reload authoring session creation failed.");
    const authoring = created.session;
    const executor = new ShaderPackageExecutor(device);
    runtime = new ShaderHotReloadRuntime(authoring, executor, {
      capabilities: targetCapabilities, packageVersion: "1.0.0", compilerVersion: "1.0.0", debounceMs: 4,
    });

    stage = "initial-publish";
    const recordRequest = (result: ShaderHotReloadRequestResult): ShaderHotReloadRequestResult => {
      statuses.push(result.status);
      requestDiagnostics.push(Object.freeze({ status: result.status,
        codes: Object.freeze(result.diagnostics.map((entry) => entry.code)),
        messages: Object.freeze(result.diagnostics.map((entry) => entry.message)) }));
      return result;
    };
    const initial = recordRequest(await runtime.compileNow());
    const initialWarmups = trace.pipelineWarmups;
    const first = runtime.publishAtFrameBoundary();
    if (first.current) hashes.push(first.current.packageHash);
    const initialPublish = initial.status === "ready" && first.published
      && (first.current?.preparedPackage.passes.length ?? 0) > 0 && initialWarmups > 0;

    stage = "successful-replacement";
    authoring.replaceDocument(sourceDocument(BLEND));
    const replacement = recordRequest(await runtime.compileNow());
    const replaced = runtime.publishAtFrameBoundary();
    if (replaced.current) hashes.push(replaced.current.packageHash);
    const successfulReplacement = replacement.status === "ready" && replaced.published
      && replaced.current !== first.current && trace.pipelineWarmups > initialWarmups;

    stage = "gpu-compilation-failure";
    const activeBeforeFailure = runtime.current;
    executor.clear();
    trace.injectInvalidNextModule = true;
    authoring.replaceDocument(sourceDocument(DOUBLE_SIDED));
    const failed = recordRequest(await runtime.compileNow());
    gpuDiagnosticCodes.push(...failed.diagnostics.filter(entry => entry.stage === "gpu").map(entry => entry.code));
    const failedPublish = runtime.publishAtFrameBoundary();
    const gpuFailurePreservedActive = failed.status === "failed" && runtime.current === activeBeforeFailure
      && !failedPublish.published && failedPublish.current === activeBeforeFailure;
    const compilationInfoFailure = trace.injectedInvalidModules === 1
      && gpuDiagnosticCodes.includes("wgsl-compilation-error");

    stage = "latest-request";
    const firstRapid = runtime.request();
    authoring.replaceDocument(sourceDocument(LATEST));
    const latestRapid = runtime.request();
    const [superseded, latest] = await Promise.all([firstRapid, latestRapid]);
    recordRequest(superseded); recordRequest(latest);
    const latestPublish = runtime.publishAtFrameBoundary();
    if (latestPublish.current) hashes.push(latestPublish.current.packageHash);
    const latestRequestOnly = superseded.status === "superseded" && latest.status === "ready"
      && latestPublish.published && latestPublish.current?.revision === authoring.view().revision;

    stage = "identical-no-op";
    const beforeNoOp = frozenTrace(trace);
    const unchanged = recordRequest(await runtime.compileNow());
    const afterNoOp = frozenTrace(trace);
    const identicalPackageNoOp = unchanged.status === "unchanged"
      && JSON.stringify(beforeNoOp) === JSON.stringify(afterNoOp) && !runtime.publishAtFrameBoundary().published;

    stage = "device-loss";
    realDevice.destroy();
    await realDevice.lost;
    await Promise.resolve();
    const lostRequest = recordRequest(await runtime.compileNow());
    const deviceLossInvalidated = runtime.state === "lost" && runtime.current === undefined
      && lostRequest.diagnostics.some(entry => entry.code === "device-lost");
    runtime.dispose();
    const disposedRequest = recordRequest(await runtime.compileNow());
    const disposeFinal = runtime.state === "disposed"
      && disposedRequest.diagnostics.some(entry => entry.code === "hot-reload-disposed");
    const checks = Object.freeze({
      initialPublish, successfulReplacement, gpuFailurePreservedActive, latestRequestOnly,
      identicalPackageNoOp, compilationInfoFailure,
      validationScopesBalanced: trace.errorScopePushes > 0 && trace.errorScopePushes === trace.errorScopePops,
      pipelineWarmupObserved: trace.pipelineWarmups > initialWarmups,
      deviceLossInvalidated, disposeFinal,
    });
    return Object.freeze({ action: "shader-hot-reload-runtime", success: evaluateShaderHotReloadChecks(checks),
      execution: "dedicated-browser-gpu-device", checks, gpuTrace: frozenTrace(trace),
      requestStatuses: Object.freeze(statuses), requestDiagnostics: Object.freeze(requestDiagnostics),
      publishedPackageHashes: Object.freeze(hashes),
      gpuDiagnosticCodes: Object.freeze(gpuDiagnosticCodes) });
  } catch (error) {
    const checks = Object.freeze({ initialPublish: false, successfulReplacement: false,
      gpuFailurePreservedActive: false, latestRequestOnly: false, identicalPackageNoOp: false,
      compilationInfoFailure: false, validationScopesBalanced: false, pipelineWarmupObserved: false,
      deviceLossInvalidated: false, disposeFinal: false });
    return Object.freeze({ action: "shader-hot-reload-runtime", success: false,
      execution: "dedicated-browser-gpu-device", checks, gpuTrace: frozenTrace(trace),
      requestStatuses: Object.freeze(statuses), requestDiagnostics: Object.freeze(requestDiagnostics),
      publishedPackageHashes: Object.freeze(hashes),
      gpuDiagnosticCodes: Object.freeze(gpuDiagnosticCodes), failure: Object.freeze({ stage,
        message: error instanceof Error ? error.message : String(error) }) });
  } finally {
    runtime?.dispose();
    realDevice?.destroy();
  }
}
