import type { ResidentPacketProjection } from "./residentPacketProjection.js";

const candidateBrand: unique symbol = Symbol("ResidentPacketCandidate");

/** Opaque token returned when a complete packet projection is ready to publish. */
export interface ResidentPacketCandidate {
  readonly generation: number;
  readonly [candidateBrand]: true;
}

interface CandidateRecord extends ResidentPacketCandidate {
  readonly projection: ResidentPacketProjection;
}

/**
 * Owns the drawable packet projection across frame boundaries. A caller stages
 * off-frame, then commits the exact returned token immediately before encoding
 * the next frame.
 */
export class ResidentPacketPublisher {
  private activeValue: ResidentPacketProjection | undefined;
  private pendingValue: CandidateRecord | undefined;
  private generationValue = 0;
  private disposedValue = false;
  private transitioning = false;

  get active(): ResidentPacketProjection | undefined { return this.activeValue; }
  get pending(): ResidentPacketCandidate | undefined { return this.pendingValue; }
  get generation(): number { return this.generationValue; }
  get disposed(): boolean { return this.disposedValue; }

  stage(projection: ResidentPacketProjection): ResidentPacketCandidate {
    this.assertMutable();
    validateProjection(projection);
    if (projection === this.activeValue || projection === this.pendingValue?.projection) {
      throw new Error("Resident packet projection is already owned by this publisher.");
    }
    const generation = this.nextGeneration();
    const candidate = Object.freeze({
      generation,
      [candidateBrand]: true as const,
      projection,
    });
    const previous = this.pendingValue;
    this.transitioning = true;
    this.pendingValue = undefined;
    try {
      if (previous) {
        const failures = releaseMany([previous.projection]);
        if (failures.length) {
          failures.push(...releaseMany([projection]));
          throw new AggregateError(failures, "Resident packet candidate supersession failed.");
        }
      }
      this.pendingValue = candidate;
      return candidate;
    } finally {
      this.transitioning = false;
    }
  }

  /** Atomically installs the candidate before retiring the previous active projection. */
  commit(candidate: ResidentPacketCandidate): ResidentPacketProjection {
    const record = this.requirePending(candidate);
    this.transitioning = true;
    this.pendingValue = undefined;
    const previous = this.activeValue;
    this.activeValue = record.projection;
    this.advanceAfterTransition();
    try {
      const failures = previous ? releaseMany([previous]) : [];
      if (failures.length) {
        throw new AggregateError(failures, "Previous resident packet projection release failed.");
      }
      return record.projection;
    } finally {
      this.transitioning = false;
    }
  }

  cancel(candidate: ResidentPacketCandidate): void {
    this.discard(candidate, "Resident packet candidate cancellation failed.");
  }

  fail(candidate: ResidentPacketCandidate): void {
    this.discard(candidate, "Resident packet candidate failure cleanup failed.");
  }

  dispose(): void {
    if (this.disposedValue) return;
    if (this.transitioning) throw new Error("Resident packet publisher is completing another transition.");
    this.disposedValue = true;
    this.transitioning = true;
    const pending = this.pendingValue?.projection;
    const active = this.activeValue;
    this.pendingValue = undefined;
    this.activeValue = undefined;
    this.advanceAfterTransition();
    try {
      const failures = releaseMany([pending, active]);
      if (failures.length) {
        throw new AggregateError(failures, "Resident packet publisher disposal failed.");
      }
    } finally {
      this.transitioning = false;
    }
  }

  private discard(candidate: ResidentPacketCandidate, message: string): void {
    const record = this.requirePending(candidate);
    this.transitioning = true;
    this.pendingValue = undefined;
    this.advanceAfterTransition();
    try {
      const failures = releaseMany([record.projection]);
      if (failures.length) throw new AggregateError(failures, message);
    } finally {
      this.transitioning = false;
    }
  }

  private requirePending(candidate: ResidentPacketCandidate): CandidateRecord {
    this.assertMutable();
    const pending = this.pendingValue;
    if (!pending || candidate !== pending || candidate.generation !== pending.generation
      || candidate[candidateBrand] !== true) {
      throw new Error("Resident packet candidate is stale or foreign.");
    }
    if (pending.projection.released) {
      this.pendingValue = undefined;
      this.advanceAfterTransition();
      throw new Error("Resident packet candidate was released before publication.");
    }
    return pending;
  }

  private assertMutable(): void {
    if (this.disposedValue) throw new Error("Resident packet publisher is disposed.");
    if (this.transitioning) throw new Error("Resident packet publisher is completing another transition.");
  }

  private nextGeneration(): number {
    if (this.generationValue >= Number.MAX_SAFE_INTEGER) {
      throw new Error("Resident packet publisher generation is exhausted.");
    }
    this.generationValue++;
    return this.generationValue;
  }

  private advanceAfterTransition(): void {
    if (this.generationValue < Number.MAX_SAFE_INTEGER) this.generationValue++;
  }
}

function validateProjection(projection: ResidentPacketProjection): void {
  if (!projection || typeof projection !== "object" || typeof projection.release !== "function") {
    throw new TypeError("Resident packet projection is invalid.");
  }
  if (projection.released) throw new Error("Resident packet projection is already released.");
}

function releaseMany(
  projections: readonly (ResidentPacketProjection | undefined)[],
): unknown[] {
  const failures: unknown[] = [];
  const released = new Set<ResidentPacketProjection>();
  for (const projection of projections) {
    if (!projection || released.has(projection)) continue;
    released.add(projection);
    try { projection.release(); }
    catch (error) { failures.push(error); }
  }
  return failures;
}
