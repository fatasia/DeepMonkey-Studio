/// <reference types="@webgpu/types" />
import type { ShaderCompileCapabilities } from "../shader/index.js";
import { adaptDeepSlStandardToShaderPackage } from "../shaderAuthoring/packageAdapter.js";
import type { ShaderAuthoringSession } from "../shaderAuthoring/session.js";
import type { ShaderAuthoringArtifact } from "../shaderAuthoring/types.js";
import {
  adapterDiagnostics,
  authoringDiagnostics,
  EMPTY_HOT_RELOAD_DIAGNOSTICS,
  gpuDiagnostics,
  runtimeDiagnostic,
} from "./hotReloadDiagnostics.js";
import type {
  PublishedShaderPackage,
  ShaderHotReloadDiagnostic,
  ShaderHotReloadFrameBoundaryHook,
  ShaderHotReloadOptions,
  ShaderHotReloadPublishResult,
  ShaderHotReloadRequestResult,
  ShaderHotReloadState,
} from "./hotReloadTypes.js";
import { ShaderPackageExecutor } from "./shaderPackageExecutor.js";

interface ScheduledRequest {
  readonly generation: number;
  readonly resolve: (result: ShaderHotReloadRequestResult) => void;
}

interface RuntimeOptions {
  readonly capabilities: ShaderCompileCapabilities;
  readonly packageVersion: string;
  readonly compilerVersion: string;
  readonly packageId?: string;
  readonly debounceMs: number;
}

function immutableOptions(options: ShaderHotReloadOptions): RuntimeOptions {
  if (!options || typeof options !== "object") throw new TypeError("Shader hot reload options are required.");
  const debounceMs = options.debounceMs ?? 150;
  if (!Number.isSafeInteger(debounceMs) || debounceMs < 0 || debounceMs > 5_000) {
    throw new RangeError("Shader hot reload debounceMs must be a safe integer in [0, 5000].");
  }
  if (typeof options.packageVersion !== "string" || typeof options.compilerVersion !== "string") {
    throw new TypeError("Shader hot reload package and compiler versions must be strings.");
  }
  const capabilities = options.capabilities;
  if (!capabilities || !Array.isArray(capabilities.features) || !capabilities.limits) {
    throw new TypeError("Shader hot reload capabilities are required.");
  }
  return Object.freeze({
    capabilities: Object.freeze({ features: Object.freeze([...capabilities.features]), limits: Object.freeze({ ...capabilities.limits }) }),
    packageVersion: options.packageVersion,
    compilerVersion: options.compilerVersion,
    ...(options.packageId === undefined ? {} : { packageId: options.packageId }),
    debounceMs,
  });
}

function requestResult(
  status: ShaderHotReloadRequestResult["status"],
  diagnostics: readonly ShaderHotReloadDiagnostic[] = EMPTY_HOT_RELOAD_DIAGNOSTICS,
  identity?: Readonly<{ revision: string; artifactHash: string }>,
): ShaderHotReloadRequestResult {
  return Object.freeze({ status, diagnostics, ...(identity ?? {}) });
}

/** Debounced compile/prewarm transaction with explicit frame-boundary publication. */
export class ShaderHotReloadRuntime {
  private readonly options: RuntimeOptions;
  private currentState: ShaderHotReloadState = "ready";
  private active: PublishedShaderPackage | undefined;
  private pending: PublishedShaderPackage | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private scheduled: ScheduledRequest | undefined;
  private generation = 0;
  private running = 0;

  constructor(
    private readonly authoring: ShaderAuthoringSession,
    private readonly executor: ShaderPackageExecutor,
    options: ShaderHotReloadOptions,
  ) {
    this.options = immutableOptions(options);
    if (executor.state !== "ready") throw new Error("Shader package executor is not ready for hot reload.");
    const lost = (): void => this.markLost();
    void executor.device.lost.then(lost, lost);
  }

  get state(): ShaderHotReloadState { this.synchronizeState(); return this.currentState; }
  get current(): PublishedShaderPackage | undefined { this.synchronizeState(); return this.active; }
  get candidate(): PublishedShaderPackage | undefined { this.synchronizeState(); return this.pending; }

  request(): Promise<ShaderHotReloadRequestResult> {
    this.synchronizeState();
    if (this.currentState !== "ready") return Promise.resolve(this.unavailableResult());
    const generation = this.beginRequest();
    return new Promise((resolve) => {
      this.scheduled = { generation, resolve };
      this.timer = setTimeout(() => {
        this.timer = undefined; this.scheduled = undefined;
        void this.execute(generation).then(resolve);
      }, this.options.debounceMs);
    });
  }

  compileNow(): Promise<ShaderHotReloadRequestResult> {
    this.synchronizeState();
    if (this.currentState !== "ready") return Promise.resolve(this.unavailableResult());
    return this.execute(this.beginRequest());
  }

  publishAtFrameBoundary(): ShaderHotReloadPublishResult {
    this.synchronizeState();
    if (this.currentState !== "ready" || !this.pending) {
      return Object.freeze({ published: false, ...(this.active ? { current: this.active } : {}) });
    }
    this.active = this.pending; this.pending = undefined;
    return Object.freeze({ published: true, current: this.active });
  }

  createFrameBoundaryPublishHook(): ShaderHotReloadFrameBoundaryHook {
    return () => this.publishAtFrameBoundary();
  }

