import type { CapabilityJsonSchema, CapabilityProvider } from "@bim-studio/plugin-runtime";
import type { PluginRegistry } from "@bim-studio/plugin-runtime";
import { AiHypothesisContractError } from "@bim-studio/contracts";
import type { SimulationStudyTaskError, SimulationStudyTaskStore, SimulationStudyTaskView } from "./simulationStudyTasks.js";
import { hypothesisSchema } from "./simulationHypothesisPlugin.js";

/**
 * H-C3 后续切片：MCP Tasks 异步长跑任务面（三个 Capability）。
 *
 * - `simulation.study.run-async`（simulation/medium）：发起长跑即返回 durable 句柄
 *   （taskId + inputFingerprint），不等待完成；假设合同校验 fail-closed，合同外形状不进内核域。
 * - `simulation.study.status`（query/read·low）：轮询进度与结果（readOnlyHint）；
 *   未知句柄如实返回任务不存在，不伪造。
 * - `simulation.study.cancel`（simulation/medium）：mid-flight 取消——停止调度，
 *   已产出部分证据如实标注 partial；完成态取消不生效（如实返回 blocked）。
 *
 * 预算与保安：repeats/wallClock 双上限（超限 fail-closed 取消并如实标注
 * budget-exceeded）、每项目并发上限、取消按提交者/admin 校验——硬防线在能力与
 * 任务存储，不在提示词。长跑受 C2 保安同源预算纪律约束（不新增旁路）。
 *
 * 诚实条款：取消/失败不伪造成 completed；账本"进行中链"在发起处落
 * （假设节点 + 运行中记录），完成处按同指纹幂等收口（断线恢复续写不重复成链）。
 */

const RUN_ASYNC_INPUT_SCHEMA: CapabilityJsonSchema = {
  type: "object",
  additionalProperties: false,
  description: "发起长跑假设研究：立即返回 durable 任务句柄，用 simulation.study.status 轮询，simulation.study.cancel 可中途取消。",
  properties: {
    hypothesis: hypothesisSchema(),
    budget: {
      type: "object",
      additionalProperties: false,
      description: "预算（fail-closed）：超过任一上限即取消并如实标注 budget-exceeded；缺省 repeats=1、wallClockMs=120000。",
      properties: {
        repeats: { type: "integer", minimum: 1, maximum: 3600, description: "重复次数（CPU 长跑代理口径；确定性研究同输入同指纹）。" },
        wallClockMs: { type: "integer", minimum: 1000, maximum: 600000, description: "墙钟预算上限（毫秒）。" },
      },
    },
  },
  required: ["hypothesis"],
};

const OPEN_OBJECT_OUTPUT: CapabilityJsonSchema = {
  type: "object",
  description: "任务句柄 / 进度快照 / 取消回执；字段由任务存储合同管理。",
  additionalProperties: true,
};

function toTaskEvidence(view: SimulationStudyTaskView, label: string): Array<{
  id: string;
  kind: "simulation" | "trace" | "rule";
  label: string;
  source: string;
  fingerprint?: string;
}> {
  const evidence: Array<{ id: string; kind: "simulation" | "trace" | "rule"; label: string; source: string; fingerprint?: string }> = [
    { id: view.taskId, kind: "rule", label, source: `study-task:${view.taskId}`, fingerprint: view.proposalFingerprint },
  ];
  if (view.resultFingerprint) {
    evidence.push({ id: view.resultFingerprint, kind: "simulation", label: "长跑研究结果指标指纹", source: `study-task:${view.taskId}`, fingerprint: view.resultFingerprint });
  }
  return evidence;
}

function taskBlocked(error: SimulationStudyTaskError) {
  return { status: "blocked" as const, decisionStatus: "insufficient-data" as const, warnings: [`${error.code}: ${error.message}`] };
}

