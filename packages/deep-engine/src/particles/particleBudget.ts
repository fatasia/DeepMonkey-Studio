/**
 * T20 切片:粒子数量预算硬约束与有记录的降级策略。
 *
 * 三级降级语义(每级量化进 `degradationReasons`,格式沿用底座 `key:A->B`):
 * 1. 容量压缩 `capacity:A->B`:2 的幂容量档被上限/显存预算压低;
 * 2. 发射率折扣 `emission-rate:1.000->r`:稳态需求超容量时等比折扣(最大余数法
 *    分配,与 webgpu/gpuParticleEmitters.ts 的 allocateCounts 同公式);
 * 3. 最短寿命优先终结 `terminate-shortest-lived:N`:帧内活跃数仍超容量时,
 *    终结剩余寿命最短的 N 个(`enforceParticleCapacity`)。
 *
 * 显存证据公式与 `resolveGpuParticleCapacity` 一致:stateBytes = capacity × 64,
 * totalBufferBytes = stateBytes×2 + counter 8B + indirect 16B×2 + frame uniform 32B。
 */

import {
  GPU_PARTICLE_INDIRECT_BYTES, GPU_PARTICLE_FRAME_UNIFORM_BYTES, GPU_PARTICLE_MAX_CAPACITY,
  GPU_PARTICLE_STRIDE,
} from "../webgpu/gpuParticleTypes.js";

export interface ParticleBudgetRequest {
  readonly id: string;
  readonly count: number;
  /** 均匀发射速率(粒子/秒);缺省按 count/1s 口径。 */
  readonly rate?: number;
  /** 平均寿命(秒);缺省 1。稳态活跃数估计 = Σ rate×lifetime。 */
  readonly lifetime?: number;
}

export interface ParticleBudgetOptions {
  readonly capacityLimit?: number;
  readonly memoryLimitBytes?: number;
}

export interface ParticleBudgetDegradation {
  readonly reasons: readonly string[];
  readonly requestedCapacity: number;
  readonly capacityDiscount: number;
  readonly rateDiscount: number;
  readonly terminatedShortestLived: number;
}

export interface ParticleBudgetAllocation {
  readonly id: string;
  readonly requested: number;
  readonly allocated: number;
}

export interface ParticleBudgetPlan {
  readonly requestedCount: number;
  readonly steadyStateCount: number;
  readonly capacity: number;
  readonly allocations: readonly ParticleBudgetAllocation[];
  readonly stateBytes: number;
  readonly totalBufferBytes: number;
  readonly degraded: boolean;
  readonly degradation: ParticleBudgetDegradation;
}

/** 与底座 nextPowerOfTwo 同公式。 */
function nextPowerOfTwo(value: number): number { return 2 ** Math.ceil(Math.log2(value)); }

function integer(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer in ${minimum}..${maximum}.`);
  }
  return value;
}
function finite(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be finite in ${minimum}..${maximum}.`);
  }
  return value;
}

type NormalizedBudgetRequest = Required<ParticleBudgetRequest>;

function normalizeRequests(requests: readonly ParticleBudgetRequest[]): readonly NormalizedBudgetRequest[] {
  if (!Array.isArray(requests) || requests.length < 1 || requests.length > 64) {
    throw new RangeError("Requests must contain between 1 and 64 emitters.");
  }
  const ids = new Set<string>();
  return Object.freeze(requests.map((request, index) => {
    if (!request || typeof request !== "object" || !/^[0-9A-Za-z][0-9A-Za-z._:-]{0,63}$/.test(String(request.id))) {
      throw new TypeError(`Requests[${index}].id is invalid.`);
    }
    if (ids.has(request.id)) throw new TypeError(`Requests[${index}].id duplicates an earlier emitter.`);
    ids.add(request.id);
    return Object.freeze({ id: request.id,
      count: integer(request.count, `requests[${index}].count`, 1, 65_536),
      rate: finite(request.rate ?? request.count, `requests[${index}].rate`, 0, 1e9),
      lifetime: finite(request.lifetime ?? 1, `requests[${index}].lifetime`, 0.01, 3_600) });
  }));
}

/** 最大余数法分配(与底座 allocateCounts 同公式,保证 Σ=capacity 且 ≤ 请求)。 */
function allocateByLargestRemainder(requested: readonly number[], capacity: number): number[] {
  const total = requested.reduce((sum, value) => sum + value, 0);
  if (total <= capacity) return [...requested];
  const exact = requested.map(value => value * capacity / total);
  const result = exact.map(Math.floor);
  let remaining = capacity - result.reduce((sum, value) => sum + value, 0);
  const order = exact.map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (const item of order) {
    if (!remaining) break;
    if (result[item.index]! < requested[item.index]!) {
      result[item.index]! += 1;
      remaining--;
    }
  }
  return result;
}