  dispose(): void {
    if (this.currentState === "disposed") return;
    this.currentState = "disposed"; this.generation += 1;
    this.cancelScheduled(this.unavailableResult());
    this.active = undefined; this.pending = undefined;
    this.executor.dispose();
  }

  private beginRequest(): number {
    this.generation += 1;
    this.cancelScheduled(requestResult("superseded"));
    if (this.pending) { this.pending = undefined; this.executor.clear(); }
    if (this.running > 0) this.executor.clear();
    return this.generation;
  }

  private async execute(generation: number): Promise<ShaderHotReloadRequestResult> {
    this.running += 1;
    try {
      const commit = await this.authoring.compileCandidate();
      if (generation !== this.generation || commit.stale) return requestResult("superseded");
      const diagnostics = authoringDiagnostics(commit.result.diagnostics);
      if (!commit.committed || !commit.result.success || !commit.result.artifact) return requestResult("failed", diagnostics);
      return await this.prepare(generation, commit.revision, commit.result.artifact, diagnostics, commit.view.document);
    } catch (error) {
      if (generation !== this.generation) return requestResult("superseded");
      return requestResult("failed", Object.freeze([runtimeDiagnostic("hot-reload-failed",
        error instanceof Error ? error.message : String(error))]));
    } finally {
      this.running -= 1;
    }
  }

  private async prepare(
    generation: number,
    revision: string,
    artifact: ShaderAuthoringArtifact,
    diagnostics: readonly ShaderHotReloadDiagnostic[],
    document: ReturnType<ShaderAuthoringSession["view"]>["document"],
  ): Promise<ShaderHotReloadRequestResult> {
    const identity = Object.freeze({ revision, artifactHash: artifact.pass.cacheKey });
    if (document.mode !== "text" || document.language !== "deepsl") {
      return requestResult("failed", Object.freeze([...diagnostics,
        runtimeDiagnostic("unsupported-authoring-mode", "Shader package hot reload currently requires a DeepSL text document.")]), identity);
    }
    const adapted = adaptDeepSlStandardToShaderPackage({ schemaVersion: 1, source: document.source,
      packageVersion: this.options.packageVersion, compilerVersion: this.options.compilerVersion,
      capabilities: this.options.capabilities, ...(this.options.packageId === undefined ? {} : { packageId: this.options.packageId }) });
    if (!adapted.success) return requestResult("failed",
      Object.freeze([...diagnostics, ...adapterDiagnostics(adapted.report.issues)]), identity);
    if (artifact.runtimePackage && !sameModuleContent(artifact.runtimePackage.modules, adapted.package.modules)) {
      return requestResult("failed", Object.freeze([...diagnostics,
        runtimeDiagnostic("runtime-semantic-drift", "Authoring and hot-reload adapters emitted different WGSL modules.")]), identity);
    }
    const sameActive = artifact.pass.cacheKey === this.active?.artifactHash
      && adapted.package.packageCacheKey === this.active.packageHash;
    const samePending = artifact.pass.cacheKey === this.pending?.artifactHash
      && adapted.package.packageCacheKey === this.pending.packageHash;
    if (sameActive || samePending) return requestResult("unchanged", diagnostics, identity);
    if (generation !== this.generation) return requestResult("superseded");
    try {
      const preparedPackage = await this.executor.prepare(adapted.package);
      if (generation !== this.generation) return requestResult("superseded");
      this.synchronizeState();
      if (this.currentState !== "ready") return this.unavailableResult();
      this.pending = Object.freeze({ revision, artifactHash: artifact.pass.cacheKey,
        packageHash: adapted.package.packageCacheKey, preparedPackage, compatibility: adapted.report });
      return requestResult("ready", diagnostics, identity);
    } catch (error) {
      if (generation !== this.generation) return requestResult("superseded");
      return requestResult("failed", Object.freeze([...diagnostics, ...gpuDiagnostics(error, artifact)]), identity);
    }
  }

  private cancelScheduled(result: ShaderHotReloadRequestResult): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    const scheduled = this.scheduled; this.scheduled = undefined;
    scheduled?.resolve(result);
  }

  private synchronizeState(): void {
    if (this.currentState === "ready" && this.executor.state !== "ready") this.markLost();
  }
  private markLost(): void {
    if (this.currentState !== "ready") return;
    this.currentState = "lost"; this.generation += 1;
    this.cancelScheduled(this.unavailableResult());
    this.active = undefined; this.pending = undefined;
  }
  private unavailableResult(): ShaderHotReloadRequestResult {
    const code = this.currentState === "disposed" ? "hot-reload-disposed" : "device-lost";
    const message = this.currentState === "disposed" ? "Shader hot reload runtime is disposed." : "Shader hot reload GPU device is lost.";
    return requestResult("failed", Object.freeze([runtimeDiagnostic(code, message)]));
  }
}

function sameModuleContent(
  left: readonly Readonly<{ sourceHash: Readonly<{ value: string }> }>[],
  right: readonly Readonly<{ sourceHash: Readonly<{ value: string }> }>[],
): boolean {
  const hashes = (values: readonly Readonly<{ sourceHash: Readonly<{ value: string }> }>[]) =>
    values.map(value => value.sourceHash.value).sort();
  const a = hashes(left), b = hashes(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
