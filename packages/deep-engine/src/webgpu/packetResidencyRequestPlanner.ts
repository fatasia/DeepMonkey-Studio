import type { PreparedPacket } from "../renderPacketTypes.js";
import { DEEP_RESIDENCY_LIMITS } from "../streaming/index.js";
import type { GpuRenderResidencyRequest } from "./gpuRenderResidencyRuntime.js";
import { compilePacketResidencyIndex, type CompiledPacketResidencyIndex,
  type CompiledResidencyBatch, type CompiledResidencyTexture } from "./packetResidencyPlannerIndex.js";

export interface PacketResidencyDemand {
  readonly batchKey: string;
  /** Optional object identity for validating object-scoped visibility demand. */
  readonly instanceId?: string;
  /** LOD array index selected by visibility; defaults to the finest level. */
  readonly desiredLod?: number;
  readonly priority?: number;
}

export interface PacketResidencyRequestPlanOptions {
  /** Desired base mip per referenced texture; omitted textures request mip zero. */
  readonly textureMipLevels?: ReadonlyMap<string, number>;
}

interface PlannedRequest extends GpuRenderResidencyRequest { readonly order: number }
export interface PacketResidencyRequestPlanner {
  plan(demands: readonly PacketResidencyDemand[],
    options?: PacketResidencyRequestPlanOptions): readonly GpuRenderResidencyRequest[];
}

/** Builds a deterministic visible working set with a mandatory drawable fallback. */
export function planPacketResidencyRequests(packet: PreparedPacket,
  demands: readonly PacketResidencyDemand[],
  options: PacketResidencyRequestPlanOptions = {}): readonly GpuRenderResidencyRequest[] {
  return createPacketResidencyRequestPlanner(packet).plan(demands, options);
}

/** Compiles immutable packet metadata once for repeated frame planning. */
export function createPacketResidencyRequestPlanner(packet: PreparedPacket): PacketResidencyRequestPlanner {
  const index = compilePacketResidencyIndex(packet);
  return Object.freeze({
    plan(demands: readonly PacketResidencyDemand[], options: PacketResidencyRequestPlanOptions = {}) {
      return planCompiled(index, demands, options);
    },
  });
}

function planCompiled(index: CompiledPacketResidencyIndex,
  demands: readonly PacketResidencyDemand[],
  options: PacketResidencyRequestPlanOptions): readonly GpuRenderResidencyRequest[] {
  const textureLevels = validateTextureLevels(options, index.textures);
  if (!Array.isArray(demands)) throw new TypeError("Packet residency demands must be an array.");
  const planned = new Map<string, PlannedRequest>(), maxPriorities: (number | undefined)[] = [];
  const detailPriorities: ((number | undefined)[] | undefined)[] = [];
  for (const batch of index.batches.values()) {
    planBaseClosure(batch, 0, index.geometryOrder, index.textureOrder,
      textureLevels, planned);
  }
  for (const demand of demands) {
    const batch = validateDemand(demand, index.batches);
    collectDemand(batch, demand.desiredLod, demand.priority ?? 0,
      maxPriorities, detailPriorities);
  }
  for (const batch of index.batches.values()) {
    planAggregatedDemand(batch, index.geometryOrder, index.textureOrder,
      textureLevels, maxPriorities, detailPriorities, planned);
  }
  return Object.freeze([...planned.values()]
    .sort((left, right) => left.order - right.order || left.kind.localeCompare(right.kind)
      || left.id.localeCompare(right.id))
    .map(({ order: _order, ...request }) => Object.freeze(request)));
}

function planBaseClosure(indexed: CompiledResidencyBatch, priority: number,
  geometryOrder: ReadonlyMap<string, number>, textureOrder: ReadonlyMap<string, number>,
  textureLevels: ReadonlyMap<string, number>,
  planned: Map<string, PlannedRequest>): void {
  for (const id of indexed.authorLevels ?? [indexed.fallbackGeometry!]) {
    addGeometry(id, priority, true, geometryOrder, planned);
  }
  for (const id of indexed.textures) {
    add(planned, "texture", id, textureLevels.get(id) ?? 0,
      priority, true, textureOrder.get(id));
  }
}

