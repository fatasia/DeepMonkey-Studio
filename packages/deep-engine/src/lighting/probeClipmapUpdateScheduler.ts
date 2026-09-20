import type { ProbeClipmapResourceUpdate } from "./probeClipmapResources.js";
import {
  planIrradianceProbeClipmap,
  type ProbeAabb, type ProbeClipmapCapacity, type ProbeClipmapHistory,
  type ProbeClipmapOptions, type ProbeClipmapPlan, type ProbeUpdate,
  type ProbeVector3,
} from "./probeClipmapPlan.js";

export interface ProbeClipmapPlanPublisher {
  setValidated(plan: ProbeClipmapPlan, deviceEpoch: string,
    signal?: AbortSignal, context?: ProbeClipmapPublicationContext): Promise<ProbeClipmapResourceUpdate>;
}
export interface ProbeClipmapPublicationContext {
  readonly frame: number;
  readonly schedulerGeneration: number;
  readonly frameBudget: number;
  readonly capacityBudget: number;
  readonly cameraCut: boolean;
  readonly invalidation: ProbeClipmapInvalidation;
  /** Indices in `plan.updates` whose irradiance may use temporal history. */
  readonly dynamicUpdateIndices?: readonly number[];
}
export interface ProbeClipmapSchedulerOptions {
  readonly frameBudget?: number;
  readonly cameraCutBudget?: number;
}
export interface ProbeClipmapFrameRequest {
  readonly frame: number;
  readonly deviceEpoch: string;
  readonly viewport: readonly [number, number];
  readonly cameraPosition: ProbeVector3;
  readonly sceneBounds: ProbeAabb | null;
  readonly dirtyBounds?: readonly ProbeAabb[];
  readonly dynamicBounds?: readonly ProbeAabb[];
  readonly capacity?: ProbeClipmapCapacity;
  readonly options?: Omit<ProbeClipmapOptions, "updateBudget">;
  readonly cameraCut?: boolean;
  /** Optional per-frame reduction; cannot exceed the scheduler's admitted budget. */
  readonly frameBudget?: number;
}
export type ProbeClipmapInvalidation = "initial" | "none" | "device-epoch" | "resize";
export type ProbeScheduleClass = "dynamic" | "dirty" | "scroll" | "pending" | "initial";
export interface ProbeClipmapFrameStats {
  readonly frame: number;
  readonly generation: number;
  readonly invalidation: ProbeClipmapInvalidation;
  readonly frameBudget: number;
  readonly capacityBudget: number;
  readonly candidateCount: number;
  readonly updateCount: number;
  readonly deferredCount: number;
  readonly frameCoverage: number;
  readonly residentCoverage: number;
  readonly committedUpdateCount: number;
  readonly updatesByClass: Readonly<Record<ProbeScheduleClass, number>>;
  readonly updatesByLevel: readonly number[];
}
export interface ProbeClipmapFrameResult {
  readonly generation: number;
  readonly frame: number;
  readonly status: "committed" | "superseded" | "cancelled";
  readonly plan?: ProbeClipmapPlan;
  readonly resource?: ProbeClipmapResourceUpdate;
  readonly stats?: ProbeClipmapFrameStats;
  readonly error?: unknown;
}

interface CommittedState {
  readonly deviceEpoch: string;
  readonly viewportKey: string;
  readonly history: ProbeClipmapHistory;
  readonly stats: ProbeClipmapFrameStats;
  readonly fairCursor: number;
  readonly fairCycle: number;
}
interface Classified { readonly update: ProbeUpdate; readonly group: number }

const CLASS_NAMES: readonly ProbeScheduleClass[] = ["dynamic", "dirty", "scroll", "pending", "initial"];
const LEVEL_WHEEL = Object.freeze([0, 0, 0, 0, 1, 1, 2, 3]);
const EPOCH = /^[0-9A-Za-z][0-9A-Za-z._:-]{0,127}$/;

/** Plans and atomically publishes bounded probe work; it does not dispatch probe rendering. */
export class ProbeClipmapUpdateScheduler {
  private readonly frameBudget: number;
  private readonly cameraCutBudget: number;
  private generation = 0;
  private latestFrame = -1;
  private active: AbortController | undefined;
  private committed: CommittedState | undefined;
  private closed = false;

