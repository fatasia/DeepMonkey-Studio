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

/** Optional R12 bridge for a real PBR render loop. It is intentionally absent from default runs. */
export interface PbrFrameCaptureOptions {
  readonly session: FrameCaptureSession;
  /** A monotonic clock in milliseconds; defaults to the browser performance clock. */
  readonly now?: () => number;
  /** Standalone adapter source refs; built-in PbrRenderer rejects externally supplied provenance. */
  readonly sourceMapRefsByPass?: ReadonlyMap<string, readonly FrameCaptureSourceMapRef[]>;
  /** Standalone adapter package; the caller must execute it. Built-in PbrRenderer rejects this option. */
  readonly shaderPackage?: Pick<DeepShaderPackageV2, "passes">;
  /** Standalone capture-pass → executed shader-package-pass bindings; IDs are never guessed. */
  readonly shaderPassBindings?: readonly FrameCaptureShaderPassBinding[];
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
    this.now = options.now ?? (() => performance.now());
  }

  get session(): FrameCaptureSession { return this.options.session; }

  begin(frameId: string, plan: PbrFrameExecutionPlan): void {
    // A rejected begin must not cancel a transaction owned by another caller.
    this.options.session.beginFrame(frameId, this.now(), plan.planHash);
    try {
      this.options.session.markTimeline({ markerId: "encode-start", label: "render-loop encode start", timestampMs: this.now() });
    } catch (error) {
      this.options.session.cancelFrame();
      throw error;
    }
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
    return this.options.session.endFrame(this.now());
  }

  cancel(): void {
    this.options.session.cancelFrame();
  }
}
