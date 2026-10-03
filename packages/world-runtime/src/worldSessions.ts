import { randomUUID } from "node:crypto";
import type { WorldObservation, WorldSessionInfo } from "@bim-studio/contracts";
import { HeadlessWorld } from "./headlessWorld.js";

/** 会话资源上限：防止智能体（或失控循环）耗尽服务器内存与事件循环。 */
export interface WorldSessionLimits {
  /** 全服务并发世界数。 */
  maxWorlds: number;
  /** 同一项目内同一主体可持有的世界数。 */
  maxWorldsPerOwner: number;
  /** 单个世界的内存估算上限（字节）。 */
  maxWorldBytes: number;
  /** 全部世界的内存估算总预算（字节）。 */
  maxTotalBytes: number;
  /** 空闲超时：超过后被回收（毫秒）。 */
  idleTimeoutMs: number;
}

export const DEFAULT_WORLD_SESSION_LIMITS: WorldSessionLimits = {
  maxWorlds: 8,
  maxWorldsPerOwner: 4,
  maxWorldBytes: 4 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  idleTimeoutMs: 10 * 60 * 1000,
};

export interface WorldOwner {
  projectId: string;
  principal: string;
}

export class WorldSessionError extends Error {
  readonly name = "WorldSessionError";
  constructor(readonly code: "not-found" | "limit-exceeded", message: string) {
    super(message);
  }
}

interface Session {
  id: string;
  owner: WorldOwner;
  world: HeadlessWorld;
  createdAt: number;
  lastUsedAt: number;
}

export interface WorldSessionManagerOptions {
  limits?: Partial<WorldSessionLimits>;
  now?: () => number;
  newId?: () => string;
}

/**
 * 世界会话表：归属校验（项目 + 主体）、配额、空闲回收。
 * 世界操作全部同步（Rapier wasm），同一世界天然串行；这里只管创建期的并发配额。
 */
export class WorldSessionManager {
  readonly limits: WorldSessionLimits;
  private readonly sessions = new Map<string, Session>();
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly inFlight = new Map<string, number>();
  private inFlightTotal = 0;
  private sweeper: ReturnType<typeof setInterval> | undefined;

  constructor(options: WorldSessionManagerOptions = {}) {
    this.limits = { ...DEFAULT_WORLD_SESSION_LIMITS, ...options.limits };
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? randomUUID;
  }

  get size(): number { return this.sessions.size; }

  async create(owner: WorldOwner, resetRequest: unknown): Promise<{ info: WorldSessionInfo; observation: WorldObservation }> {
    return this.admit(owner, () => HeadlessWorld.reset(resetRequest));
  }

  /** worldId 缺省 = 从快照新建世界（跨会话/跨进程续跑）；给定 = 原地替换该世界的状态。 */
  async restore(owner: WorldOwner, snapshot: unknown, worldId?: string): Promise<{ info: WorldSessionInfo; observation: WorldObservation }> {
    if (worldId === undefined) return this.admit(owner, () => HeadlessWorld.restore(snapshot));
    const session = this.require(owner, worldId);
    const restored = await HeadlessWorld.restore(snapshot);
    if (this.sessions.get(worldId) !== session) {
      restored.dispose();
      throw new WorldSessionError("not-found", `世界 ${worldId} 已被关闭`);
    }
    session.world.dispose();
    session.world = restored;
    session.lastUsedAt = this.now();
    return { info: this.info(session), observation: restored.observe({}) };
  }

  /** 取得世界并刷新空闲计时；非本人/本项目的世界与不存在一视同仁，不泄露存在性。 */
  get(owner: WorldOwner, worldId: string): HeadlessWorld {
    const session = this.require(owner, worldId);
    session.lastUsedAt = this.now();
    return session.world;
  }

  describe(owner: WorldOwner, worldId: string): WorldSessionInfo {
    return this.info(this.require(owner, worldId));
  }

  list(owner: WorldOwner): WorldSessionInfo[] {
    return [...this.sessions.values()].filter((session) => sameOwner(session.owner, owner)).map((session) => this.info(session));
  }

  close(owner: WorldOwner, worldId: string): boolean {
    const session = this.sessions.get(worldId);
    if (!session || !sameOwner(session.owner, owner)) return false;
    this.drop(session);
    return true;
  }

