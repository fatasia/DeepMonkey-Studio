import {
  assertPathSafeResourceId,
  validateWorldObserveRequest,
  validateWorldResetRequest,
  validateWorldSnapshot,
  validateWorldStepRequest,
  type WorldObservation,
  type WorldObserveRequest,
  type WorldResetRequest,
  type WorldSessionInfo,
  type WorldSnapshot,
  type WorldStepRequest,
  type WorldStepResult,
} from "@bim-studio/contracts";
import { ServerRequestError, type ServerClient } from "./serverClient.js";

/**
 * World API v1 的 JS/TS 薄封装：HTTP 之上只做路径拼装、本地预校验与结果解包。
 * 预校验复用 contracts 的同一批校验函数，所以非法 dt/seed/action 在发请求前就以
 * WorldApiContractError 失败（与服务端口径一致，不多一个往返）。
 */

/** 服务端以能力结果信封返回；失败时信封里的 warnings 才是可操作的原因，优先于通用状态文案。 */
export class WorldApiError extends Error {
  readonly name = "WorldApiError";
  constructor(message: string, readonly status: number, readonly body: unknown) {
    super(message);
  }
}

interface Envelope<T> {
  output: T;
  warnings?: string[];
}

type Requester = Pick<ServerClient, "request">;

const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export class WorldClient {
  constructor(private readonly client: Requester, readonly projectId: string) {
    assertPathSafeResourceId(projectId, "projectId");
  }

  /** reset(seed, scene)：创建世界并返回句柄（含 tick=0 的初始观测）。 */
  async reset(request: WorldResetRequest, init: { signal?: AbortSignal } = {}): Promise<WorldHandle> {
    validateWorldResetRequest(request);
    const { world, observation } = await this.call<{ world: WorldSessionInfo; observation: WorldObservation }>("", { ...post(request), ...init });
    return new WorldHandle(this, world, observation);
  }

  /** 从快照新建世界（跨会话/跨进程续跑）。 */
  async restore(snapshot: WorldSnapshot, init: { signal?: AbortSignal } = {}): Promise<WorldHandle> {
    validateWorldSnapshot(snapshot);
    const { world, observation } = await this.call<{ world: WorldSessionInfo; observation: WorldObservation }>("/restore", { ...post({ snapshot }), ...init });
    return new WorldHandle(this, world, observation);
  }

  async list(): Promise<WorldSessionInfo[]> {
    const response = await this.requestRaw<{ worlds: WorldSessionInfo[] }>("", { method: "GET" });
    return response.worlds;
  }

  /** 绑定一个已存在的世界 id（例如由 MCP 智能体创建后交给脚本继续驱动）。 */
  attach(worldId: string): WorldHandle {
    return new WorldHandle(this, undefined, undefined, worldId);
  }

  /** @internal */
  async call<T>(suffix: string, init: RequestInit): Promise<T> {
    return (await this.requestRaw<Envelope<T>>(suffix, init)).output;
  }

  private async requestRaw<T>(suffix: string, init: RequestInit): Promise<T> {
    try {
      return await this.client.request<T>(`/api/projects/${encodeURIComponent(this.projectId)}/worlds${suffix}`, init);
    } catch (error) {
      if (error instanceof ServerRequestError) {
        const warnings = (error.body as { warnings?: unknown } | null)?.warnings;
        const reason = Array.isArray(warnings) && typeof warnings[0] === "string" ? warnings[0] : error.message;
        throw new WorldApiError(reason, error.status, error.body);
      }
      throw error;
    }
  }
}

export class WorldHandle {
  readonly worldId: string;
  /** reset/restore 返回的会话信息；attach 得到的句柄为 undefined。 */
  readonly info: WorldSessionInfo | undefined;
  /** reset/restore 时刻的初始观测；attach 得到的句柄为 undefined。 */
  readonly initialObservation: WorldObservation | undefined;

  constructor(private readonly owner: WorldClient, info: WorldSessionInfo | undefined, observation: WorldObservation | undefined, worldId = info?.worldId ?? "") {
    assertPathSafeResourceId(worldId, "worldId");
    this.worldId = worldId;
    this.info = info;
    this.initialObservation = observation;
  }

  /** step(action, dt)：dt 必须是 1/60 s 的整数倍（或直接传整数 ticks）。 */
  async step(request: WorldStepRequest, init: { signal?: AbortSignal } = {}): Promise<WorldStepResult> {
    validateWorldStepRequest(request);
    return this.owner.call(`/${encodeURIComponent(this.worldId)}/step`, { ...post(request), ...init });
  }

  async observe(request: WorldObserveRequest = {}, init: { signal?: AbortSignal } = {}): Promise<WorldObservation> {
    validateWorldObserveRequest(request);
    return (await this.owner.call<{ observation: WorldObservation }>(`/${encodeURIComponent(this.worldId)}/observe`, { ...post(request), ...init })).observation;
  }

  async snapshot(init: { signal?: AbortSignal } = {}): Promise<WorldSnapshot> {
    return (await this.owner.call<{ snapshot: WorldSnapshot }>(`/${encodeURIComponent(this.worldId)}/snapshot`, { ...post({}), ...init })).snapshot;
  }

  /** 原地回滚本世界到快照状态，返回回滚后的观测。 */
  async restore(snapshot: WorldSnapshot, init: { signal?: AbortSignal } = {}): Promise<WorldObservation> {
    validateWorldSnapshot(snapshot);
    const response = await this.owner.call<{ observation: WorldObservation }>("/restore", { ...post({ snapshot, worldId: this.worldId }), ...init });
    return response.observation;
  }

  async close(): Promise<boolean> {
    return (await this.owner.call<{ closed: boolean }>(`/${encodeURIComponent(this.worldId)}`, { method: "DELETE" })).closed;
  }
}