  constructor(private readonly publisher: ProbeClipmapPlanPublisher,
    options: ProbeClipmapSchedulerOptions = {}) {
    this.frameBudget = integer(options.frameBudget ?? 64, "frameBudget");
    this.cameraCutBudget = integer(options.cameraCutBudget ?? Math.ceil(this.frameBudget * 1.5),
      "cameraCutBudget");
    if (this.cameraCutBudget < this.frameBudget || this.cameraCutBudget > this.frameBudget * 2) {
      throw new RangeError("cameraCutBudget must be between frameBudget and twice frameBudget.");
    }
  }

  get current(): ProbeClipmapFrameStats | undefined { return this.committed?.stats; }

  async submit(request: ProbeClipmapFrameRequest,
    signal?: AbortSignal): Promise<ProbeClipmapFrameResult> {
    this.assertRequest(request, signal);
    if (signal?.aborted) return result(++this.generation, request.frame, "cancelled", undefined,
      undefined, undefined, signal.reason);
    const viewportKey = `${request.viewport[0]}x${request.viewport[1]}`;
    const invalidation = this.invalidation(request.deviceEpoch, viewportKey);
    const previous = invalidation === "none" ? this.committed : undefined;
    const fairCursor = previous?.fairCursor ?? 0, fairCycle = previous?.fairCycle ?? 0;
    const plan = this.plan(request, previous?.history, fairCursor, fairCycle);
    const generation = ++this.generation;
    const nextCursor = (fairCursor + plan.updates.length) % LEVEL_WHEEL.length;
    const budget = this.budget(request);
    const stats = createStats(plan, request, generation, invalidation, budget,
      (previous?.stats.committedUpdateCount ?? 0) + plan.updates.length);
    this.latestFrame = request.frame;
    this.active?.abort(abortError("Probe clipmap frame was superseded."));
    const controller = new AbortController(), unlink = signal ? relayAbort(signal, controller) : () => {};
    this.active = controller;
    try {
      const dynamic = request.dynamicBounds ?? [];
      const dynamicUpdateIndices = Object.freeze(plan.updates.flatMap((update, index) =>
        classify(update, dynamic, []) === 0 ? [index] : []));
      const publication = await waitForAbort(
        this.publisher.setValidated(plan, request.deviceEpoch, controller.signal, Object.freeze({
          frame: request.frame, schedulerGeneration: generation,
          frameBudget: stats.frameBudget, capacityBudget: stats.capacityBudget,
          cameraCut: request.cameraCut === true, invalidation, dynamicUpdateIndices,
        })), controller.signal);
      if (generation !== this.generation) return result(generation, request.frame, "superseded",
        plan, undefined, stats, controller.signal.reason);
      if (controller.signal.aborted) return result(generation, request.frame, "cancelled",
        plan, undefined, stats, controller.signal.reason);
      this.committed = Object.freeze({ deviceEpoch: request.deviceEpoch, viewportKey,
        history: plan.history, stats, fairCursor: nextCursor, fairCycle: fairCycle + 1 });
      return result(generation, request.frame, "committed", plan, publication, stats);
    } catch (error) {
      if (generation !== this.generation) return result(generation, request.frame, "superseded",
        plan, undefined, stats, error);
      if (controller.signal.aborted) return result(generation, request.frame, "cancelled",
        plan, undefined, stats, error);
      throw error;
    } finally {
      unlink(); if (this.active === controller) this.active = undefined;
    }
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true; this.generation++;
    this.active?.abort(abortError("Probe clipmap scheduler was disposed.")); this.active = undefined;
    this.committed = undefined;
  }

