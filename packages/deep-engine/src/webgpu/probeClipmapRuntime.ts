/// <reference types="@webgpu/types" />
import {
  ProbeClipmapCaptureExecutor, type ProbeCaptureExecutionStats,
} from "../lighting/probeClipmapCaptureExecutor.js";
import {
  DEEP_GI_PROBE_CLIPMAP_DEFAULTS,
  type ProbeAabb, type ProbeClipmapOptions, type ProbeGridSize, type ProbeVector3,
} from "../lighting/probeClipmapPlan.js";
import { ProbeClipmapResources } from "../lighting/probeClipmapResources.js";
import {
  ProbeClipmapUpdateScheduler, type ProbeClipmapFrameResult, type ProbeClipmapFrameStats,
  type ProbeClipmapPlanPublisher, type ProbeClipmapSchedulerOptions,
} from "../lighting/probeClipmapUpdateScheduler.js";
import {
  ProbeRelocationPublisher, ProbeRelocationResolver,
  type ProbeRelocationFrameEvidence, type ProbeRelocationResolverOptions,
} from "../lighting/probeRelocationResolver.js";
import type { DeviceSession } from "./deviceSession.js";
import { WebGpuProbeCaptureAdapter } from "./webgpuProbeCaptureAdapter.js";
import type {
  WebGpuProbeCaptureOptions, WebGpuProbeCaptureSubmission, WebGpuProbeSamplingBinding,
} from "./webgpuProbeCaptureTypes.js";

const EMPTY_DIAGNOSTICS = Object.freeze([]) as readonly ProbeClipmapRuntimeDiagnostic[];
const DIAGNOSTIC_LIMIT = 64;

export const DEFAULT_PROBE_CLIPMAP_RUNTIME_OPTIONS = Object.freeze({
  frameBudget: 64, cameraCutBudget: 96, maxTransientBytes: 32 * 1024 * 1024,
  dynamicIrradianceHysteresis: 0.85,
} as const);

export interface ProbeClipmapRuntimeOptions extends ProbeClipmapSchedulerOptions,
  WebGpuProbeCaptureOptions {
  readonly clipmap?: Omit<ProbeClipmapOptions, "updateBudget">;
  readonly diagnosticsEnabled?: boolean;
  /** Probe relocation tuning; `false` opts out of the relocation record pipeline. */
  readonly relocation?: ProbeRelocationResolverOptions | false;
}
export interface ProbeClipmapRuntimeFrameInput {
  readonly frame?: number;
  readonly viewport: readonly [number, number];
  readonly cameraPosition: ProbeVector3;
  readonly sceneBounds: ProbeAabb | null;
  readonly dirtyBounds?: readonly ProbeAabb[];
  readonly dynamicBounds?: readonly ProbeAabb[];
  readonly options?: Omit<ProbeClipmapOptions, "updateBudget">;
  /** Omit to detect teleports from the committed near-clipmap span. */
  readonly cameraCut?: boolean;
  readonly updateBudget?: number;
  /** Occluder AABBs (deterministic order) fed to the probe relocation solver. */
  readonly relocationOccluders?: readonly ProbeAabb[];
}
export interface ProbeClipmapRuntimeSnapshot {
  readonly frame: number;
  readonly generation: number;
  readonly deviceEpoch: string;
  readonly binding?: WebGpuProbeSamplingBinding;
  readonly frameStats: ProbeClipmapFrameStats;
  readonly captureStats: ProbeCaptureExecutionStats;
  readonly degraded: boolean;
  readonly degradationReasons: readonly string[];
  /** Relocation evidence for the committed plan (offsets solved against this frame). */
  readonly relocation?: ProbeRelocationSnapshotEvidence;
}
export interface ProbeRelocationSnapshotEvidence {
  readonly solvedCount: number;
  readonly changedCount: number;
  readonly recordCount: number;
  readonly dirtyBounds: readonly ProbeAabb[];
}
export interface ProbeClipmapRuntimeFrameResult {
  readonly frame: number;
  readonly status: ProbeClipmapFrameResult["status"] | "failed";
  readonly snapshot?: ProbeClipmapRuntimeSnapshot;
  readonly error?: unknown;
}
export interface ProbeClipmapRuntimeDiagnostic {
  readonly frame: number;
  readonly status: ProbeClipmapRuntimeFrameResult["status"];
  readonly updateCount: number;
  readonly degraded: boolean;
  readonly message?: string;
}

/** Owns the complete CPU-plan to committed WebGPU probe-volume lifecycle for one device epoch. */
export class ProbeClipmapRuntime {
  readonly deviceEpoch: string;
  private readonly resources: ProbeClipmapResources;
  private readonly adapter: WebGpuProbeCaptureAdapter;
  private readonly executor: ProbeClipmapCaptureExecutor<WebGpuProbeCaptureSubmission, WebGpuProbeSamplingBinding>;
  private readonly scheduler: ProbeClipmapUpdateScheduler;
  private readonly capacity: Readonly<{ maxBufferSize: number; maxStorageBufferBindingSize: number }>;
  private readonly clipmap: Omit<ProbeClipmapOptions, "updateBudget">;
  private readonly diagnosticRecords: ProbeClipmapRuntimeDiagnostic[] = [];
  private readonly relocationResolver?: ProbeRelocationResolver;
  private readonly relocationPublisher?: ProbeRelocationPublisher;
  private relocationDirty: ProbeAabb[] = [];
  private snapshot: ProbeClipmapRuntimeSnapshot | undefined;
  private committedCamera: ProbeVector3 | undefined;
  private nextFrame = 0;
  private diagnosticsOn: boolean;
  private terminal: Error | undefined;
  private disposed = false;

