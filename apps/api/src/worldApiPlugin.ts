import { randomUUID } from "node:crypto";
import {
  WORLD_API_VERSION,
  WORLD_FIXED_HZ,
  WORLD_LIMITS,
  WORLD_OBSERVATION_CHANNELS,
  WORLD_RESERVED_SENSOR_KINDS,
  WorldApiContractError,
  fingerprint64,
  type AuditLogRecord,
} from "@bim-studio/contracts";
import type {
  CapabilityJsonSchema,
  CapabilityProvider,
  CapabilityProviderResult,
  CapabilityRequest,
  PluginRegistry,
} from "@bim-studio/plugin-runtime";
import { WorldRuntimeError, WorldSessionError, type WorldOwner, type WorldSessionManager } from "@bim-studio/world-runtime";

/**
 * World API v1 能力面：reset / step / observe / snapshot / restore / close。
 *
 * 一份实现同时服务 MCP（tools/list 自动列出 `industrial.world.*`，经 PluginRegistry 的
 * schema 校验、权限与超时）与 HTTP（worldApiRoutes 复用同一个 invoke）。viewer 只能调用
 * observe/snapshot（kind=query + *.read 权限）。会改变世界的调用（reset/step/restore/close）
 * 逐次写入审计日志；step 的审计带 traceHash/stateHash，形成可复核的轨迹链。
 */

export const WORLD_CAPABILITY_IDS = ["world.reset", "world.step", "world.observe", "world.snapshot", "world.restore", "world.close"] as const;

const OPEN_OBJECT: CapabilityJsonSchema = { type: "object", additionalProperties: true };
const WORLD_ID: CapabilityJsonSchema = { type: "string", minLength: 1, maxLength: WORLD_LIMITS.maxIdLength, description: "reset/restore 返回的世界 id。" };
const ACTION_SCHEMA: CapabilityJsonSchema = {
  type: "object",
  additionalProperties: false,
  description: "命令（scene-sdk 场景命令 IR）→ 物理动作 → 事件，按序原子生效。",
  properties: {
    commands: { type: "array", maxItems: WORLD_LIMITS.maxCommandsPerAction, items: OPEN_OBJECT },
    physics: { type: "array", maxItems: WORLD_LIMITS.maxPhysicsActionsPerAction, items: OPEN_OBJECT },
    events: { type: "array", maxItems: WORLD_LIMITS.maxEventsPerAction, items: OPEN_OBJECT },
  },
};

type Handler = (input: Record<string, unknown>, owner: WorldOwner) => Promise<{ output: Record<string, unknown>; stateHash: string; traceHash?: string; audit?: Record<string, unknown> }>;

interface CapabilitySpec {
  id: (typeof WORLD_CAPABILITY_IDS)[number];
  label: string;
  readOnly: boolean;
  schema: CapabilityJsonSchema;
  handle: Handler;
}

export interface WorldCapabilityOptions {
  sessions: WorldSessionManager;
  addAuditLog?: (record: AuditLogRecord) => Promise<void>;
}