  /** 回收空闲世界，返回回收数量。 */
  sweepIdle(): number {
    const deadline = this.now() - this.limits.idleTimeoutMs;
    let swept = 0;
    for (const session of [...this.sessions.values()]) {
      if (session.lastUsedAt <= deadline) { this.drop(session); swept += 1; }
    }
    return swept;
  }

  /** 后台定时回收；timer unref，不阻止进程退出。 */
  startSweeper(intervalMs = Math.max(1_000, Math.floor(this.limits.idleTimeoutMs / 4))): void {
    this.sweeper ??= setInterval(() => this.sweepIdle(), intervalMs);
    this.sweeper.unref();
  }

  dispose(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = undefined;
    for (const session of [...this.sessions.values()]) this.drop(session);
  }

  private async admit(owner: WorldOwner, build: () => Promise<HeadlessWorld>): Promise<{ info: WorldSessionInfo; observation: WorldObservation }> {
    this.sweepIdle();
    const key = ownerKey(owner);
    this.assertCapacity(key);
    // 构建期间先占坑（总数 + 主体各一份），避免并发 create 同时通过检查后超出配额。
    this.inFlight.set(key, (this.inFlight.get(key) ?? 0) + 1);
    this.inFlightTotal += 1;
    let world: HeadlessWorld | undefined;
    try {
      world = await build();
      if (world.estimatedBytes > this.limits.maxWorldBytes) {
        throw new WorldSessionError("limit-exceeded", `单世界内存估算 ${world.estimatedBytes} 字节超过上限 ${this.limits.maxWorldBytes}`);
      }
      if (this.totalBytes() + world.estimatedBytes > this.limits.maxTotalBytes) {
        throw new WorldSessionError("limit-exceeded", "世界总内存预算已满，请先关闭不用的世界");
      }
    } catch (error) {
      world?.dispose();
      throw error;
    } finally {
      this.inFlightTotal -= 1;
      const left = (this.inFlight.get(key) ?? 1) - 1;
      if (left > 0) this.inFlight.set(key, left); else this.inFlight.delete(key);
    }
    const now = this.now();
    const session: Session = { id: this.newId(), owner: { ...owner }, world, createdAt: now, lastUsedAt: now };
    this.sessions.set(session.id, session);
    return { info: this.info(session), observation: world.observe({}) };
  }

  private assertCapacity(key: string): void {
    if (this.sessions.size + this.inFlightTotal >= this.limits.maxWorlds) {
      throw new WorldSessionError("limit-exceeded", `并发世界数已达上限 ${this.limits.maxWorlds}，请先关闭不用的世界`);
    }
    const owned = [...this.sessions.values()].filter((session) => ownerKey(session.owner) === key).length + (this.inFlight.get(key) ?? 0);
    if (owned >= this.limits.maxWorldsPerOwner) {
      throw new WorldSessionError("limit-exceeded", `当前主体在该项目下最多持有 ${this.limits.maxWorldsPerOwner} 个世界`);
    }
  }
  private totalBytes(): number {
    let total = 0;
    for (const session of this.sessions.values()) total += session.world.estimatedBytes;
    return total;
  }

  private require(owner: WorldOwner, worldId: string): Session {
    const session = this.sessions.get(worldId);
    if (!session || !sameOwner(session.owner, owner)) throw new WorldSessionError("not-found", `世界不存在、已关闭或已因空闲被回收：${worldId}`);
    return session;
  }

  private drop(session: Session): void {
    this.sessions.delete(session.id);
    session.world.dispose();
  }

  private info(session: Session): WorldSessionInfo {
    return {
      worldId: session.id, seed: session.world.seed, tick: session.world.tick, sceneId: session.world.sceneId,
      objectCount: session.world.objectCount, createdAt: new Date(session.createdAt).toISOString(), lastUsedAt: new Date(session.lastUsedAt).toISOString(),
    };
  }
}

function ownerKey(owner: WorldOwner): string {
  return JSON.stringify([owner.projectId, owner.principal]);
}

function sameOwner(a: WorldOwner, b: WorldOwner): boolean {
  return ownerKey(a) === ownerKey(b);
}