  constructor(private readonly session: DeviceSession, deviceEpoch: string,
    options: ProbeClipmapRuntimeOptions = {}) {
    this.deviceEpoch = deviceEpoch;
    this.clipmap = freezeClipmap(options.clipmap ?? {});
    this.diagnosticsOn = options.diagnosticsEnabled === true;
    this.capacity = Object.freeze({ maxBufferSize: session.device.limits.maxBufferSize,
      maxStorageBufferBindingSize: session.device.limits.maxStorageBufferBindingSize });
    const frameBudget = options.frameBudget ?? DEFAULT_PROBE_CLIPMAP_RUNTIME_OPTIONS.frameBudget;
    const cameraCutBudget = options.cameraCutBudget ?? DEFAULT_PROBE_CLIPMAP_RUNTIME_OPTIONS.cameraCutBudget;
    this.resources = new ProbeClipmapResources(session, deviceEpoch);
    this.adapter = new WebGpuProbeCaptureAdapter(session, deviceEpoch, {
      ...(options.fallbackRadiance ? { fallbackRadiance: options.fallbackRadiance } : {}),
      ...(options.encodeSourceRadiance ? { encodeSourceRadiance: options.encodeSourceRadiance } : {}),
      dynamicIrradianceHysteresis: options.dynamicIrradianceHysteresis
        ?? DEFAULT_PROBE_CLIPMAP_RUNTIME_OPTIONS.dynamicIrradianceHysteresis,
      maxTransientBytes: options.maxTransientBytes ?? DEFAULT_PROBE_CLIPMAP_RUNTIME_OPTIONS.maxTransientBytes,
    });
    this.executor = new ProbeClipmapCaptureExecutor(this.resources, this.adapter,
      { maxUpdatesPerBatch: cameraCutBudget, deviceLost: session.device.lost });
    let publisher: ProbeClipmapPlanPublisher = this.executor;
    if (options.relocation !== false) {
      this.relocationResolver = new ProbeRelocationResolver(
        options.relocation === undefined ? {} : options.relocation);
      this.relocationPublisher = new ProbeRelocationPublisher(this.executor, this.relocationResolver);
      publisher = this.relocationPublisher;
    }
    try { this.scheduler = new ProbeClipmapUpdateScheduler(publisher, { frameBudget, cameraCutBudget }); }
    catch (error) { this.executor.dispose(); throw error; }
    void session.device.lost.then(reason => this.handleDeviceLoss(reason),
      reason => this.handleDeviceLoss(reason)).catch(() => undefined);
  }

  get current(): ProbeClipmapRuntimeSnapshot | undefined {
    return !this.disposed && !this.terminal && this.session.state === "ready" ? this.snapshot : undefined;
  }
  get samplingBinding(): WebGpuProbeSamplingBinding | undefined { return this.current?.binding; }
  get diagnostics(): readonly ProbeClipmapRuntimeDiagnostic[] {
    return this.diagnosticsOn ? Object.freeze(this.diagnosticRecords.slice()) : EMPTY_DIAGNOSTICS;
  }
  setDiagnosticsEnabled(enabled: boolean): void {
    this.diagnosticsOn = enabled === true; if (!this.diagnosticsOn) this.diagnosticRecords.length = 0;
  }