  private plan(request: ProbeClipmapFrameRequest, previous: ProbeClipmapHistory | undefined,
    fairCursor: number, fairCycle: number): ProbeClipmapPlan {
    const dynamic = request.dynamicBounds ?? [], dirty = request.dirtyBounds ?? [];
    const raw = planIrradianceProbeClipmap({ cameraPosition: request.cameraPosition,
      sceneBounds: request.sceneBounds, dirtyBounds: [...dynamic, ...dirty],
      ...(previous ? { previous } : {}), ...(request.capacity ? { capacity: request.capacity } : {}),
      options: { ...request.options, updateBudget: this.cameraCutBudget } });
    const candidates = [...raw.updates, ...raw.deferred].map(update => ({ update,
      group: classify(update, dynamic, dirty) }));
    const budget = this.budget(request);
    const updates = selectUpdates(candidates, budget, fairCursor, fairCycle, request.cameraPosition);
    const selected = new Set(updates.map(updateKey));
    const deferred = Object.freeze(candidates.filter(item => !selected.has(updateKey(item.update)))
      .sort(compareClassified(request.cameraPosition)).map(item => item.update));
    const history = Object.freeze({ profileKey: raw.history.profileKey, origins: raw.history.origins,
      pending: Object.freeze(deferred.map(update => Object.freeze({ level: update.level, cell: update.cell }))) });
    return Object.freeze({ ...raw, updates: Object.freeze(updates), deferred, history });
  }

  private invalidation(epoch: string, viewportKey: string): ProbeClipmapInvalidation {
    if (!this.committed) return "initial";
    if (this.committed.deviceEpoch !== epoch) return "device-epoch";
    return this.committed.viewportKey === viewportKey ? "none" : "resize";
  }

  private assertRequest(request: ProbeClipmapFrameRequest, signal?: AbortSignal): void {
    if (this.closed) throw new Error("Probe clipmap scheduler is disposed.");
    if (!Number.isSafeInteger(request.frame) || request.frame < 0) throw new RangeError("frame must be non-negative.");
    if (request.frame < this.latestFrame) throw new Error("Probe clipmap frame regressed.");
    if (!EPOCH.test(request.deviceEpoch)) throw new TypeError("deviceEpoch is not canonical.");
    if (!Array.isArray(request.viewport) || request.viewport.length !== 2
      || request.viewport.some(value => !Number.isSafeInteger(value) || value < 1 || value > 65_535)) {
      throw new RangeError("viewport must contain two integers in 1..65535.");
    }
    if (signal !== undefined && !isAbortSignal(signal)) throw new TypeError("signal is invalid.");
    if (request.frameBudget !== undefined) {
      const ceiling = request.cameraCut ? this.cameraCutBudget : this.frameBudget;
      if (!Number.isSafeInteger(request.frameBudget) || request.frameBudget < 1 || request.frameBudget > ceiling) {
        throw new RangeError(`frameBudget must be an integer in [1, ${ceiling}].`);
      }
    }
  }

  private budget(request: ProbeClipmapFrameRequest): number {
    return request.frameBudget ?? (request.cameraCut ? this.cameraCutBudget : this.frameBudget);
  }
}

function selectUpdates(items: readonly Classified[], limit: number, cursor: number, cycle: number,
  camera: ProbeVector3): ProbeUpdate[] {
  const groups = CLASS_NAMES.map((_, group) => items.filter(item => item.group === group)
    .sort(compareClassified(camera)).map(item => item.update));
  const urgent = groups.slice(0, 3).flat(), background = groups.slice(3).flat();
  let reserve = Math.floor(limit / 4);
  if (reserve === 0 && urgent.length && background.length && cycle % 4 === 3) reserve = 1;
  const selected: ProbeUpdate[] = [], used = new Set<string>();
  takeGroups(groups, [0, 1, 2], limit - reserve, cursor, selected, used);
  takeGroups(groups, [3, 4], limit - selected.length, cursor + selected.length, selected, used);
  takeGroups(groups, [0, 1, 2, 3, 4], limit - selected.length, cursor + selected.length, selected, used);
  return selected;
}

function takeGroups(groups: ProbeUpdate[][], order: readonly number[], limit: number,
  cursor: number, output: ProbeUpdate[], used: Set<string>): void {
  for (const group of order) {
    if (limit <= 0) return;
    const queues = Array.from({ length: 4 }, (_, level) => groups[group]!
      .filter(item => item.level === level && !used.has(updateKey(item))));
    while (limit > 0 && queues.some(queue => queue.length)) {
      let found = false;
      for (let step = 0; step < LEVEL_WHEEL.length; step++) {
        const wheel = (cursor + step) % LEVEL_WHEEL.length, queue = queues[LEVEL_WHEEL[wheel]!]!;
        const update = queue.shift();
        if (!update) continue;
        output.push(update); used.add(updateKey(update)); limit--; cursor = wheel + 1; found = true; break;
      }
      if (!found) break;
    }
  }
}

