export type ProbeVector3 = readonly [number, number, number];
export type ProbeGridSize = readonly [number, number, number];

export interface ProbeAabb { readonly min: ProbeVector3; readonly max: ProbeVector3 }
export interface ProbeClipmapCapacity {
  readonly maxBufferSize: number;
  readonly maxStorageBufferBindingSize: number;
}
export interface ProbeClipmapOptions {
  readonly levelCount?: number;
  readonly gridSize?: ProbeGridSize;
  readonly baseSpacing?: number;
  readonly spacingScale?: number;
  readonly updateBudget?: number;
  readonly memoryBudgetBytes?: number;
}
export interface ProbeAddress { readonly level: number; readonly cell: ProbeGridSize }
export interface ProbeClipmapHistory {
  readonly profileKey: string;
  readonly origins: readonly ProbeGridSize[];
  readonly pending: readonly ProbeAddress[];
}
export interface ProbeClipmapRequest {
  readonly cameraPosition: ProbeVector3;
  /** null means a known-empty scene. */
  readonly sceneBounds: ProbeAabb | null;
  readonly dirtyBounds?: readonly ProbeAabb[];
  readonly previous?: ProbeClipmapHistory;
  readonly capacity?: ProbeClipmapCapacity;
  readonly options?: ProbeClipmapOptions;
}
export interface ProbeClipmapLevel {
  readonly level: number;
  readonly gridSize: ProbeGridSize;
  readonly spacing: number;
  readonly originCell: ProbeGridSize;
  readonly origin: ProbeVector3;
  readonly max: ProbeVector3;
  readonly probeCount: number;
}
export type ProbeUpdateReason = "pending" | "dirty" | "scroll" | "initial";
export interface ProbeUpdate extends ProbeAddress {
  readonly localCell: ProbeGridSize;
  readonly linearIndex: number;
  readonly position: ProbeVector3;
  readonly reason: ProbeUpdateReason;
}
export interface ProbeClipmapProfile {
  readonly levelCount: number;
  readonly gridSize: ProbeGridSize;
  readonly baseSpacing: number;
  readonly spacingScale: number;
  readonly updateBudget: number;
  readonly probeCount: number;
  readonly probeStorageBytes: number;
  readonly updateListBytes: number;
  readonly levelMetadataBytes: number;
  readonly estimatedBytes: number;
  readonly degraded: boolean;
  readonly degradationReasons: readonly string[];
}
export interface ProbeClipmapPlan {
  readonly profile: ProbeClipmapProfile;
  readonly levels: readonly ProbeClipmapLevel[];
  readonly updates: readonly ProbeUpdate[];
  readonly deferred: readonly ProbeUpdate[];
  readonly history: ProbeClipmapHistory;
  readonly sceneEmpty: boolean;
}

export const DEEP_GI_PROBE_RECORD_BYTES = 96;
export const DEEP_GI_PROBE_UPDATE_BYTES = 16;
export const DEEP_GI_PROBE_LEVEL_BYTES = 64;
export const DEEP_GI_DEFAULT_PROBE_COUNT = 6_144;
export const DEEP_GI_DEFAULT_ESTIMATED_BYTES = 591_040;
export const DEEP_GI_PROBE_CLIPMAP_DEFAULTS = Object.freeze({
  levelCount: 3, gridSize: Object.freeze([16, 8, 16]) as ProbeGridSize,
  baseSpacing: 2, spacingScale: 2, updateBudget: 64, memoryBudgetBytes: 8 * 1024 * 1024,
});

/** Production quality presets shared by Studio and native hosts. */
export type DeepGiQuality = "performance" | "balanced" | "quality";
export function probeClipmapOptionsForQuality(quality: DeepGiQuality = "balanced"): ProbeClipmapOptions {
  const presets: Record<DeepGiQuality, ProbeClipmapOptions> = {
    performance: { levelCount: 2, gridSize: [12, 6, 12], baseSpacing: 3, spacingScale: 2, updateBudget: 32, memoryBudgetBytes: 4 * 1024 * 1024 },
    balanced: { levelCount: 3, gridSize: [16, 8, 16], baseSpacing: 2, spacingScale: 2, updateBudget: 64, memoryBudgetBytes: 8 * 1024 * 1024 },
    quality: { levelCount: 4, gridSize: [20, 10, 20], baseSpacing: 1.5, spacingScale: 2, updateBudget: 128, memoryBudgetBytes: 16 * 1024 * 1024 },
  };
  if (!(quality in presets)) throw new RangeError("Invalid Deep GI quality.");
  return Object.freeze({ ...presets[quality] });
}