/** 预算计划:容量压缩 → 发射率折扣,输出显存证据与量化降级原因。 */
export function planParticleBudget(requests: readonly ParticleBudgetRequest[],
  options: ParticleBudgetOptions = {}): ParticleBudgetPlan {
  const normalized = normalizeRequests(requests);
  const capacityLimit = integer(options.capacityLimit ?? GPU_PARTICLE_MAX_CAPACITY,
    "capacityLimit", 1, GPU_PARTICLE_MAX_CAPACITY);
  const memoryLimitBytes = options.memoryLimitBytes === undefined
    ? Number.POSITIVE_INFINITY
    : finite(options.memoryLimitBytes, "memoryLimitBytes", GPU_PARTICLE_STRIDE * 2, 2 ** 53);
  const requestedCount = normalized.reduce((sum, item) => sum + item.count, 0);
  const steadyStateCount = normalized.reduce((sum, item) => sum + item.rate * item.lifetime, 0);
  const requestedCapacity = Math.min(GPU_PARTICLE_MAX_CAPACITY,
    Math.max(1_024, nextPowerOfTwo(Math.max(requestedCount, 1))));
  const memoryCapacity = Number.isFinite(memoryLimitBytes)
    ? Math.floor((memoryLimitBytes - 8 - GPU_PARTICLE_INDIRECT_BYTES * 2
      - GPU_PARTICLE_FRAME_UNIFORM_BYTES) / (GPU_PARTICLE_STRIDE * 2))
    : GPU_PARTICLE_MAX_CAPACITY;
  const reasons: string[] = [];
  const capacity = Math.min(requestedCapacity, capacityLimit, memoryCapacity);
  if (capacity < 1) throw new RangeError(`Memory budget ${memoryLimitBytes}B cannot hold one particle.`);
  if (capacity < requestedCapacity) reasons.push(`capacity:${requestedCapacity}->${capacity}`);
  // 发射率折扣判据取需求峰值:首发射数与稳态活跃数(Σ rate×lifetime)的较大者。
  const demand = Math.max(requestedCount, steadyStateCount);
  const rateDiscount = Math.min(1, capacity / demand);
  const allocated = allocateByLargestRemainder(normalized.map(item => item.count), Math.min(capacity, requestedCount));
  if (rateDiscount < 1) reasons.push(`emission-rate:1.000->${rateDiscount.toFixed(3)}`);
  const stateBytes = capacity * GPU_PARTICLE_STRIDE;
  const totalBufferBytes = stateBytes * 2 + 8 + GPU_PARTICLE_INDIRECT_BYTES * 2
    + GPU_PARTICLE_FRAME_UNIFORM_BYTES;
  return Object.freeze({
    requestedCount, steadyStateCount, capacity,
    allocations: Object.freeze(normalized.map((item, index) => Object.freeze({
      id: item.id, requested: item.count, allocated: allocated[index]!,
    }))),
    stateBytes, totalBufferBytes,
    degraded: reasons.length > 0,
    degradation: Object.freeze({ reasons: Object.freeze(reasons), requestedCapacity,
      capacityDiscount: capacity / requestedCapacity, rateDiscount, terminatedShortestLived: 0 }),
  });
}

export interface EnforceCapacityInput {
  readonly id: number;
  readonly remainingLifetime: number;
}

export interface EnforceCapacityOutcome {
  readonly kept: readonly EnforceCapacityInput[];
  readonly terminated: readonly EnforceCapacityInput[];
  readonly reason: string;
}

/**
 * 级 3 降级:活跃数超容量时终结剩余寿命最短者(平票按 id 升序,确定性);
 * 未超容量时零扰动。
 */
export function enforceParticleCapacity(active: readonly EnforceCapacityInput[],
  capacity: number): EnforceCapacityOutcome {
  integer(capacity, "capacity", 1, GPU_PARTICLE_MAX_CAPACITY);
  if (!Array.isArray(active)) throw new TypeError("active must be an array.");
  active.forEach((item, index) => {
    if (!item || !Number.isSafeInteger(item.id) || item.id < 0) {
      throw new TypeError(`active[${index}].id is invalid.`);
    }
    finite(item.remainingLifetime, `active[${index}].remainingLifetime`, 0, 3_600);
  });
  if (active.length <= capacity) {
    return Object.freeze({ kept: Object.freeze([...active]), terminated: Object.freeze([]), reason: "" });
  }
  const ordered = [...active].sort((a, b) => a.remainingLifetime - b.remainingLifetime || a.id - b.id);
  const kept = ordered.slice(active.length - capacity).sort((a, b) => a.id - b.id);
  const terminated = ordered.slice(0, active.length - capacity);
  return Object.freeze({ kept: Object.freeze(kept), terminated: Object.freeze(terminated),
    reason: `terminate-shortest-lived:${terminated.length}` });
}

/** 10 万 / 100 万发射规模阶梯的预算档统计表(报告引用)。 */
export function particleBudgetLadder(ladder: readonly number[], options: ParticleBudgetOptions = {}):
  readonly ParticleBudgetPlan[] {
  return Object.freeze(ladder.map(total => {
    const count = integer(total, "ladder", 1, GPU_PARTICLE_MAX_CAPACITY);
    // 单发射器请求上限与底座 emitters 一致(count ≤ 65536),超出自动拆分。
    const emitters = Math.ceil(count / 65_536);
    const per = Math.ceil(count / emitters);
    const requests = Array.from({ length: emitters }, (_, index) =>
      ({ id: `ladder-${index}`, count: per, rate: per / 2, lifetime: 2 }));
    return planParticleBudget(requests, options);
  }));
}
