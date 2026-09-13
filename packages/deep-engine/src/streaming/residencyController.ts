import type {
  ResidentResourceState, ResidencyBudgets, ResidencyCommitResult, ResidencyEviction, ResidencyFramePlan,
  ResidencyRequest, ResidencySelection, ResidencySelectionReason, ResidencyUpload, StreamedResourceProfile,
} from "./types.js";
import { validateBudgets, validateProfile, validateRequests, type ValidatedRequest } from "./validation.js";

interface PlannedTarget {
  readonly request: ValidatedRequest;
  level: number | null;
  reason: ResidencySelectionReason;
}

/**
 * Plans whole-resource LOD/mip variant swaps within stable, upload and transition-peak budgets.
 * The controller only changes confirmed state in commit(), after the host reports successful uploads.
 */
export class ResourceResidencyController {
  readonly budgets: Readonly<Required<ResidencyBudgets>>;
  private readonly profiles = new Map<string, Readonly<StreamedResourceProfile>>();
  private readonly residents = new Map<string, ResidentResourceState>();
  private revisionValue = 0;
  private planSequence = 0;
  private latestPlan: ResidencyFramePlan | null = null;
  private activePlan: ResidencyFramePlan | null = null;

  constructor(budgets: ResidencyBudgets) { this.budgets = validateBudgets(budgets); }

  get revision(): number { return this.revisionValue; }
  get residentBytes(): number { return sumBytes(this.residents.values()); }
  get resourceCount(): number { return this.profiles.size; }

  profile(id: string): Readonly<StreamedResourceProfile> | undefined { return this.profiles.get(id); }
  isCurrentPlan(plan: ResidencyFramePlan): boolean { return plan === this.latestPlan; }

  claimPlan(plan: ResidencyFramePlan): void {
    if (plan !== this.latestPlan || this.activePlan) throw new Error("Residency plan is stale or already executing.");
    this.activePlan = plan;
  }

  register(profile: StreamedResourceProfile): void {
    this.assertMutable();
    const validated = validateProfile(profile);
    const previous = this.profiles.get(validated.id);
    if (!previous && this.profiles.size >= this.budgets.maxResources) throw new RangeError("Streamed resource registry is full.");
    if (previous && validated.revision < previous.revision) throw new Error(`Resource revision regressed: ${validated.id}.`);
    if (previous && validated.revision === previous.revision && !sameProfile(previous, validated)) {
      throw new Error(`Resource content changed without a revision change: ${validated.id}.`);
    }
    this.profiles.set(validated.id, validated);
    this.latestPlan = null;
  }

  /** Removes only a non-resident profile; GPU-backed state must first be evicted by an executed plan. */
  remove(id: string): ResidentResourceState | undefined {
    this.assertMutable();
    const previous = this.residents.get(id);
    if (previous) throw new Error(`Cannot remove resident resource before eviction: ${id}.`);
    this.profiles.delete(id);
    this.latestPlan = null;
    return undefined;
  }

  snapshot(): readonly ResidentResourceState[] {
    return Object.freeze([...this.residents.values()].sort((a, b) => a.id.localeCompare(b.id)).map((state) => Object.freeze({ ...state })));
  }