const DEFAULT_CAPACITY: ProbeClipmapCapacity = Object.freeze({
  maxBufferSize: 128 * 1024 * 1024, maxStorageBufferBindingSize: 128 * 1024 * 1024,
});
const MAX_WORLD = 1_000_000_000, MAX_SPACING = 1_000_000, MAX_TOTAL_PROBES = 65_536;
const MIN_PACKED_CELL = -2_147_483_648, MAX_PACKED_CELL = 2_147_483_647;
const MAX_DIRTY_BOUNDS = 64, MAX_VISITS = 1_000_000;
const reasonRank: Record<ProbeUpdateReason, number> = { pending: 0, dirty: 1, scroll: 2, initial: 3 };

function fail(path: string, message: string): never { throw new RangeError(`${path}: ${message}`); }
function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "expected an object");
  return value as Record<string, unknown>;
}
function integer(value: unknown, path: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    fail(path, `expected an integer in ${minimum}..${maximum}`);
  }
  return value as number;
}
function finite(value: unknown, path: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    fail(path, `expected a finite number in ${minimum}..${maximum}`);
  }
  return value;
}
function vector(value: unknown, path: string, integers = false): ProbeGridSize {
  if (!Array.isArray(value) || value.length !== 3) fail(path, "expected three coordinates");
  return Object.freeze(value.map((item, index) => integers
    ? integer(item, `${path}[${index}]`, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
    : finite(item, `${path}[${index}]`, -MAX_WORLD, MAX_WORLD)) as unknown as ProbeGridSize);
}
function bounds(value: unknown, path: string): ProbeAabb {
  const source = record(value, path), min = vector(source.min, `${path}.min`), max = vector(source.max, `${path}.max`);
  if (min.some((item, axis) => item > max[axis]!)) fail(path, "min must not exceed max");
  return Object.freeze({ min, max });
}

function resolveProfile(optionsValue: unknown, capacityValue: unknown): ProbeClipmapProfile {
  const options = optionsValue === undefined ? {} : record(optionsValue, "options");
  const capacity = capacityValue === undefined ? DEFAULT_CAPACITY : record(capacityValue, "capacity");
  const requestedLevels = integer(options.levelCount ?? 3, "options.levelCount", 2, 4);
  const gridValue = options.gridSize ?? DEEP_GI_PROBE_CLIPMAP_DEFAULTS.gridSize;
  if (!Array.isArray(gridValue) || gridValue.length !== 3) fail("options.gridSize", "expected three dimensions");
  const gridSize = Object.freeze(gridValue.map((value, axis) => integer(value,
    `options.gridSize[${axis}]`, 2, 64)) as unknown as ProbeGridSize);
  const baseSpacing = finite(options.baseSpacing ?? 2, "options.baseSpacing", 0.01, MAX_SPACING);
  const spacingScale = finite(options.spacingScale ?? 2, "options.spacingScale", 1.01, 8);
  if (baseSpacing * spacingScale ** (requestedLevels - 1) > MAX_SPACING) fail("options", "coarsest spacing exceeds limit");
  const updateBudget = integer(options.updateBudget ?? 64, "options.updateBudget", 1, 65_536);
  const memoryBudget = integer(options.memoryBudgetBytes ?? 8 * 1024 * 1024,
    "options.memoryBudgetBytes", 1, Number.MAX_SAFE_INTEGER);
  const maxBuffer = integer(capacity.maxBufferSize, "capacity.maxBufferSize", 1, Number.MAX_SAFE_INTEGER);
  const maxStorage = integer(capacity.maxStorageBufferBindingSize,
    "capacity.maxStorageBufferBindingSize", 1, Number.MAX_SAFE_INTEGER);
  const perLevel = gridSize[0] * gridSize[1] * gridSize[2];
  for (let levelCount = requestedLevels; levelCount >= 2; levelCount--) {
    const probeCount = perLevel * levelCount;
    if (!Number.isSafeInteger(probeCount) || probeCount > MAX_TOTAL_PROBES) continue;
    const probeStorageBytes = probeCount * DEEP_GI_PROBE_RECORD_BYTES;
    const updateListBytes = updateBudget * DEEP_GI_PROBE_UPDATE_BYTES;
    const levelMetadataBytes = levelCount * DEEP_GI_PROBE_LEVEL_BYTES;
    const estimatedBytes = probeStorageBytes + updateListBytes + levelMetadataBytes;
    const largest = Math.max(probeStorageBytes, updateListBytes, levelMetadataBytes);
    if (largest > maxBuffer || largest > maxStorage || estimatedBytes > memoryBudget) continue;
    const degraded = levelCount !== requestedLevels;
    return Object.freeze({ levelCount, gridSize, baseSpacing, spacingScale, updateBudget, probeCount,
      probeStorageBytes, updateListBytes, levelMetadataBytes, estimatedBytes, degraded,
      degradationReasons: Object.freeze(degraded ? [`level-count:${requestedLevels}->${levelCount}`] : []) });
  }
  fail("capacity", "at least two probe clipmap levels do not fit device and memory limits");
}

function createLevels(profile: ProbeClipmapProfile, camera: ProbeVector3): readonly ProbeClipmapLevel[] {
  return Object.freeze(Array.from({ length: profile.levelCount }, (_, level) => {
    const spacing = profile.baseSpacing * profile.spacingScale ** level;
    const center = camera.map(value => Math.floor(value / spacing + 0.5));
    const originCell = Object.freeze(center.map((value, axis) => value - Math.floor(profile.gridSize[axis]! / 2)) as unknown as ProbeGridSize);
    if (originCell.some(value => value < MIN_PACKED_CELL || value > MAX_PACKED_CELL)) {
      fail("cameraPosition", "snapped probe origin exceeds packed int32 range");
    }
    const origin = Object.freeze(originCell.map(value => value * spacing) as unknown as ProbeVector3);
    const max = Object.freeze(originCell.map((value, axis) => (value + profile.gridSize[axis]! - 1) * spacing) as unknown as ProbeVector3);
    return Object.freeze({ level, gridSize: profile.gridSize, spacing, originCell, origin, max,
      probeCount: profile.gridSize[0] * profile.gridSize[1] * profile.gridSize[2] });
  }));
}

interface Candidate extends ProbeUpdate { distanceSquared: number }
function key(level: number, cell: ProbeGridSize): string { return `${level}:${cell[0]}:${cell[1]}:${cell[2]}`; }
function inside(cell: ProbeGridSize, origin: ProbeGridSize, size: ProbeGridSize): boolean {
  return cell.every((value, axis) => value >= origin[axis]! && value < origin[axis]! + size[axis]!);
}
function pointInside(point: ProbeVector3, box: ProbeAabb): boolean {
  return point.every((value, axis) => value >= box.min[axis]! && value <= box.max[axis]!);
}

/** Builds a bounded, deterministic CPU schedule. It allocates or renders no GI resources. */
export function planIrradianceProbeClipmap(requestValue: ProbeClipmapRequest): ProbeClipmapPlan {
  const request = record(requestValue, "request"), camera = vector(request.cameraPosition, "cameraPosition");
  const profile = resolveProfile(request.options, request.capacity), levels = createLevels(profile, camera);
  const scene = request.sceneBounds === null ? null : bounds(request.sceneBounds, "sceneBounds");
  const dirtyValue = request.dirtyBounds ?? [];
  if (!Array.isArray(dirtyValue)) fail("dirtyBounds", "expected an array");
  const dirty = dirtyValue.map((value, index) => bounds(value, `dirtyBounds[${index}]`));
  if (dirty.length > MAX_DIRTY_BOUNDS) fail("dirtyBounds", `limit ${MAX_DIRTY_BOUNDS} exceeded`);
  const profileKey = `${profile.levelCount}|${profile.gridSize.join("x")}|${profile.baseSpacing}|${profile.spacingScale}`;
  const candidates = new Map<string, Candidate>(); let visits = 0;
  const add = (level: ProbeClipmapLevel, cell: ProbeGridSize, reason: ProbeUpdateReason) => {
    if (!inside(cell, level.originCell, level.gridSize)) return;
    const position = Object.freeze(cell.map(value => value * level.spacing) as unknown as ProbeVector3);
    if (!scene || !pointInside(position, scene)) return;
    const id = key(level.level, cell), current = candidates.get(id);
    if (current && reasonRank[current.reason] <= reasonRank[reason]) return;
    const localCell = Object.freeze(cell.map((value, axis) => value - level.originCell[axis]!) as unknown as ProbeGridSize);
    const linearIndex = (localCell[2] * level.gridSize[1] + localCell[1]) * level.gridSize[0] + localCell[0];
    const distanceSquared = position.reduce((sum, value, axis) => sum + (value - camera[axis]!) ** 2, 0);
    candidates.set(id, Object.freeze({ level: level.level, cell, localCell, linearIndex, position, reason, distanceSquared }));
  };
  const addBox = (level: ProbeClipmapLevel, box: ProbeAabb, reason: ProbeUpdateReason,
    predicate: (cell: ProbeGridSize) => boolean = () => true) => {
    if (!scene) return;
    const low = box.min.map((value, axis) => Math.max(level.originCell[axis]!, Math.ceil(value / level.spacing),
      Math.ceil(scene.min[axis]! / level.spacing)));
    const high = box.max.map((value, axis) => Math.min(level.originCell[axis]! + level.gridSize[axis]! - 1,
      Math.floor(value / level.spacing), Math.floor(scene.max[axis]! / level.spacing)));
    if (low.some((value, axis) => value > high[axis]!)) return;
    for (let z = low[2]!; z <= high[2]!; z++) for (let y = low[1]!; y <= high[1]!; y++) {
      for (let x = low[0]!; x <= high[0]!; x++) {
        if (++visits > MAX_VISITS) fail("dirtyBounds", `candidate visit limit ${MAX_VISITS} exceeded`);
        const cell = Object.freeze([x, y, z]) as ProbeGridSize; if (predicate(cell)) add(level, cell, reason);
      }
    }
  };

  let previous: ProbeClipmapHistory | undefined;
  if (request.previous !== undefined) {
    const source = record(request.previous, "previous");
    if (typeof source.profileKey !== "string" || source.profileKey.length > 256) fail("previous.profileKey", "expected a bounded string");
    if (!Array.isArray(source.origins) || source.origins.length > 4) fail("previous.origins", "expected at most four origins");
    if (!Array.isArray(source.pending) || source.pending.length > MAX_TOTAL_PROBES) fail("previous.pending", "invalid pending list");
    const origins = source.origins.map((value, index) => vector(value, `previous.origins[${index}]`, true));
    const pending = source.pending.map((value, index) => {
      const item = record(value, `previous.pending[${index}]`);
      return Object.freeze({ level: integer(item.level, `previous.pending[${index}].level`, 0, 3),
        cell: vector(item.cell, `previous.pending[${index}].cell`, true) });
    });
    previous = { profileKey: source.profileKey, origins, pending };
  }
  const reusable = previous?.profileKey === profileKey;
  if (scene && reusable) for (const item of previous!.pending) {
    const level = levels[item.level]; if (level) add(level, item.cell, "pending");
  }
  if (scene) levels.forEach(level => {
    const oldOrigin = reusable ? previous!.origins[level.level] : undefined;
    if (!oldOrigin) addBox(level, scene, "initial");
    else if (oldOrigin.some((value, axis) => value !== level.originCell[axis])) {
      addBox(level, scene, "scroll", cell => !inside(cell, oldOrigin, level.gridSize));
    }
    dirty.forEach(box => addBox(level, box, "dirty"));
  });
  const ranked = [...candidates.values()].sort((left, right) => reasonRank[left.reason] - reasonRank[right.reason]
    || left.level - right.level || left.distanceSquared - right.distanceSquared
    || left.cell[0] - right.cell[0] || left.cell[1] - right.cell[1] || left.cell[2] - right.cell[2]);
  const clean = (value: Candidate): ProbeUpdate => Object.freeze({ level: value.level, cell: value.cell,
    localCell: value.localCell, linearIndex: value.linearIndex, position: value.position, reason: value.reason });
  const updates = Object.freeze(ranked.slice(0, profile.updateBudget).map(clean));
  const deferred = Object.freeze(ranked.slice(profile.updateBudget).map(clean));
  const history = Object.freeze({ profileKey, origins: Object.freeze(levels.map(level => level.originCell)),
    pending: Object.freeze(deferred.map(value => Object.freeze({ level: value.level, cell: value.cell }))) });
  return Object.freeze({ profile, levels, updates, deferred, history, sceneEmpty: scene === null });
}
