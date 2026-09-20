import type {
  FrameCaptureRecord,
  FrameCaptureSession,
  FrameCaptureSourceMapRef,
  PassCaptureInput,
} from "../r12/frameCapture.js";
import type { DeepShaderPackageV2 } from "../shaderPackage/types.js";
import { frameCaptureSourceMapRefsByPass, type FrameCaptureShaderPassBinding } from "../r12/shaderSourceMap.js";
import type { PbrActualPassDescription } from "./pbrFramePlanResources.js";
import type { PbrFrameExecutionPlan } from "./pbrFramePlanExecutor.js";
import { PbrFrameReadbackPlan, type PbrFrameReadbackPlanOptions,
  type PbrFrameReadbackResourceId, type PbrFrameReadbackResult } from "./pbrFrameCaptureReadback.js";

/** Optional R12 bridge for a real PBR render loop. It is intentionally absent from default runs. */
export interface PbrFrameCaptureOptions {
  readonly session: FrameCaptureSession;
  /** Host-supplied monotonic clock; PbrRenderer supplies its performance clock by default. */
  readonly now?: () => number;
  /** Standalone adapter source refs; built-in PbrRenderer rejects externally supplied provenance. */
  readonly sourceMapRefsByPass?: ReadonlyMap<string, readonly FrameCaptureSourceMapRef[]>;
  /** Standalone adapter package; the caller must execute it. Built-in PbrRenderer rejects this option. */
  readonly shaderPackage?: Pick<DeepShaderPackageV2, "passes">;
  /** Standalone capture-pass → executed shader-package-pass bindings; IDs are never guessed. */
  readonly shaderPassBindings?: readonly FrameCaptureShaderPassBinding[];
  /** Bounded per-frame resource snapshots from the fixed readback whitelist; diagnostic hosts only. */
  readonly readbacks?: PbrFrameReadbackPlanOptions;
  /** Receives each frame's snapshot results after submit resolution; failures arrive as unavailable records. */
  readonly onReadbackResults?: (results: readonly PbrFrameReadbackResult[]) => void;
}

export function pbrCapturePassInput(description: PbrActualPassDescription,
  sourceMapRefsByPass?: ReadonlyMap<string, readonly FrameCaptureSourceMapRef[]>): PassCaptureInput {
  const sourceMapRefs = sourceMapRefsByPass?.get(description.passId);
  return {
    passId: description.passId,
    kind: description.kind,
    executor: description.executor,
    reads: description.reads,
    writes: description.writes,
    ...(sourceMapRefs === undefined ? {} : { sourceMapRefs }),
  };
}

/**
 * Owns only the capture transaction. GPU commands remain in PbrRenderer; a failed encode or submit
 * cancels the transaction so a partial frame can never look committed.
 */
export class PbrFrameCapture {
  private readonly now: () => number;
  private readonly sourceMapRefsByPass: ReadonlyMap<string, readonly FrameCaptureSourceMapRef[]> | undefined;
  private readonly readbackPlan: PbrFrameReadbackPlan | undefined;
  private currentFrameId: string | undefined;

  constructor(private readonly options: PbrFrameCaptureOptions, ownership?: { readonly builtinRenderer: true }) {
    if (!options || typeof options !== "object" || !options.session
      || typeof options.session.beginFrame !== "function"
      || typeof options.session.recordPass !== "function"
      || typeof options.session.endFrame !== "function"
      || typeof options.session.cancelFrame !== "function") {
      throw new TypeError("PBR frame capture requires a FrameCaptureSession.");
    }
    const hasPackage = options.shaderPackage !== undefined;
    const hasBindings = options.shaderPassBindings !== undefined;
    if (ownership?.builtinRenderer && (hasPackage || hasBindings || options.sourceMapRefsByPass !== undefined)) {
      throw new TypeError("Built-in PBR capture rejects external shader provenance; only executed pipeline sources are accepted.");
    }
    if (hasPackage !== hasBindings) {
      throw new TypeError("PBR frame capture shaderPackage and shaderPassBindings must be provided together.");
    }
    if (hasPackage && options.sourceMapRefsByPass !== undefined) {
      throw new TypeError("PBR frame capture accepts either sourceMapRefsByPass or shader package bindings, not both.");
    }
    this.sourceMapRefsByPass = hasPackage
      ? frameCaptureSourceMapRefsByPass(options.shaderPackage!, options.shaderPassBindings!)
      : options.sourceMapRefsByPass;
    if (typeof options.now !== "function") throw new TypeError("Frame capture requires a host-supplied monotonic clock.");
    this.now = options.now;
    this.readbackPlan = options.readbacks === undefined ? undefined : new PbrFrameReadbackPlan(options.readbacks);
  }

  get session(): FrameCaptureSession { return this.options.session; }

  begin(frameId: string, plan: PbrFrameExecutionPlan): void {
    // A rejected begin must not cancel a transaction owned by another caller.
    this.options.session.beginFrame(frameId, this.now(), plan.planHash);
    this.currentFrameId = frameId;
    try {
      this.options.session.markTimeline({ markerId: "encode-start", label: "render-loop encode start", timestampMs: this.now() });
    } catch (error) {
      this.currentFrameId = undefined;
      this.options.session.cancelFrame();
      throw error;
    }
  }

  /** Encodes whitelisted resource snapshots on the frame encoder; must run before encoder.finish(). */
  encodeReadbacks(encoder: GPUCommandEncoder, device: GPUDevice,
    textures: Readonly<Record<PbrFrameReadbackResourceId, GPUTexture | undefined>>): void {
    if (this.readbackPlan === undefined) return;
    if (this.currentFrameId === undefined) throw new Error("PBR frame capture readbacks require an open capture frame.");
    this.readbackPlan.beginFrame(this.currentFrameId, device, encoder, textures);
  }

  /** Callers must only invoke this after the frame's queue.submit resolved. */
  collectReadbacksAfterSubmit(): Promise<readonly PbrFrameReadbackResult[]> | undefined {
    const collecting = this.readbackPlan?.collectAfterSubmit();
    if (collecting !== undefined && this.options.onReadbackResults !== undefined) {
      const deliver = this.options.onReadbackResults;
      void collecting.then(results => { try { deliver(results); } catch { /* host listener must never break the render loop. */ } });
    }
    return collecting;
  }

  recordPasses(actual: readonly PbrActualPassDescription[], executedPassIds?: ReadonlySet<string>,
    presentSourceMapRefs?: readonly FrameCaptureSourceMapRef[]): void {
    if (presentSourceMapRefs && this.sourceMapRefsByPass?.has("present")) {
      throw new Error("Executed present shader provenance conflicts with external source-map configuration.");
    }
    for (const description of actual) {
      if (executedPassIds && !executedPassIds.has(description.passId)) continue;
      const input = pbrCapturePassInput(description, this.sourceMapRefsByPass);
      this.options.session.recordPass(description.passId === "present" && presentSourceMapRefs
        ? { ...input, sourceMapRefs: presentSourceMapRefs } : input);
    }
  }

  mark(markerId: string, label: string): void {
    this.options.session.markTimeline({ markerId, label, timestampMs: this.now() });
  }

  end(): FrameCaptureRecord {
    this.currentFrameId = undefined;
    return this.options.session.endFrame(this.now());
  }

  cancel(): void {
    this.currentFrameId = undefined;
    this.readbackPlan?.cancel();
    this.options.session.cancelFrame();
  }
}