  planFrame(frame: number, requests: readonly ResidencyRequest[]): ResidencyFramePlan {
    this.assertMutable();
    if (!Number.isSafeInteger(frame) || frame < 0) throw new RangeError("Residency frame must be a non-negative integer.");
    const validated = validateRequests(requests, this.profiles, this.budgets.maxResources);
    const targets = chooseStableTargets(validated, this.profiles, this.budgets.maxResidentBytes);
    const targetById = new Map(targets.map((target) => [target.request.id, target] as const));
    const requestedIds = new Set(validated.map((request) => request.id));
    const retained = [...this.residents.values()]
      .filter((state) => !requestedIds.has(state.id) && frame - state.lastUsedFrame <= this.budgets.retainFrames)
      .sort((a, b) => b.lastUsedFrame - a.lastUsedFrame || a.id.localeCompare(b.id));
    let targetBytes = targets.reduce((sum, item) => sum + targetBytesFor(item, this.profiles), 0);
    const retainedIds = new Set<string>();
    for (const state of retained) {
      if (targetBytes + state.byteLength > this.budgets.maxResidentBytes) continue;
      retainedIds.add(state.id); targetBytes += state.byteLength;
    }

    const evictions: ResidencyEviction[] = [];
    let workingBytes = this.residentBytes;
    for (const state of this.residents.values()) {
      const target = targetById.get(state.id);
      if ((target?.level ?? null) !== null || retainedIds.has(state.id)) continue;
      evictions.push(eviction(state, "before-upload")); workingBytes -= state.byteLength;
    }

    const uploads: ResidencyUpload[] = [];
    let uploadBytes = 0, transitionPeakBytes = workingBytes, stableAfterBytes = workingBytes;
    const transitions = targets.filter((target) => target.level !== null)
      .sort((a, b) => transitionOrder(a, b, this.profiles, this.residents));
    for (const target of transitions) {
      const profile = this.profiles.get(target.request.id)!;
      const resident = this.residents.get(target.request.id);
      const level = target.level!;
      if (resident?.revision === profile.revision && resident.level === level) continue;
      const bytes = profile.levels[level]!.byteLength;
      if (uploadBytes + bytes > this.budgets.maxUploadBytesPerFrame) {
        target.level = resident?.level ?? null; target.reason = "upload-budget"; continue;
      }
      // Old resources stay drawable until the batch is committed. Reserving every candidate here
      // keeps the reported peak valid even if uploads run concurrently or one replacement fails.
      if (transitionPeakBytes + bytes > this.budgets.maxResidentBytes) {
        target.level = resident?.level ?? null; target.reason = "transition-headroom"; continue;
      }
      uploads.push(Object.freeze({ id: profile.id, kind: profile.kind,
        fromRevision: resident?.revision ?? null, fromLevel: resident?.level ?? null,
        toRevision: profile.revision, toLevel: level, byteLength: bytes }));
      uploadBytes += bytes; transitionPeakBytes += bytes; stableAfterBytes += bytes;
      if (resident) { evictions.push(eviction(resident, "after-swap")); stableAfterBytes -= resident.byteLength; }
    }

    const selections = targets.map((target): ResidencySelection => Object.freeze({
      id: target.request.id, requestedLevel: target.request.desiredLevel, targetLevel: target.level, reason: target.reason,
    })).sort((a, b) => a.id.localeCompare(b.id));
    const id = ++this.planSequence;
    const plan = Object.freeze({ id, baseRevision: this.revisionValue, frame, selections: Object.freeze(selections),
      uploads: Object.freeze(uploads), evictions: Object.freeze(evictions), residentBytesBefore: this.residentBytes,
      residentBytesAfter: stableAfterBytes, transitionPeakBytes, uploadBytes });
    this.latestPlan = plan;
    return plan;
  }

  commit(plan: ResidencyFramePlan, successfulUploadIds: ReadonlySet<string>): ResidencyCommitResult {
    if (!plan || plan !== this.latestPlan || plan.baseRevision !== this.revisionValue
      || (this.activePlan !== null && this.activePlan !== plan)) throw new Error("Residency plan is stale.");
    if (!(successfulUploadIds instanceof Set)) throw new TypeError("Successful uploads must be a Set.");
    const planned = new Set(plan.uploads.map((upload) => upload.id));
    for (const id of successfulUploadIds) if (!planned.has(id)) throw new Error(`Upload was not part of this plan: ${id}.`);
    const applied: string[] = [], failed: string[] = [], evicted: string[] = [];
    const appliedSet = new Set<string>();
    for (const item of plan.evictions) {
      if (item.phase !== "before-upload") continue;
      const current = this.residents.get(item.id);
      if (sameResident(current, item)) { this.residents.delete(item.id); evicted.push(item.id); }
    }
    for (const upload of plan.uploads) {
      if (!successfulUploadIds.has(upload.id)) { failed.push(upload.id); continue; }
      const current = this.residents.get(upload.id);
      if ((current?.revision ?? null) !== upload.fromRevision || (current?.level ?? null) !== upload.fromLevel) throw new Error("Resident state changed during upload.");
      this.residents.set(upload.id, Object.freeze({ id: upload.id, kind: upload.kind,
        revision: upload.toRevision, level: upload.toLevel,
        byteLength: upload.byteLength, lastUsedFrame: plan.frame }));
      applied.push(upload.id); appliedSet.add(upload.id);
      if (upload.fromRevision !== null) evicted.push(upload.id);
    }
    for (const selection of plan.selections) {
      const state = this.residents.get(selection.id);
      if (state && !appliedSet.has(selection.id)) this.residents.set(selection.id, Object.freeze({ ...state, lastUsedFrame: plan.frame }));
    }
    this.latestPlan = null; this.activePlan = null; this.revisionValue += 1;
    return Object.freeze({ revision: this.revisionValue, residentBytes: this.residentBytes,
      appliedUploads: Object.freeze(applied), failedUploads: Object.freeze(failed), evicted: Object.freeze(evicted) });
  }