function specs(sessions: WorldSessionManager): CapabilitySpec[] {
  const pick = (input: Record<string, unknown>, omit: string): Record<string, unknown> => {
    const { [omit]: _ignored, ...rest } = input;
    void _ignored;
    return rest;
  };
  return [
    {
      id: "world.reset", label: "世界重置（reset(seed, scene)）", readOnly: false,
      schema: {
        type: "object", additionalProperties: false, required: ["seed", "scene"],
        properties: {
          seed: { type: "integer", minimum: 0, maximum: WORLD_LIMITS.maxSeed },
          scene: { ...OPEN_OBJECT, description: "SceneSnapshot；无头世界只消费 primitives/models/physics 的物理相关字段。" },
          options: { type: "object", additionalProperties: false, properties: { ground: { type: "boolean" }, initialPositionJitter: { type: "number", minimum: 0, maximum: WORLD_LIMITS.maxInitialPositionJitter } } },
        },
      },
      async handle(input, owner) {
        const { info, observation } = await sessions.create(owner, input);
        return { output: { world: info, observation }, stateHash: observation.stateHash, audit: { worldId: info.worldId, seed: info.seed, objectCount: info.objectCount } };
      },
    },
    {
      id: "world.step", label: `世界步进（step(action, dt)，固定 ${WORLD_FIXED_HZ}Hz）`, readOnly: false,
      schema: {
        type: "object", additionalProperties: false, required: ["worldId"],
        properties: {
          worldId: WORLD_ID,
          action: ACTION_SCHEMA,
          dt: { type: "number", description: `秒；必须是 1/${WORLD_FIXED_HZ} 的整数倍，与 ticks 二选一。` },
          ticks: { type: "integer", minimum: 1, maximum: WORLD_LIMITS.maxTicksPerStep, description: "整数 tick，与 dt 二选一。" },
        },
      },
      async handle(input, owner) {
        const worldId = input.worldId as string;
        const result = sessions.get(owner, worldId).step(pick(input, "worldId"));
        return {
          output: { worldId, ...result }, stateHash: result.observation.stateHash, traceHash: result.traceHash,
          audit: { worldId, tickBefore: result.tickBefore, tickAfter: result.tickAfter, actionFingerprint: fingerprint64(input.action ?? {}), commandTypes: result.commandResults.map((item) => item.type) },
        };
      },
    },
    {
      id: "world.observe", label: "世界观测（observe(channels, sensors)）", readOnly: true,
      schema: {
        type: "object", additionalProperties: false, required: ["worldId"],
        properties: {
          worldId: WORLD_ID,
          channels: { type: "array", maxItems: WORLD_OBSERVATION_CHANNELS.length, items: { type: "string", enum: [...WORLD_OBSERVATION_CHANNELS] } },
          sensors: { type: "array", maxItems: WORLD_LIMITS.maxSensorsPerObservation, items: { type: "object", additionalProperties: true, description: `v1 仅登记传感器种类（${WORLD_RESERVED_SENSOR_KINDS.join("、")}），返回 unsupported 占位。` } },
        },
      },
      async handle(input, owner) {
        const worldId = input.worldId as string;
        const observation = sessions.get(owner, worldId).observe(pick(input, "worldId"));
        return { output: { worldId, observation }, stateHash: observation.stateHash };
      },
    },
    {
      id: "world.snapshot", label: "世界快照（snapshot()）", readOnly: true,
      schema: { type: "object", additionalProperties: false, required: ["worldId"], properties: { worldId: WORLD_ID } },
      async handle(input, owner) {
        const worldId = input.worldId as string;
        const world = sessions.get(owner, worldId);
        const snapshot = world.snapshot();
        sessions.noteSnapshotIssued(snapshot.snapshotHash);
        return { output: { worldId, snapshot }, stateHash: world.observe({ channels: [] }).stateHash, traceHash: snapshot.traceHash };
      },
    },
    {
      id: "world.restore", label: "世界恢复（restore(snapshot)）", readOnly: false,
      schema: {
        type: "object", additionalProperties: false, required: ["snapshot"],
        properties: { snapshot: { ...OPEN_OBJECT, description: "world.snapshot 返回的 WorldSnapshot。" }, worldId: { ...WORLD_ID, description: "给定则原地回滚该世界；省略则从快照新建世界。" } },
      },
      async handle(input, owner) {
        const source = input.snapshot as { snapshotHash?: string; traceHash?: string; seed?: number; sceneHash?: string };
        const { info, observation } = await sessions.restore(owner, input.snapshot, input.worldId as string | undefined);
        // 快照里的 traceHash/tick 是客户端可构造的链根：审计如实记录来源与是否为本服务近期签发，使"重置链根"可见。
        return {
          output: { world: info, observation }, stateHash: observation.stateHash,
          audit: {
            worldId: info.worldId, tick: info.tick, snapshotHash: source.snapshotHash, snapshotTraceHash: source.traceHash,
            snapshotSeed: source.seed, sceneHash: source.sceneHash, issuedByServer: sessions.wasSnapshotIssued(source.snapshotHash ?? ""),
          },
        };
      },
    },
    {
      id: "world.close", label: "关闭世界", readOnly: false,
      schema: { type: "object", additionalProperties: false, required: ["worldId"], properties: { worldId: WORLD_ID } },
      async handle(input, owner) {
        const worldId = input.worldId as string;
        const closed = sessions.close(owner, worldId);
        // 未命中（不存在/非本人）没有改变任何状态，不写审计，也避免调用方用任意字符串污染审计行。
        return { output: { worldId, closed }, stateHash: "", ...(closed ? { audit: { worldId } } : {}) };
      },
    },
  ];
}

/** 合同/运行时/会话层的"调用方可修正"错误统一回 blocked + 原因，其余异常交给 registry 记为 provider-failed。 */
/**
 * 世界归属主体：与 MCP 适配层（mcpCapabilityAdapter.callTool）使用同一格式，
 * 这样同一用户经 MCP 创建的世界可以经 HTTP 继续 step，反之亦然。
 */
export function worldPrincipal(user: { id: string; username: string } | undefined): string {
  return user ? `${user.username}:${user.id}` : "internal-mcp-test";
}

/**
 * 世界配额与归属一律按稳定用户 id 计：MCP 传 `username:id`，通用能力路由与 AI 网关传纯 `id`，
 * 取最后一个冒号之后的部分统一成 id（id 为 UUID，不含冒号；用户名里带冒号也无法冒充他人 id）。
 */
export function normalizeWorldPrincipal(principal: string): string {
  return principal.slice(principal.lastIndexOf(":") + 1) || principal;
}

function blockedResult(error: unknown): CapabilityProviderResult | undefined {
  const known = error instanceof WorldApiContractError || error instanceof WorldRuntimeError || error instanceof WorldSessionError;
  if (!known) return undefined;
  return { status: "blocked", decisionStatus: "insufficient-data", warnings: [error.message], output: { error: { name: error.name, code: (error as { code?: string }).code } } };
}

