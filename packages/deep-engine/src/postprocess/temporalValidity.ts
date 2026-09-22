export type TemporalConsumer = "taa" | "ssr" | "ddgi" | "volumetric-fog" | "contact-shadow";

export type TemporalInvalidationReason =
  | "no-history" | "revision-gap" | "camera-cut" | "resize"
  | "motion-unavailable" | "depth-unavailable" | "disocclusion"
  | "material-change" | "light-change" | "exposure-change" | "reactive-mask-unavailable";

export interface TemporalValidityFrame {
  readonly revision: number;
  readonly width: number;
  readonly height: number;
  readonly cameraCut: boolean;
  readonly motionAvailable: boolean;
  readonly depthAvailable: boolean;
  readonly disoccluded?: boolean;
  readonly materialRevision?: number;
  readonly lightRevision?: number;
  readonly exposure?: number;
  readonly reactiveMaskAvailable?: boolean;
}

export interface TemporalValidityDecision {
  readonly valid: boolean;
  readonly reasons: readonly TemporalInvalidationReason[];
}

export interface TemporalValidityPlan {
  readonly revision: number;
  readonly decisions: Readonly<Record<TemporalConsumer, TemporalValidityDecision>>;
}

/**
 * Shared, fail-closed temporal-history gate. beginFrame is side-effect free with
 * respect to committed history; publish only after queue.submit succeeds.
 */
export class TemporalValidityProvider {
  private committed: Readonly<TemporalValidityFrame> | undefined;
  private pending: Readonly<TemporalValidityFrame> | undefined;

  beginFrame(frame: TemporalValidityFrame): TemporalValidityPlan {
    validateFrame(frame);
    if (this.pending) throw new Error("Temporal validity already has a pending frame.");
    const frozen = Object.freeze({ ...frame });
    this.pending = frozen;
    const common = commonReasons(this.committed, frozen);
    const decisions = Object.freeze({
      taa: decision(common, exposureReason(this.committed?.exposure, frozen.exposure)),
      ssr: decision(common, revisionReason(this.committed?.materialRevision, frozen.materialRevision, "material-change"),
        exposureReason(this.committed?.exposure, frozen.exposure)),
      ddgi: decision(worldSpaceReasons(this.committed, frozen),
        revisionReason(this.committed?.materialRevision, frozen.materialRevision, "material-change"),
        revisionReason(this.committed?.lightRevision, frozen.lightRevision, "light-change")),
      "volumetric-fog": decision(common,
        revisionReason(this.committed?.lightRevision, frozen.lightRevision, "light-change"),
        exposureReason(this.committed?.exposure, frozen.exposure)),
      "contact-shadow": decision(common,
        revisionReason(this.committed?.lightRevision, frozen.lightRevision, "light-change"),
        frozen.reactiveMaskAvailable === true ? undefined : "reactive-mask-unavailable"),
    } satisfies Record<TemporalConsumer, TemporalValidityDecision>);
    return Object.freeze({ revision: frame.revision, decisions });
  }

  commitFrame(revision: number): void {
    if (!this.pending || this.pending.revision !== revision) throw new Error("Temporal validity commit does not match the pending frame.");
    this.committed = this.pending;
    this.pending = undefined;
  }

  cancelFrame(revision: number): void {
    if (this.pending?.revision === revision) this.pending = undefined;
  }

  reset(): void { this.pending = undefined; this.committed = undefined; }
}

function validateFrame(frame: TemporalValidityFrame): void {
  if (!Number.isSafeInteger(frame.revision) || frame.revision < 0) throw new Error("Temporal revision must be a nonnegative safe integer.");
  if (![frame.width, frame.height].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error("Temporal dimensions must be positive safe integers.");
  if (typeof frame.cameraCut !== "boolean" || typeof frame.motionAvailable !== "boolean" || typeof frame.depthAvailable !== "boolean") {
    throw new Error("Temporal camera, motion, and depth flags must be boolean.");
  }
  for (const [name, value] of [["material", frame.materialRevision], ["light", frame.lightRevision]] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new Error(`Temporal ${name} revision must be a nonnegative safe integer.`);
  }
  if (frame.exposure !== undefined && (!Number.isFinite(frame.exposure) || frame.exposure <= 0)) throw new Error("Temporal exposure must be finite and positive.");
}

function baseReasons(previous: Readonly<TemporalValidityFrame> | undefined,
  current: Readonly<TemporalValidityFrame>): TemporalInvalidationReason[] {
  if (!previous) return ["no-history"];
  const reasons: TemporalInvalidationReason[] = [];
  if (current.revision !== previous.revision + 1) reasons.push("revision-gap");
  if (current.cameraCut) reasons.push("camera-cut");
  if (current.width !== previous.width || current.height !== previous.height) reasons.push("resize");
  return reasons;
}

function commonReasons(previous: Readonly<TemporalValidityFrame> | undefined,
  current: Readonly<TemporalValidityFrame>): TemporalInvalidationReason[] {
  const reasons = baseReasons(previous, current);
  if (!current.motionAvailable) reasons.push("motion-unavailable");
  if (!current.depthAvailable) reasons.push("depth-unavailable");
  if (current.disoccluded === true) reasons.push("disocclusion");
  return reasons;
}

function worldSpaceReasons(previous: Readonly<TemporalValidityFrame> | undefined,
  current: Readonly<TemporalValidityFrame>): TemporalInvalidationReason[] {
  if (!previous) return ["no-history"];
  return current.revision === previous.revision + 1 ? [] : ["revision-gap"];
}

function revisionReason(previous: number | undefined, current: number | undefined,
  reason: "material-change" | "light-change"): TemporalInvalidationReason | undefined {
  return previous === undefined || current === undefined || previous !== current ? reason : undefined;
}

function exposureReason(previous: number | undefined, current: number | undefined): TemporalInvalidationReason | undefined {
  if (previous === undefined || current === undefined) return "exposure-change";
  return Math.abs(Math.log2(current / previous)) > 0.01 ? "exposure-change" : undefined;
}

function decision(...parts: readonly (readonly TemporalInvalidationReason[] | TemporalInvalidationReason | undefined)[]): TemporalValidityDecision {
  const reasons = Object.freeze(parts.flatMap(part => part === undefined ? [] : Array.isArray(part) ? part : [part]));
  return Object.freeze({ valid: reasons.length === 0, reasons });
}
