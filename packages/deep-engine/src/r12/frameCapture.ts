export const FRAME_CAPTURE_SCHEMA = "deep-engine.frame-capture" as const;
export const FRAME_CAPTURE_SCHEMA_VERSION = 1 as const;

export type FrameCaptureStage = "vertex" | "fragment";

export interface FrameCaptureSourceMapRef {
  readonly moduleId: string;
  readonly stage: FrameCaptureStage;
  readonly nodeId: string;
  readonly generatedLine: number;
}

export interface FrameCaptureSourceMapQuery {
  readonly moduleId?: string;
  readonly stage?: FrameCaptureStage;
  readonly nodeId?: string;
  readonly generatedLine?: number;
}

export interface FrameCaptureSourceMapMatch {
  readonly frameId: string;
  readonly passId: string;
  readonly sourceMap: FrameCaptureSourceMapRef;
}

export interface FrameCaptureDispatchMetadata {
  readonly kind: "dispatch";
  readonly workgroups: readonly [number, number, number];
}

export interface FrameCaptureDrawMetadata {
  readonly kind: "draw";
  readonly vertexCount?: number;
  readonly indexCount?: number;
  readonly instanceCount: number;
  readonly firstVertex?: number;
  readonly firstIndex?: number;
  readonly baseVertex?: number;
  readonly firstInstance?: number;
}

export type FrameCaptureExecutionMetadata =
  | FrameCaptureDispatchMetadata
  | FrameCaptureDrawMetadata;

export interface PassCaptureInput {
  readonly passId: string;
  readonly kind: string;
  /** Stable encode owner, when the producer can identify one. */
  readonly executor?: string;
  readonly reads: readonly string[];
  readonly writes: readonly string[];
  readonly execution?: FrameCaptureExecutionMetadata;
  readonly durationMs?: number;
  readonly sourceMapRefs?: readonly FrameCaptureSourceMapRef[];
}

export interface PassCapture {
  readonly passId: string;
  readonly kind: string;
  readonly executor?: string;
  readonly reads: readonly string[];
  readonly writes: readonly string[];
  readonly execution?: FrameCaptureExecutionMetadata;
  readonly durationMs?: number;
  readonly sourceMapRefs: readonly FrameCaptureSourceMapRef[];
}

export interface FrameCaptureTimelineMarkerInput {
  readonly markerId: string;
  readonly label: string;
  readonly timestampMs: number;
}

export interface FrameCaptureTimelineMarker extends FrameCaptureTimelineMarkerInput {
  readonly frameId: string;
}

export interface FrameCaptureRecordInput {
  readonly frameId: string;
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly passes: readonly PassCaptureInput[];
  readonly markers?: readonly FrameCaptureTimelineMarkerInput[];
  readonly planHash?: string;
}

export interface FrameCaptureRecord {
  readonly schema: typeof FRAME_CAPTURE_SCHEMA;
  readonly schemaVersion: typeof FRAME_CAPTURE_SCHEMA_VERSION;
  readonly frameId: string;
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly passes: readonly PassCapture[];
  readonly markers: readonly FrameCaptureTimelineMarker[];
  readonly planHash?: string;
}

export interface FrameCaptureTimelineRange {
  readonly frames: readonly FrameCaptureRecord[];
  readonly markers: readonly FrameCaptureTimelineMarker[];
}

export interface FrameCaptureBudget {
  readonly maxFrames: number;
  readonly maxPassesPerFrame: number;
  readonly maxMarkersPerFrame: number;
  readonly maxSourceMapRefsPerPass: number;
  readonly maxStringLength: number;
}

export const FRAME_CAPTURE_DEFAULT_BUDGET: FrameCaptureBudget = Object.freeze({
  maxFrames: 120,
  maxPassesPerFrame: 512,
  maxMarkersPerFrame: 256,
  maxSourceMapRefsPerPass: 1024,
  maxStringLength: 256,
});