export function createWorldCapabilityProviders(options: WorldCapabilityOptions): Array<CapabilityProvider<Record<string, unknown>>> {
  return specs(options.sessions).map((spec) => ({
    descriptor: {
      id: spec.id,
      version: "1.0.0",
      label: spec.label,
      kind: spec.readOnly ? "query" : "simulation",
      execution: "in-process",
      permissions: [spec.readOnly ? "simulation.read" : "simulation.execute"],
      timeoutMs: 30_000,
      inputSchemaVersion: WORLD_API_VERSION,
      outputSchemaVersion: WORLD_API_VERSION,
      inputSchema: spec.schema,
      outputSchema: OPEN_OBJECT,
      riskLevel: "low",
      approvalRequired: false,
    },
    async invoke(request: CapabilityRequest<Record<string, unknown>>): Promise<CapabilityProviderResult> {
      const owner: WorldOwner = { projectId: request.projectId, principal: normalizeWorldPrincipal(request.principal) };
      // 演练请求不能真实改变世界：本能力面没有"只校验不执行"的语义，直接明确拒绝而不是静默执行。
      if (request.dryRun === true && !spec.readOnly) {
        return { status: "blocked", decisionStatus: "insufficient-data", warnings: [`${spec.id} 会真实改变世界，不支持 dryRun；如需演练请先 snapshot，再对副本 restore 后执行`] };
      }
      try {
        const done = await spec.handle(request.input, owner);
        const warnings: string[] = [];
        if (!spec.readOnly && done.audit) {
          const audited = await writeAudit(options, spec.id, request, { ...done.audit, ...(done.traceHash ? { traceHash: done.traceHash } : {}), ...(done.stateHash ? { stateHash: done.stateHash } : {}) });
          if (!audited) warnings.push("世界操作审计未能持久化，请勿将本次结果视为完整审计证据");
        }
        return {
          status: "completed",
          decisionStatus: "research-candidate",
          output: done.output,
          ...(warnings.length ? { warnings } : {}),
          evidence: done.stateHash
            ? [{ id: `${spec.id}:${done.traceHash ?? done.stateHash}`, kind: "simulation", label: "确定性世界状态指纹（stateHash）", source: `world-api/${WORLD_API_VERSION}`, fingerprint: done.stateHash }]
            : [],
        };
      } catch (error) {
        const blocked = blockedResult(error);
        if (blocked) return blocked;
        throw error;
      }
    },
  }));
}

async function writeAudit(options: WorldCapabilityOptions, capabilityId: string, request: CapabilityRequest, detail: Record<string, unknown>): Promise<boolean> {
  if (!options.addAuditLog) return true;
  try {
    const [username, userId] = splitPrincipal(request.principal);
    await options.addAuditLog({
      id: randomUUID(),
      ...(userId ? { userId } : {}),
      ...(username ? { username } : {}),
      action: capabilityId,
      resource: `/projects/${encodeURIComponent(request.projectId)}/worlds`,
      method: "WORLD",
      statusCode: 200,
      detail: JSON.stringify({ requestId: request.requestId, ...detail }),
      createdAt: new Date().toISOString(),
    });
    return true;
  } catch {
    return false;
  }
}

/** `username:id` → [username, id]；纯 id（通用路由/AI 网关）→ [undefined, id]。与全局审计钩子的 username/userId 字段对齐。 */
function splitPrincipal(principal: string): [string | undefined, string] {
  const index = principal.lastIndexOf(":");
  return index < 0 ? [undefined, principal] : [principal.slice(0, index), principal.slice(index + 1)];
}

export async function registerWorldApiPlugin(registry: PluginRegistry, options: WorldCapabilityOptions): Promise<void> {
  const manifest = {
    schemaVersion: 1 as const,
    id: "bim.world-api",
    name: "World API v1",
    version: "1.0.0",
    apiVersion: "1.0",
    hosts: ["cloud"] as const,
    capabilities: ["simulation.world"],
    permissions: ["simulation.read", "simulation.execute"],
    extensionPoints: [{
      kind: "capability.provider" as const,
      id: "bim.world-api",
      capabilityIds: [...WORLD_CAPABILITY_IDS],
      execution: "in-process" as const,
      // 快照恢复载荷最大约 21 MB（16 MiB 物理字节的 base64）。
      limits: { timeoutMs: 30_000, maxInputBytes: 24 * 1024 * 1024, memoryMb: 256 },
    }],
  };
  const registered = registry.register(manifest, ({ registerCapability }) => {
    for (const provider of createWorldCapabilityProviders(options)) {
      const result = registerCapability(provider);
      if (!result.ok) throw new Error(`World API 能力注册失败：${result.message}`);
    }
  });
  if (!registered.ok) throw new Error(`World API 插件不兼容：${registered.message}`);
  const enabled = await registry.enable(manifest.id);
  if (!enabled.ok) throw new Error(`World API 插件启用失败：${enabled.message}`);
}