/** 发起长跑：即返 durable 句柄（running），执行在后台推进。 */
export function createStudyRunAsyncProvider(tasks: SimulationStudyTaskStore): CapabilityProvider<{ hypothesis: unknown; budget?: unknown }> {
  return {
    descriptor: {
      id: "simulation.study.run-async",
      version: "1.0.0",
      label: "长跑假设研究（异步发起）",
      kind: "simulation",
      execution: "in-process",
      permissions: ["simulation.execute"],
      timeoutMs: 5_000,
      inputSchemaVersion: "1.0",
      outputSchemaVersion: "1.0",
      inputSchema: RUN_ASYNC_INPUT_SCHEMA,
      outputSchema: OPEN_OBJECT_OUTPUT,
    },
    async invoke(request) {
      const input = (request.input ?? {}) as { hypothesis?: unknown; budget?: unknown };
      try {
        const record = await tasks.launch(request.projectId, request.principal, {
          hypothesis: input.hypothesis,
          ...(input.budget !== undefined && input.budget !== null ? { budget: input.budget as { repeats?: unknown; wallClockMs?: unknown } } : {}),
        });
        return {
          status: "completed",
          decisionStatus: "research-candidate",
          ...(record.warnings.length ? { warnings: [...record.warnings] } : {}),
          output: {
            taskId: record.taskId,
            status: record.status,
            proposalFingerprint: record.proposalFingerprint,
            inputFingerprint: record.inputFingerprint,
            budget: record.budget,
            progress: record.progress,
            pollWith: { tool: "simulation.study.status", taskId: record.taskId },
            cancelWith: { tool: "simulation.study.cancel", taskId: record.taskId },
          },
          evidence: toTaskEvidence(record, "长跑任务 durable 句柄（发起即返回，不阻塞调用）"),
        };
      } catch (error) {
        if (error instanceof AiHypothesisContractError) {
          // 语义预检拒绝：合同外形状不进入长跑域（与 golden.verify 同一口径）。
          return { status: "blocked", decisionStatus: "insufficient-data", warnings: [`${error.field}: ${error.message}`] };
        }
        if (isTaskError(error)) return taskBlocked(error);
        throw error;
      }
    },
  };
}

/** 轮询进度：未知句柄如实 blocked（不伪造进度），完成时随行完整信封与三跳指纹。 */
export function createStudyStatusProvider(tasks: SimulationStudyTaskStore): CapabilityProvider<{ taskId?: unknown }> {
  return {
    descriptor: {
      id: "simulation.study.status",
      version: "1.0.0",
      label: "长跑任务进度轮询",
      kind: "query",
      execution: "in-process",
      permissions: ["simulation.read"],
      timeoutMs: 5_000,
      inputSchemaVersion: "1.0",
      outputSchemaVersion: "1.0",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        description: "按 durable 句柄查询长跑任务状态；轮询建议间隔 ≥1s。",
        properties: { taskId: { type: "string", minLength: 22, maxLength: 22, description: "run-async 返回的任务句柄（study-<16 位十六进制>）。" } },
        required: ["taskId"],
      },
      outputSchema: OPEN_OBJECT_OUTPUT,
    },
    async invoke(request) {
      const input = (request.input ?? {}) as { taskId?: unknown };
      if (typeof input.taskId !== "string") {
        return { status: "blocked", decisionStatus: "insufficient-data", warnings: ["taskId: 必须是 run-async 返回的任务句柄字符串"] };
      }
      try {
        const view = await tasks.status(request.projectId, input.taskId);
        if (!view) {
          return { status: "blocked", decisionStatus: "insufficient-data", warnings: ["task-not-found: 任务不存在或不在该项目下（如实未命中）"] };
        }
        return {
          status: "completed",
          decisionStatus: "research-candidate",
          ...(view.warnings.length ? { warnings: [...view.warnings] } : {}),
          output: view,
          evidence: toTaskEvidence(view, view.status === "completed" ? "长跑任务已完成（含验证信封）" : "长跑任务进度"),
        };
      } catch (error) {
        if (isTaskError(error)) return taskBlocked(error);
        throw error;
      }
    },
  };
}