const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_.:/-]*$/u;
const STAGES = new Set<FrameCaptureStage>(["vertex", "fragment"]);
const BUDGET_KEYS: readonly (keyof FrameCaptureBudget)[] = [
  "maxFrames", "maxPassesPerFrame", "maxMarkersPerFrame", "maxSourceMapRefsPerPass", "maxStringLength",
];

type ActiveFrame = {
  readonly frameId: string;
  readonly startedAtMs: number;
  readonly planHash?: string;
  readonly passes: PassCaptureInput[];
  readonly markers: FrameCaptureTimelineMarkerInput[];
};

function fail(message: string): never {
  throw new Error(`Frame capture input rejected: ${message}`);
}

function requireId(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || !ID_PATTERN.test(value)
    || value === "__proto__" || value === "constructor" || value === "prototype") {
    fail(`${field} must be a bounded identifier.`);
  }
  return value;
}

function requireText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    fail(`${field} must be a non-empty bounded string.`);
  }
  return value;
}

function requireTimestamp(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${field} must be finite.`);
  return value;
}

function requireInteger(value: unknown, field: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum) {
    fail(`${field} must be an integer >= ${minimum}.`);
  }
  return value;
}

function normalizeBudget(input: Partial<FrameCaptureBudget> | undefined): FrameCaptureBudget {
  if (input !== undefined && (typeof input !== "object" || input === null || Array.isArray(input))) {
    fail("budget must be an object.");
  }
  const value = { ...FRAME_CAPTURE_DEFAULT_BUDGET, ...(input ?? {}) };
  for (const key of BUDGET_KEYS) requireInteger(value[key], `budget.${key}`, 1);
  return Object.freeze(value);
}

function normalizeSourceMapRef(value: unknown, budget: FrameCaptureBudget, field: string): FrameCaptureSourceMapRef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${field} must be an object.`);
  const ref = value as Partial<FrameCaptureSourceMapRef>;
  return Object.freeze({
    moduleId: requireId(ref.moduleId, `${field}.moduleId`, budget.maxStringLength),
    stage: (() => {
      if (!STAGES.has(ref.stage as FrameCaptureStage)) fail(`${field}.stage is unknown.`);
      return ref.stage as FrameCaptureStage;
    })(),
    nodeId: requireId(ref.nodeId, `${field}.nodeId`, budget.maxStringLength),
    generatedLine: requireInteger(ref.generatedLine, `${field}.generatedLine`, 1),
  });
}

function normalizeExecution(value: FrameCaptureExecutionMetadata | undefined, budget: FrameCaptureBudget): FrameCaptureExecutionMetadata | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("execution must be an object.");
  const execution = value as unknown as Record<string, unknown>;
  if (execution.kind === "dispatch") {
    if (!Array.isArray(execution.workgroups) || execution.workgroups.length !== 3) {
      fail("dispatch.workgroups must contain exactly three counts.");
    }
    const workgroups = execution.workgroups.map((count, index) => requireInteger(count, `execution.workgroups[${index}]`, 0)) as [number, number, number];
    return Object.freeze({ kind: "dispatch", workgroups: Object.freeze(workgroups) });
  }
  if (execution.kind === "draw") {
    const vertexCount = execution.vertexCount;
    const indexCount = execution.indexCount;
    if ((vertexCount === undefined) === (indexCount === undefined)) fail("draw must specify exactly one vertexCount or indexCount.");
    const instanceCount = requireInteger(execution.instanceCount, "execution.instanceCount", 0);
    const optional = (name: string, minimum: number): number | undefined => {
      const entry = execution[name];
      return entry === undefined ? undefined : requireInteger(entry, `execution.${name}`, minimum);
    };
    const firstVertex = optional("firstVertex", 0);
    const firstIndex = optional("firstIndex", 0);
    const baseVertex = optional("baseVertex", -0x7fffffff);
    const firstInstance = optional("firstInstance", 0);
    const normalized: FrameCaptureDrawMetadata = {
      kind: "draw",
      instanceCount,
      ...(vertexCount === undefined ? {} : { vertexCount: requireInteger(vertexCount, "execution.vertexCount", 0) }),
      ...(indexCount === undefined ? {} : { indexCount: requireInteger(indexCount, "execution.indexCount", 0) }),
      ...(firstVertex === undefined ? {} : { firstVertex }),
      ...(firstIndex === undefined ? {} : { firstIndex }),
      ...(baseVertex === undefined ? {} : { baseVertex }),
      ...(firstInstance === undefined ? {} : { firstInstance }),
    };
    return Object.freeze(normalized);
  }
  fail(`execution.kind ${String(execution.kind)} is unknown.`);
}

