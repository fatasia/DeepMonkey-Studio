/// <reference types="@webgpu/types" />
import {
  resolveShaderPackagePipeline, validateDeepShaderPackage,
} from "../shaderPackage/index.js";
import type {
  DeepShaderPackageV2, ShaderPackageDiagnostic, ShaderPackageModule, ShaderPackagePass,
} from "../shaderPackage/index.js";
import type { ShaderAbiAttachmentProfile } from "../shaderAbi/index.js";
import {
  ShaderCacheAbortError, ShaderCacheError, ShaderDevicePipelineCachePool,
} from "../shaderCache/index.js";
import {
  createShaderPackageBindGroupLayouts, shaderPackageRenderPipelineDescriptor,
} from "./shaderPackageDescriptors.js";

export type ShaderPackageExecutorState = "ready" | "lost" | "disposed";

export interface PreparedShaderPackagePass {
  readonly id: string;
  readonly cacheKey: string;
  readonly shaderModule: GPUShaderModule;
  readonly bindGroupLayouts: readonly GPUBindGroupLayout[];
  readonly pipelineLayout: GPUPipelineLayout;
  readonly pipeline: GPURenderPipeline;
  /** The render pass must provide a resolve target exactly when this is true. */
  readonly resolveRequired: boolean;
  readonly attachmentProfile: ShaderAbiAttachmentProfile;
}

export interface PreparedShaderPackage {
  readonly packageId: string;
  readonly packageVersion: string;
  readonly passes: readonly PreparedShaderPackagePass[];
}

export interface ShaderPackageExecutorOptions {
  /** Global pass-entry bound for this GPU device. Defaults to 256. */
  readonly maxCachedPasses?: number;
}

export class ShaderPackageExecutorError extends Error {
  constructor(message: string, readonly diagnostics: readonly ShaderPackageDiagnostic[] = []) {
    super(message);
    this.name = "ShaderPackageExecutorError";
  }
}

function selectPasses(
  packageValue: DeepShaderPackageV2,
  passIds: readonly string[] | undefined,
): readonly ShaderPackagePass[] {
  if (passIds === undefined) return packageValue.passes;
  if (!Array.isArray(passIds)) {
    throw new ShaderPackageExecutorError("Shader package pass IDs must be a string array.");
  }
  if (passIds.length === 0) {
    throw new ShaderPackageExecutorError("At least one shader package pass must be selected.");
  }
  if (passIds.length > packageValue.passes.length
    || passIds.some((id) => typeof id !== "string")) {
    throw new ShaderPackageExecutorError("Shader package pass selection is invalid or over budget.");
  }
  if (new Set(passIds).size !== passIds.length) {
    throw new ShaderPackageExecutorError("Shader package pass IDs must be unique.");
  }
  return passIds.map((id) => {
    const pass = packageValue.passes.find((candidate) => candidate.id === id);
    if (!pass) throw new ShaderPackageExecutorError(`Unknown shader package pass ${id}.`);
    return pass;
  });
}

function moduleFor(packageValue: DeepShaderPackageV2, pass: ShaderPackagePass): ShaderPackageModule {
  const module = packageValue.modules.find((candidate) => candidate.id === pass.moduleId);
  if (!module) throw new ShaderPackageExecutorError(`Missing WGSL module ${pass.moduleId}.`);
  return module;
}

function compilationError(module: ShaderPackageModule, info: GPUCompilationInfo): Error | undefined {
  const errors = info.messages.filter((message) => message.type === "error");
  if (errors.length === 0) return undefined;
  return new ShaderPackageExecutorError(errors.map((message) =>
    `${module.id} WGSL ${message.lineNum}:${message.linePos} ${message.message}`).join("\n"));
}

/** Owns device-local package pipelines; it never creates render attachments or resolve targets. */
let executorEpoch = 0;
const deviceWorkQueues = new WeakMap<GPUDevice, { tail: Promise<void> }>();

function queueDeviceWork<T>(device: GPUDevice, work: () => Promise<T>): Promise<T> {
  let queue = deviceWorkQueues.get(device);
  if (!queue) {
    queue = { tail: Promise.resolve() };
    deviceWorkQueues.set(device, queue);
  }
  const task = queue.tail.then(work);
  const settled = task.then(() => undefined, () => undefined);
  queue.tail = settled;
  void settled.finally(() => {
    if (queue!.tail === settled) deviceWorkQueues.delete(device);
  });
  return task;
}

export class ShaderPackageExecutor {
  private readonly cache: ShaderDevicePipelineCachePool<PreparedShaderPackagePass>;
  private currentState: ShaderPackageExecutorState = "ready";

  constructor(readonly device: GPUDevice, options: ShaderPackageExecutorOptions = {}) {
    executorEpoch += 1;
    this.cache = new ShaderDevicePipelineCachePool({
      namespace: "deep.browser.shader-executor",
      deviceEpoch: `browser-device-${executorEpoch}`,
      ...(options.maxCachedPasses === undefined ? {} : { maxEntries: options.maxCachedPasses }),
      // GPURenderPipeline, GPUShaderModule, and layouts have no destroy(); LRU eviction drops references.
    });
    const lost = (): void => {
      if (this.currentState !== "ready") return;
      this.currentState = "lost";
      this.cache.clearDeviceLocal();
    };
    void device.lost.then(lost, lost);
  }

  get state(): ShaderPackageExecutorState { return this.currentState; }
  get cacheSize(): number { return this.cache.size; }