function collectDemand(indexed: CompiledResidencyBatch, desired: number | undefined, priority: number,
  maxPriorities: (number | undefined)[],
  detailPriorities: ((number | undefined)[] | undefined)[]): void {
  const levels = indexed.lod;
  if (indexed.authorLevels && desired !== undefined) {
    throw new Error(`Author-selected LOD does not accept a desiredLod override: ${indexed.key}.`);
  }
  if (!levels) {
    if (desired !== undefined && desired !== 0) {
      throw new RangeError(`Non-LOD batch ${indexed.key} only accepts desired LOD zero.`);
    }
    maxPriorities[indexed.order] = Math.max(
      maxPriorities[indexed.order] ?? Number.NEGATIVE_INFINITY, priority); return;
  }
  const desiredIndex = desired ?? 0;
  if (!Number.isSafeInteger(desiredIndex) || desiredIndex < 0 || desiredIndex >= levels.length) {
    throw new RangeError(`Desired LOD for batch ${indexed.key} is invalid.`);
  }
  maxPriorities[indexed.order] = Math.max(
    maxPriorities[indexed.order] ?? Number.NEGATIVE_INFINITY, priority);
  const selected = levels[desiredIndex]!;
  if (selected !== indexed.fallbackGeometry) {
    const priorities = detailPriorities[indexed.order] ??= new Array<number | undefined>(levels.length);
    priorities[desiredIndex] = Math.max(priorities[desiredIndex] ?? Number.NEGATIVE_INFINITY, priority);
  }
}

function planAggregatedDemand(indexed: CompiledResidencyBatch,
  geometryOrder: ReadonlyMap<string, number>, textureOrder: ReadonlyMap<string, number>,
  textureLevels: ReadonlyMap<string, number>, maxPriorities: readonly (number | undefined)[],
  detailPriorities: readonly ((number | undefined)[] | undefined)[],
  planned: Map<string, PlannedRequest>): void {
  const maxPriority = maxPriorities[indexed.order];
  if (maxPriority === undefined) return;
  for (const id of indexed.authorLevels ?? [indexed.fallbackGeometry!]) {
    addGeometry(id, maxPriority, true, geometryOrder, planned);
  }
  for (const id of indexed.textures) {
    add(planned, "texture", id, textureLevels.get(id) ?? 0,
      maxPriority, true, textureOrder.get(id));
  }
  detailPriorities[indexed.order]?.forEach((priority, target) => {
    if (priority !== undefined) {
      addGeometry(indexed.lod![target]!, priority, false, geometryOrder, planned);
    }
  });
}

function addGeometry(id: string, priority: number, required: boolean,
  order: ReadonlyMap<string, number>, target: Map<string, PlannedRequest>): void {
  const position = order.get(id);
  if (position === undefined) throw new Error(`Packet residency geometry is unavailable: ${id}.`);
  add(target, "geometry", id, 0, priority, required, position);
}

function add(target: Map<string, PlannedRequest>, kind: GpuRenderResidencyRequest["kind"],
  id: string, desiredLevel: number, priority: number, required: boolean,
  order: number | undefined): void {
  if (order === undefined) throw new Error(`Packet residency ${kind} is unavailable: ${id}.`);
  const key = `${kind}\u0000${id}`, previous = target.get(key);
  if (!previous) {
    target.set(key, { kind, id, desiredLevel, priority, required, order }); return;
  }
  target.set(key, { ...previous, desiredLevel: Math.min(previous.desiredLevel, desiredLevel),
    priority: Math.max(previous.priority ?? 0, priority), required: previous.required || required });
}

function validateDemand(demand: PacketResidencyDemand,
  batches: ReadonlyMap<string, CompiledResidencyBatch>): CompiledResidencyBatch {
  if (!demand || typeof demand !== "object" || Array.isArray(demand)
    || typeof demand.batchKey !== "string") throw new TypeError("Packet residency demand is invalid.");
  const indexed = batches.get(demand.batchKey);
  if (!indexed) throw new Error(`Unknown packet residency batch: ${demand.batchKey}.`);
  if (demand.instanceId !== undefined
    && (typeof demand.instanceId !== "string" || !indexed.instances.has(demand.instanceId))) {
    throw new Error(`Unknown packet residency instance: ${String(demand.instanceId)}.`);
  }
  const priority = demand.priority ?? 0;
  if (!Number.isFinite(priority) || Math.abs(priority) > DEEP_RESIDENCY_LIMITS.maxPriority) {
    throw new RangeError(`Packet residency priority for ${demand.batchKey} is invalid.`);
  }
  return indexed;
}

function validateTextureLevels(options: PacketResidencyRequestPlanOptions,
  textures: ReadonlyMap<string, CompiledResidencyTexture>): ReadonlyMap<string, number> {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Packet residency request plan options are invalid.");
  }
  const input = options.textureMipLevels;
  if (input === undefined) return new Map();
  if (!(input instanceof Map)) throw new TypeError("Packet texture mip levels must be a map.");
  for (const [id, level] of input) {
    const source = textures.get(id);
    if (!source) throw new Error(`Unknown packet residency texture mip target: ${id}.`);
    if (!Number.isSafeInteger(level) || level < 0 || level >= source.independentMipCount) {
      throw new RangeError(`Packet residency texture mip target is invalid: ${id}:${level}.`);
    }
  }
  return input;
}