function normalizePass(value: PassCaptureInput, budget: FrameCaptureBudget, index: number): PassCapture {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`passes[${index}] must be an object.`);
  const pass = value as PassCaptureInput;
  if (!Array.isArray(pass.reads) || !Array.isArray(pass.writes)) fail(`passes[${index}] reads/writes must be arrays.`);
  const resources = (values: readonly string[], field: string): readonly string[] => {
    const seen = new Set<string>();
    return Object.freeze(values.map((resource, resourceIndex) => {
      const id = requireId(resource, `passes[${index}].${field}[${resourceIndex}]`, budget.maxStringLength);
      if (seen.has(id)) fail(`passes[${index}].${field} contains duplicate resource ${id}.`);
      seen.add(id);
      return id;
    }));
  };
  const refs = pass.sourceMapRefs ?? [];
  if (!Array.isArray(refs) || refs.length > budget.maxSourceMapRefsPerPass) fail(`passes[${index}].sourceMapRefs exceeds its capacity.`);
  const sourceMapRefs: FrameCaptureSourceMapRef[] = [];
  const seenRefs = new Set<string>();
  refs.forEach((entry, refIndex) => {
    const ref = normalizeSourceMapRef(entry, budget, `passes[${index}].sourceMapRefs[${refIndex}]`);
    const key = `${ref.moduleId}|${ref.stage}|${ref.nodeId}|${ref.generatedLine}`;
    if (seenRefs.has(key)) fail(`passes[${index}].sourceMapRefs contains a duplicate reference.`);
    seenRefs.add(key);
    sourceMapRefs.push(ref);
  });
  const durationMs = pass.durationMs === undefined ? undefined : requireTimestamp(pass.durationMs, `passes[${index}].durationMs`);
  if (durationMs !== undefined && durationMs < 0) fail(`passes[${index}].durationMs must be non-negative.`);
  const execution = pass.execution === undefined ? undefined : normalizeExecution(pass.execution, budget);
  const executor = pass.executor === undefined ? undefined : requireText(pass.executor, `passes[${index}].executor`, budget.maxStringLength);
  return Object.freeze({
    passId: requireId(pass.passId, `passes[${index}].passId`, budget.maxStringLength),
    kind: requireText(pass.kind, `passes[${index}].kind`, budget.maxStringLength),
    reads: resources(pass.reads, "reads"),
    writes: resources(pass.writes, "writes"),
    sourceMapRefs: Object.freeze(sourceMapRefs),
    ...(executor === undefined ? {} : { executor }),
    ...(execution === undefined ? {} : { execution }),
    ...(durationMs === undefined ? {} : { durationMs }),
  });
}

function normalizeMarker(value: FrameCaptureTimelineMarkerInput, frameId: string, start: number, end: number | undefined,
  budget: FrameCaptureBudget, index: number): FrameCaptureTimelineMarker {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`markers[${index}] must be an object.`);
  const marker = value as FrameCaptureTimelineMarkerInput;
  const timestampMs = requireTimestamp(marker.timestampMs, `markers[${index}].timestampMs`);
  if (timestampMs < start || (end !== undefined && timestampMs > end)) fail(`markers[${index}] is outside the frame bounds.`);
  return Object.freeze({ frameId, markerId: requireId(marker.markerId, `markers[${index}].markerId`, budget.maxStringLength),
    label: requireText(marker.label, `markers[${index}].label`, budget.maxStringLength), timestampMs });
}