/** mid-flight 取消：停止调度 + 已产出部分证据如实标注 partial；语义幂等（重复取消返回当前态）。 */
export function createStudyCancelProvider(tasks: SimulationStudyTaskStore): CapabilityProvider<{ taskId?: unknown }> {
  return {
    descriptor: {
      id: "simulation.study.cancel",
      version: "1.0.0",
      label: "长跑任务中途取消",
      kind: "simulation",
      execution: "in-process",
      permissions: ["simulation.execute"],
      timeoutMs: 5_000,
      inputSchemaVersion: "1.0",
      outputSchemaVersion: "1.0",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        description: "取消运行中的长跑任务：停止后续调度，已产出部分证据如实标注 partial；只有提交者或管理员可取消。",
        properties: { taskId: { type: "string", minLength: 22, maxLength: 22, description: "run-async 返回的任务句柄。" } },
        required: ["taskId"],
      },
      outputSchema: OPEN_OBJECT_OUTPUT,
    },
    async invoke(request) {
      const input = (request.input ?? {}) as { taskId?: unknown };
      if (typeof input.taskId !== "string") {
        return { status: "blocked", decisionStatus: "insufficient-data", warnings: ["taskId: 必须是 run-async 返回的任务句柄字符串"] };
      }
      try {
        const view = await tasks.cancel(request.projectId, input.taskId, { principal: request.principal, ...(request.role ? { role: request.role } : {}) });
        return {
          status: "completed",
          decisionStatus: "research-candidate",
          warnings: [
            `任务 ${view.taskId} 已处于取消态（幂等回执；本次取消生效或此前已取消）`,
            `已产出部分证据如实保留：completedRepeats=${view.progress.completedRepeats}/${view.progress.totalRepeats}，partial=${view.partial}`,
          ],
          output: view,
          evidence: toTaskEvidence(view, "长跑任务取消回执（如实标注，不伪造成 completed）"),
        };
      } catch (error) {
        if (isTaskError(error)) return taskBlocked(error);
        throw error;
      }
    },
  };
}

function isTaskError(error: unknown): error is SimulationStudyTaskError {
  return error instanceof Error && error.name === "SimulationStudyTaskError";
}

/**
 * 独立插件注册：与假设 harness / 档案查询同构（registerXxxPlugin 模式）。
 * tasks 存储由宿主装配（dataDir 唯一实例，内部持 golden provider 与可选账本联动）。
 */
export async function registerSimulationStudyAsyncPlugin(
  registry: PluginRegistry,
  options: { tasks: SimulationStudyTaskStore },
): Promise<void> {
  const manifest = {
    schemaVersion: 1 as const,
    id: "bim.ai.simulation-study-async",
    name: "Simulation study async tasks",
    version: "1.0.0",
    apiVersion: "1.0",
    hosts: ["cloud"] as const,
    capabilities: ["simulation.study"],
    permissions: ["simulation.execute", "simulation.read"],
    extensionPoints: [{
      kind: "capability.provider" as const,
      id: "bim.simulation-study-async",
      capabilityIds: ["simulation.study.run-async", "simulation.study.status", "simulation.study.cancel"],
      execution: "in-process" as const,
      limits: { timeoutMs: 5_000, maxInputBytes: 1024 * 1024, memoryMb: 128 },
    }],
  };
  const registered = registry.register(manifest, ({ registerCapability }) => {
    for (const provider of [
      createStudyRunAsyncProvider(options.tasks),
      createStudyStatusProvider(options.tasks),
      createStudyCancelProvider(options.tasks),
    ]) {
      const result = registerCapability(provider);
      if (!result.ok) throw new Error(`长跑任务能力注册失败：${result.message}`);
    }
  });
  if (!registered.ok) throw new Error(`长跑任务插件不兼容：${registered.message}`);
  const enabled = await registry.enable(manifest.id);
  if (!enabled.ok) throw new Error(`长跑任务插件启用失败：${enabled.message}`);
}