  async prepare(input: unknown, passIds?: readonly string[]): Promise<PreparedShaderPackage> {
    if (this.currentState !== "ready") {
      throw new ShaderPackageExecutorError("Shader package executor is not ready.");
    }
    const validation = validateDeepShaderPackage(input);
    if (!validation.valid || !validation.value) {
      throw new ShaderPackageExecutorError(
        "Shader package validation failed.", validation.diagnostics,
      );
    }
    let selected: readonly ShaderPackagePass[];
    selected = selectPasses(validation.value, passIds);
    const packageValue = validation.value;
    try {
      const passes = await this.cache.getOrCreateAtomic({
        package: packageValue,
        passCacheKeys: selected.map((pass) => pass.cacheKey),
        // WebGPU validation error scopes are a device stack, so distinct batches queue per device.
        create: (value, missing, signal) => queueDeviceWork(
          this.device, () => this.compileCandidate(value, missing, signal),
        ),
      });
      this.assertReady();
      return Object.freeze({
        packageId: packageValue.packageId,
        packageVersion: packageValue.packageVersion,
        passes: Object.freeze(passes),
      });
    } catch (error) {
      if (this.currentState !== "ready") {
        throw new ShaderPackageExecutorError("Shader package preparation was invalidated.");
      }
      if (error instanceof ShaderCacheAbortError
        || (error instanceof ShaderCacheError && error.code === "invalidated")) {
        throw new ShaderPackageExecutorError("Shader package preparation was invalidated.");
      }
      throw error;
    }
  }

  clear(): void {
    this.cache.clearDeviceLocal();
  }

  dispose(): void {
    if (this.currentState === "disposed") return;
    this.currentState = "disposed";
    this.clear();
  }

  private assertReady(): void {
    if (this.currentState !== "ready") {
      throw new ShaderPackageExecutorError("Shader package preparation was invalidated.");
    }
  }

  private async compileCandidate(
    packageValue: DeepShaderPackageV2,
    passes: readonly ShaderPackagePass[],
    signal: AbortSignal,
  ): Promise<readonly PreparedShaderPackagePass[]> {
    if (signal.aborted) throw signal.reason;
    this.device.pushErrorScope("validation");
    let scopePopped = false;
    try {
      const modules = new Map<string, GPUShaderModule>();
      for (const pass of passes) {
        const module = moduleFor(packageValue, pass);
        if (!modules.has(module.id)) modules.set(module.id, this.device.createShaderModule({
          label: `Deep shader package ${module.id}`, code: module.source,
        }));
      }
      const moduleEntries = [...modules.entries()];
      const infos = await Promise.all(moduleEntries.map(([, shader]) => shader.getCompilationInfo()));
      infos.forEach((info, index) => {
        const module = packageValue.modules.find((value) => value.id === moduleEntries[index]![0])!;
        const error = compilationError(module, info);
        if (error) throw error;
      });
      if (signal.aborted) throw signal.reason;

      const layouts = new Map<string, {
        readonly bindGroups: readonly GPUBindGroupLayout[]; readonly pipeline: GPUPipelineLayout;
      }>();
      const bindGroupLayouts = new Map<string, GPUBindGroupLayout>();
      const pending = passes.map((pass) => {
        const module = moduleFor(packageValue, pass);
        const execution = resolveShaderPackagePipeline(packageValue.shaderAbi.contract, pass.pipeline);
        if (!execution) throw new ShaderPackageExecutorError(`Unresolvable pipeline ${pass.id}.`);
        const layoutKey = execution.bindGroupLayouts.map((value) => value.id).join("/");
        let layout = layouts.get(layoutKey);
        if (!layout) {
          const bindGroups = createShaderPackageBindGroupLayouts(
            this.device, execution, bindGroupLayouts,
          );
          layout = { bindGroups, pipeline: this.device.createPipelineLayout({
            label: `Deep shader package layout ${layoutKey}`, bindGroupLayouts: bindGroups,
          }) };
          layouts.set(layoutKey, layout);
        }
        const descriptor = shaderPackageRenderPipelineDescriptor(
          pass, module, modules.get(module.id)!, layout.pipeline, execution,
        );
        return {
          pass, module: modules.get(module.id)!, layout, execution,
          pipeline: this.device.createRenderPipelineAsync(descriptor),
        };
      });
      const settled = await Promise.allSettled(pending.map((value) => value.pipeline));
      scopePopped = true;
      const validationError = await this.device.popErrorScope();
      const rejected = settled.find((value) => value.status === "rejected") as PromiseRejectedResult | undefined;
      if (rejected) throw rejected.reason;
      if (validationError) throw new ShaderPackageExecutorError(validationError.message);
      if (signal.aborted) throw signal.reason;
      this.assertReady();
      const created = pending.map((value, index): PreparedShaderPackagePass => Object.freeze({
        id: value.pass.id,
        cacheKey: value.pass.cacheKey,
        shaderModule: value.module,
        bindGroupLayouts: value.layout.bindGroups,
        pipelineLayout: value.layout.pipeline,
        pipeline: (settled[index] as PromiseFulfilledResult<GPURenderPipeline>).value,
        resolveRequired: value.execution.attachmentProfile.resolve === "required",
        attachmentProfile: value.execution.attachmentProfile,
      }));
      return Object.freeze(created);
    } catch (error) {
      if (!scopePopped) {
        scopePopped = true;
        try { await this.device.popErrorScope(); } catch { /* Device loss preserves original error. */ }
      }
      throw error;
    }
  }
}