export function createFrameCaptureRecord(input: FrameCaptureRecordInput, budgetInput?: Partial<FrameCaptureBudget>): FrameCaptureRecord {
  const budget = normalizeBudget(budgetInput);
  if (typeof input !== "object" || input === null || Array.isArray(input)) fail("record must be an object.");
  const frameId = requireId(input.frameId, "frameId", budget.maxStringLength);
  const startedAtMs = requireTimestamp(input.startedAtMs, "startedAtMs");
  const endedAtMs = requireTimestamp(input.endedAtMs, "endedAtMs");
  if (endedAtMs < startedAtMs) fail("endedAtMs must be >= startedAtMs.");
  if (!Array.isArray(input.passes) || input.passes.length > budget.maxPassesPerFrame) fail("passes exceeds its capacity.");
  const seenPasses = new Set<string>();
  const passes = input.passes.map((pass, index) => {
    const normalized = normalizePass(pass, budget, index);
    if (seenPasses.has(normalized.passId)) fail(`duplicate pass ${normalized.passId}.`);
    seenPasses.add(normalized.passId);
    return normalized;
  });
  const markersInput = input.markers ?? [];
  if (!Array.isArray(markersInput) || markersInput.length > budget.maxMarkersPerFrame) fail("markers exceeds its capacity.");
  const seenMarkers = new Set<string>();
  const markers = markersInput.map((marker, index) => {
    const normalized = normalizeMarker(marker, frameId, startedAtMs, endedAtMs, budget, index);
    if (seenMarkers.has(normalized.markerId)) fail(`duplicate marker ${normalized.markerId}.`);
    seenMarkers.add(normalized.markerId);
    return normalized;
  });
  const planHash = input.planHash === undefined ? undefined : requireText(input.planHash, "planHash", budget.maxStringLength);
  return Object.freeze({ schema: FRAME_CAPTURE_SCHEMA, schemaVersion: FRAME_CAPTURE_SCHEMA_VERSION,
    frameId, startedAtMs, endedAtMs, passes: Object.freeze(passes), markers: Object.freeze(markers),
    ...(planHash === undefined ? {} : { planHash }) });
}

export interface FrameCaptureSessionOptions {
  readonly budget?: Partial<FrameCaptureBudget>;
}

export class FrameCaptureSession {
  readonly #budget: FrameCaptureBudget;
  readonly #frames: FrameCaptureRecord[] = [];
  #active: ActiveFrame | undefined;

  constructor(options: FrameCaptureSessionOptions = {}) {
    this.#budget = normalizeBudget(options.budget);
  }