function classify(update: ProbeUpdate, dynamic: readonly ProbeAabb[], dirty: readonly ProbeAabb[]): number {
  if (dynamic.some(box => pointInside(update.position, box))) return 0;
  if (dirty.some(box => pointInside(update.position, box))) return 1;
  return update.reason === "scroll" ? 2 : update.reason === "pending" ? 3 : 4;
}
function pointInside(point: ProbeVector3, box: ProbeAabb): boolean {
  return point.every((value, axis) => value >= box.min[axis]! && value <= box.max[axis]!);
}
function compareClassified(camera: ProbeVector3): (left: Classified, right: Classified) => number {
  return (left, right) => left.group - right.group || left.update.level - right.update.level
    || distance(left.update, camera) - distance(right.update, camera)
    || left.update.cell[0] - right.update.cell[0] || left.update.cell[1] - right.update.cell[1]
    || left.update.cell[2] - right.update.cell[2];
}
function distance(update: ProbeUpdate, camera: ProbeVector3): number {
  return update.position.reduce((sum, value, axis) => sum + (value - camera[axis]!) ** 2, 0);
}
function updateKey(update: ProbeUpdate): string { return `${update.level}:${update.cell.join(":")}`; }

function createStats(plan: ProbeClipmapPlan, request: ProbeClipmapFrameRequest, generation: number,
  invalidation: ProbeClipmapInvalidation, frameBudget: number,
  committedUpdateCount: number): ProbeClipmapFrameStats {
  const all = [...plan.updates, ...plan.deferred], dynamic = request.dynamicBounds ?? [], dirty = request.dirtyBounds ?? [];
  const byClass = Object.fromEntries(CLASS_NAMES.map(name => [name, 0])) as Record<ProbeScheduleClass, number>;
  const byLevel = Array.from({ length: plan.profile.levelCount }, () => 0);
  plan.updates.forEach(update => { byClass[CLASS_NAMES[classify(update, dynamic, dirty)]!]++;
    byLevel[update.level] = (byLevel[update.level] ?? 0) + 1; });
  return Object.freeze({ frame: request.frame, generation, invalidation,
    frameBudget,
    capacityBudget: plan.profile.updateBudget, candidateCount: all.length, updateCount: plan.updates.length,
    deferredCount: plan.deferred.length, frameCoverage: all.length ? plan.updates.length / all.length : 1,
    residentCoverage: plan.profile.probeCount ? 1 - plan.deferred.length / plan.profile.probeCount : 1,
    committedUpdateCount, updatesByClass: Object.freeze(byClass), updatesByLevel: Object.freeze(byLevel) });
}

function integer(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_536) throw new RangeError(`${name} must be in 1..65536.`);
  return value;
}
function isAbortSignal(value: unknown): value is AbortSignal {
  return !!value && typeof value === "object" && typeof (value as AbortSignal).aborted === "boolean"
    && typeof (value as AbortSignal).addEventListener === "function";
}
function relayAbort(source: AbortSignal, target: AbortController): () => void {
  const abort = () => target.abort(source.reason ?? abortError("Probe clipmap frame was cancelled."));
  source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}
async function waitForAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  let reject!: (reason: unknown) => void;
  const aborted = new Promise<never>((_, fail) => { reject = fail; });
  const onAbort = () => reject(signal.reason ?? abortError("Probe clipmap frame was cancelled."));
  signal.addEventListener("abort", onAbort, { once: true });
  try { return await Promise.race([promise, aborted]); }
  finally { signal.removeEventListener("abort", onAbort); }
}
function abortError(message: string): Error { const error = new Error(message); error.name = "AbortError"; return error; }
function result(generation: number, frame: number, status: ProbeClipmapFrameResult["status"],
  plan?: ProbeClipmapPlan, resource?: ProbeClipmapResourceUpdate, stats?: ProbeClipmapFrameStats,
  error?: unknown): ProbeClipmapFrameResult {
  return Object.freeze({ generation, frame, status, ...(plan ? { plan } : {}),
    ...(resource ? { resource } : {}), ...(stats ? { stats } : {}), ...(error === undefined ? {} : { error }) });
}