  /** Cancels a claimed plan before any owned GPU resource was changed. */
  cancelPlan(plan: ResidencyFramePlan): ResidencyCommitResult {
    if (!plan || plan !== this.latestPlan || plan.baseRevision !== this.revisionValue
      || this.activePlan !== plan) throw new Error("Residency plan is stale.");
    this.latestPlan = null; this.activePlan = null; this.revisionValue += 1;
    return Object.freeze({ revision: this.revisionValue, residentBytes: this.residentBytes,
      appliedUploads: Object.freeze([]),
      failedUploads: Object.freeze(plan.uploads.map(upload => upload.id)),
      evicted: Object.freeze([]) });
  }

  /** Executor terminal path: every confirmed GPU handle is gone, while profiles remain reusable. */
  resetResidency(): void {
    this.residents.clear(); this.latestPlan = null; this.activePlan = null; this.revisionValue += 1;
  }

  private assertMutable(): void {
    if (this.activePlan) throw new Error("Residency controller is executing a GPU plan.");
  }
}

function chooseStableTargets(requests: readonly ValidatedRequest[], profiles: ReadonlyMap<string, Readonly<StreamedResourceProfile>>,
  budget: number): PlannedTarget[] {
  const ranked = [...requests].sort((a, b) => Number(b.required) - Number(a.required) || b.priority - a.priority || a.id.localeCompare(b.id));
  let used = 0;
  return ranked.map((request) => {
    const profile = profiles.get(request.id)!;
    let level = request.desiredLevel;
    while (level < profile.levels.length && used + profile.levels[level]!.byteLength > budget) level += 1;
    if (level >= profile.levels.length) return { request, level: null, reason: "resident-budget" };
    used += profile.levels[level]!.byteLength;
    return { request, level, reason: level === request.desiredLevel ? "requested" : "quality-reduced" };
  });
}

function transitionOrder(a: PlannedTarget, b: PlannedTarget, profiles: ReadonlyMap<string, Readonly<StreamedResourceProfile>>,
  residents: ReadonlyMap<string, ResidentResourceState>): number {
  const delta = (item: PlannedTarget) => profiles.get(item.request.id)!.levels[item.level!]!.byteLength - (residents.get(item.request.id)?.byteLength ?? 0);
  return delta(a) - delta(b) || Number(b.request.required) - Number(a.request.required)
    || b.request.priority - a.request.priority || a.request.id.localeCompare(b.request.id);
}
function targetBytesFor(target: PlannedTarget, profiles: ReadonlyMap<string, Readonly<StreamedResourceProfile>>): number {
  return target.level === null ? 0 : profiles.get(target.request.id)!.levels[target.level]!.byteLength;
}
function eviction(state: ResidentResourceState, phase: ResidencyEviction["phase"]): ResidencyEviction {
  return Object.freeze({ id: state.id, kind: state.kind,
    revision: state.revision, level: state.level, byteLength: state.byteLength, phase });
}
function sameResident(state: ResidentResourceState | undefined, item: ResidencyEviction): boolean {
  return !!state && state.kind === item.kind && state.revision === item.revision && state.level === item.level;
}
function sameProfile(left: Readonly<StreamedResourceProfile>, right: Readonly<StreamedResourceProfile>): boolean {
  return left.kind === right.kind && left.levels.length === right.levels.length
    && left.levels.every((level, index) => level.byteLength === right.levels[index]!.byteLength);
}
function sumBytes(states: Iterable<ResidentResourceState>): number {
  let total = 0; for (const state of states) total += state.byteLength; return total;
}