  get budget(): FrameCaptureBudget { return this.#budget; }

  beginFrame(frameId: string, startedAtMs: number, planHash?: string): void {
    if (this.#active) fail(`frame ${this.#active.frameId} is still open.`);
    const normalizedId = requireId(frameId, "frameId", this.#budget.maxStringLength);
    const start = requireTimestamp(startedAtMs, "startedAtMs");
    const normalizedPlanHash = planHash === undefined ? undefined : requireText(planHash, "planHash", this.#budget.maxStringLength);
    if (this.#frames.some(frame => frame.frameId === normalizedId)) fail(`frame ${normalizedId} already exists.`);
    const previous = this.#frames[this.#frames.length - 1];
    if (previous && start < previous.endedAtMs) fail("frames must be recorded in non-overlapping timeline order.");
    this.#active = { frameId: normalizedId, startedAtMs: start, ...(normalizedPlanHash === undefined ? {} : { planHash: normalizedPlanHash }), passes: [], markers: [] };
  }

  /** Drops an in-flight frame after an encode/submit failure; no partial record is retained. */
  cancelFrame(): string | undefined {
    const frameId = this.#active?.frameId;
    this.#active = undefined;
    return frameId;
  }

  get activeFrameId(): string | undefined { return this.#active?.frameId; }

  recordPass(pass: PassCaptureInput): void {
    const active = this.#active;
    if (!active) fail("recordPass requires an open frame.");
    if (active.passes.length >= this.#budget.maxPassesPerFrame) fail("pass capacity reached for the active frame.");
    if (active.passes.some(entry => entry.passId === pass?.passId)) fail(`duplicate pass ${String(pass?.passId)} in frame ${active.frameId}.`);
    active.passes.push(pass);
  }

  markTimeline(marker: FrameCaptureTimelineMarkerInput): void {
    const active = this.#active;
    if (!active) fail("markTimeline requires an open frame.");
    if (active.markers.length >= this.#budget.maxMarkersPerFrame) fail("marker capacity reached for the active frame.");
    if (active.markers.some(entry => entry.markerId === marker?.markerId)) fail(`duplicate marker ${String(marker?.markerId)} in frame ${active.frameId}.`);
    normalizeMarker(marker, active.frameId, active.startedAtMs, undefined, this.#budget, active.markers.length);
    active.markers.push(marker);
  }

  endFrame(endedAtMs: number): FrameCaptureRecord {
    const active = this.#active;
    if (!active) fail("endFrame requires an open frame.");
    const end = requireTimestamp(endedAtMs, "endedAtMs");
    const record = createFrameCaptureRecord({ frameId: active.frameId, startedAtMs: active.startedAtMs, endedAtMs: end,
      passes: active.passes, markers: active.markers, ...(active.planHash === undefined ? {} : { planHash: active.planHash }) }, this.#budget);
    this.#active = undefined;
    this.#frames.push(record);
    while (this.#frames.length > this.#budget.maxFrames) this.#frames.shift();
    return record;
  }

  getFrame(frameId: string): FrameCaptureRecord | undefined {
    const id = requireId(frameId, "frameId", this.#budget.maxStringLength);
    return this.#frames.find(frame => frame.frameId === id);
  }

  records(): readonly FrameCaptureRecord[] { return Object.freeze([...this.#frames]); }

  queryTimelineRange(startTimeMs: number, endTimeMs: number): FrameCaptureTimelineRange {
    const start = requireTimestamp(startTimeMs, "startTimeMs");
    const end = requireTimestamp(endTimeMs, "endTimeMs");
    if (end < start) fail("timeline range endTimeMs must be >= startTimeMs.");
    const frames = this.#frames.filter(frame => frame.endedAtMs >= start && frame.startedAtMs <= end);
    const markers = frames.flatMap(frame => frame.markers.filter(marker => marker.timestampMs >= start && marker.timestampMs <= end));
    return Object.freeze({ frames: Object.freeze(frames), markers: Object.freeze(markers) });
  }

  findBySourceMap(query: FrameCaptureSourceMapQuery): readonly FrameCaptureSourceMapMatch[] {
    if (typeof query !== "object" || query === null || Array.isArray(query)) fail("source-map query must be an object.");
    const fields = query as FrameCaptureSourceMapQuery;
    const moduleId = fields.moduleId === undefined ? undefined : requireId(fields.moduleId, "query.moduleId", this.#budget.maxStringLength);
    const stage = fields.stage === undefined ? undefined : (() => {
      if (!STAGES.has(fields.stage!)) fail("query.stage is unknown.");
      return fields.stage;
    })();
    const nodeId = fields.nodeId === undefined ? undefined : requireId(fields.nodeId, "query.nodeId", this.#budget.maxStringLength);
    const generatedLine = fields.generatedLine === undefined ? undefined : requireInteger(fields.generatedLine, "query.generatedLine", 1);
    if (moduleId === undefined && stage === undefined && nodeId === undefined && generatedLine === undefined) fail("source-map query must specify a filter.");
    const matches: FrameCaptureSourceMapMatch[] = [];
    for (const frame of this.#frames) for (const pass of frame.passes) for (const sourceMap of pass.sourceMapRefs) {
      if (moduleId !== undefined && sourceMap.moduleId !== moduleId) continue;
      if (stage !== undefined && sourceMap.stage !== stage) continue;
      if (nodeId !== undefined && sourceMap.nodeId !== nodeId) continue;
      if (generatedLine !== undefined && sourceMap.generatedLine !== generatedLine) continue;
      matches.push(Object.freeze({ frameId: frame.frameId, passId: pass.passId, sourceMap }));
    }
    return Object.freeze(matches);
  }
}