  async beginFrame(input: ProbeClipmapRuntimeFrameInput,
    signal?: AbortSignal): Promise<ProbeClipmapRuntimeFrameResult> {
    if (this.disposed) throw new Error("Probe clipmap runtime is disposed.");
    const frame = this.reserveFrame(input.frame);
    if (this.terminal || this.session.state !== "ready") {
      return this.failed(frame, this.terminal ?? new Error("Probe clipmap device session is not ready."));
    }
    const options = freezeClipmap({ ...this.clipmap, ...input.options });
    const cameraCut = input.cameraCut ?? automaticCameraCut(this.committedCamera, input.cameraPosition, options);
    // Relocation dirty evidence from the previous committed frame rides along until a frame
    // commits; a failed/cancelled attempt keeps the stash so no evidence is lost.
    const mergedDirty = this.relocationDirty.length || input.dirtyBounds?.length
      ? [...this.relocationDirty, ...(input.dirtyBounds ?? [])] : undefined;
    this.relocationPublisher?.setFrameOccluders(input.relocationOccluders ?? []);
    try {
      const scheduled = await this.scheduler.submit({ frame, deviceEpoch: this.deviceEpoch,
        viewport: input.viewport, cameraPosition: input.cameraPosition, sceneBounds: input.sceneBounds,
        ...(mergedDirty ? { dirtyBounds: mergedDirty } : {}),
        ...(input.dynamicBounds ? { dynamicBounds: input.dynamicBounds } : {}),
        capacity: this.capacity, options, cameraCut,
        ...(input.updateBudget === undefined ? {} : { frameBudget: input.updateBudget }) }, signal);
      if (this.terminal || this.session.state !== "ready") {
        return this.failed(frame, this.terminal ?? new Error("Probe clipmap device session is not ready."));
      }
      if (scheduled.status !== "committed") {
        return this.result(frame, scheduled.status, this.current, scheduled.error);
      }
      const capture = this.executor.current;
      if (!scheduled.plan || !scheduled.stats || !capture || capture.stats.frame !== frame) {
        throw new Error("Probe clipmap committed without a matching capture snapshot.");
      }
      const binding = scheduled.plan.sceneEmpty ? undefined : capture.published;
      if (scheduled.plan.updates.length && !binding) throw new Error("Probe clipmap capture binding was not published.");
      const relocation = this.relocationEvidence();
      this.relocationDirty = [...(this.relocationResolver?.lastFrame?.dirtyBounds ?? [])];
      const reasons = scheduled.plan.profile.degradationReasons;
      const snapshot = Object.freeze({ frame, generation: scheduled.generation, deviceEpoch: this.deviceEpoch,
        ...(binding ? { binding } : {}), frameStats: scheduled.stats, captureStats: capture.stats,
        degraded: scheduled.plan.profile.degraded, degradationReasons: reasons,
        ...(relocation ? { relocation } : {}) });
      this.snapshot = snapshot; this.committedCamera = Object.freeze([...input.cameraPosition]) as ProbeVector3;
      return this.result(frame, "committed", snapshot);
    } catch (error) { return this.failed(frame, error); }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.snapshot = undefined; this.committedCamera = undefined;
    this.relocationResolver?.reset(); this.relocationDirty = [];
    this.scheduler.dispose(); this.executor.dispose();
  }

  private relocationEvidence(): ProbeRelocationSnapshotEvidence | undefined {
    const evidence = this.relocationResolver?.lastFrame;
    if (!evidence) return undefined;
    return { solvedCount: evidence.solvedCount, changedCount: evidence.changedCount,
      recordCount: evidence.write?.recordCount ?? 0, dirtyBounds: evidence.dirtyBounds };
  }
  private reserveFrame(requested: number | undefined): number {
    const frame = requested ?? this.nextFrame;
    if (!Number.isSafeInteger(frame) || frame < 0) throw new RangeError("frame must be a non-negative integer.");
    this.nextFrame = Math.max(this.nextFrame, frame + 1); return frame;
  }
  private failed(frame: number, error: unknown): ProbeClipmapRuntimeFrameResult {
    return this.result(frame, "failed", this.current, error);
  }
  private result(frame: number, status: ProbeClipmapRuntimeFrameResult["status"],
    snapshot?: ProbeClipmapRuntimeSnapshot, error?: unknown): ProbeClipmapRuntimeFrameResult {
    const value = Object.freeze({ frame, status, ...(snapshot ? { snapshot } : {}),
      ...(error === undefined ? {} : { error }) });
    if (this.diagnosticsOn) {
      if (this.diagnosticRecords.length === DIAGNOSTIC_LIMIT) this.diagnosticRecords.shift();
      const committed = status === "committed";
      this.diagnosticRecords.push(Object.freeze({ frame, status,
        updateCount: committed ? snapshot?.frameStats.updateCount ?? 0 : 0,
        degraded: committed ? snapshot?.degraded ?? false : false,
        ...(error === undefined ? {} : { message: errorMessage(error) }) }));
    }
    return value;
  }
  private handleDeviceLoss(reason: unknown): void {
    if (this.disposed || this.terminal) return;
    this.terminal = new Error(`Probe clipmap device epoch ${this.deviceEpoch} was lost: ${errorMessage(reason)}`);
    this.snapshot = undefined; this.committedCamera = undefined;
    this.relocationResolver?.reset(); this.relocationDirty = [];
    this.scheduler.dispose();
    this.executor.handleDeviceLoss(reason);
  }
}

function freezeClipmap(options: Omit<ProbeClipmapOptions, "updateBudget">): Omit<ProbeClipmapOptions, "updateBudget"> {
  return Object.freeze({ ...options,
    ...(options.gridSize ? { gridSize: Object.freeze([...options.gridSize]) as ProbeGridSize } : {}) });
}
function automaticCameraCut(previous: ProbeVector3 | undefined, current: ProbeVector3,
  options: Omit<ProbeClipmapOptions, "updateBudget">): boolean {
  if (!previous) return false;
  const grid = options.gridSize ?? DEEP_GI_PROBE_CLIPMAP_DEFAULTS.gridSize;
  const spacing = options.baseSpacing ?? DEEP_GI_PROBE_CLIPMAP_DEFAULTS.baseSpacing;
  const threshold = spacing * Math.max(grid[0], grid[2]) * 0.5;
  return current.reduce((sum, value, axis) => sum + (value - previous[axis]!) ** 2, 0) > threshold ** 2;
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
