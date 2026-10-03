/**
 * 助手 prompt 组成统计：用真实能力注册表 + 典型场景快照，输出各部分字符数与占比。
 * 运行：cd apps/api && node --conditions=development --import tsx scripts/measureAssistantPrompt.ts
 * 平台快照与对话为按真实基数合成的固定样本（见 sampleContext），能力目录取自真实注册表。
 */
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { OperationsService } from "../src/operations.js";
import { createIndustrialCapabilityHost } from "../src/industrialCapabilities.js";
import { assistantPrompts } from "../src/ai/assistantPrompts.js";
import { prepareAiInput, reliabilitySystemBoundary } from "../src/ai/aiReliabilityPolicy.js";

function sampleContext() {
  const model = (i: number) => ({ id: `model-${i}`, name: `维护预测模型 ${i}`, version: "1.2.0", algorithm: "gradient-boosting", engine: "onnx", status: "active", benchmarkOnly: false, productionEligible: true, trainRows: 120000, validationRows: 30000, metrics: { auc: 0.91, f1: 0.84, rmse: 0.12 }, updatedAt: "2026-10-01T08:00:00.000Z" });
  const study = (i: number) => ({ id: `study-${i}`, name: `实验 ${i}`, status: "completed", hypothesis: "提高节拍可降低在制品积压而不显著提升故障率", verdict: "confirmed", fingerprint: "a".repeat(64), metrics: { throughput: 118.2, wip: 14, downtime: 0.032 }, parameters: { stationCount: 12, bufferSize: 8, shiftHours: 8, seed: 42 }, updatedAt: "2026-09-30T10:00:00.000Z" });
  const event = (i: number) => ({ id: `evt-${i}`, taskId: "task-1", sourceId: "cam-1", label: "surface-scratch", score: 0.93, bbox: [10, 20, 130, 160], capturedAt: "2026-10-01T08:00:00.000Z", review: { status: "confirmed", reviewer: "qa" } });
  const dashboardWidgets = Array.from({ length: 8 }, (_, i) => ({ id: `w${i}`, title: `指标 ${i}`, key: `device.${i}.temp`, type: "line", unit: "°C", x: i % 4 * 3, y: Math.floor(i / 4) * 3, w: 3, h: 3, color: "#38bdf8" }));
  const turns = Array.from({ length: 6 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `第 ${i} 轮对话内容：${"关于设备温度与节拍的讨论，".repeat(18)}` }));
  return {
    workspace: { project: { id: "p1", name: "总装线数字孪生" }, scene: { id: "s1", name: "总装车间", modelCount: 214 }, selected: { id: "m-17", name: "AGV-17", kind: "model" }, dashboard: { id: "d1", name: "产线看板", widgets: dashboardWidgets } },
    platform: {
      loadedAt: "2026-10-03T08:00:00.000Z", contextTrust: "client-snapshot",
      rendererCapabilities: { summary: "WebGPU 可用；路径追踪受限", limited: [{ id: "pathtrace", support: "partial", reason: "需要 WebGPU" }] },
      sourceStatus: Array.from({ length: 9 }, (_, i) => ({ id: `src-${i}`, label: `来源 ${i}`, state: "ready", kind: "snapshot", count: i + 3 })),
      operations: { models: Array.from({ length: 12 }, (_, i) => model(i)), deployments: Array.from({ length: 10 }, (_, i) => ({ id: `dep-${i}`, modelId: `model-${i}`, status: "running", assetId: `asset-${i}`, intervalSeconds: 60 })),
        assessments: Array.from({ length: 20 }, (_, i) => ({ id: `as-${i}`, assetId: `asset-${i % 10}`, risk: 0.2, rul: 320, evaluatedAt: "2026-10-01T08:00:00.000Z" })),
        cases: Array.from({ length: 10 }, (_, i) => ({ id: `case-${i}`, title: `工单 ${i}`, status: "open", severity: "medium" })),
        logisticsExperiments: Array.from({ length: 6 }, (_, i) => study(i)), energyInsights: Array.from({ length: 6 }, (_, i) => ({ id: `en-${i}`, kwh: 120.5, saving: 0.07 })),
        plantLiteStudies: Array.from({ length: 6 }, (_, i) => study(i)), validationStudies: Array.from({ length: 6 }, (_, i) => study(i)), whatIfStudies: Array.from({ length: 8 }, (_, i) => study(i)), studies: Array.from({ length: 14 }, (_, i) => study(i)) },
      processPlanning: { versions: Array.from({ length: 5 }, (_, i) => ({ id: `ppr-${i}`, name: `工艺版本 ${i}`, status: "released", stationCount: 12 })) },
      battery: { models: Array.from({ length: 8 }, (_, i) => ({ id: `battery.m${i}`, family: "soh", label: `电池模型 ${i}`, modelVersion: "1.0", runtime: "onnx", outputAuthority: "advisory", productionEligible: false })), release: { blockers: ["内置候选模型尚未完成生产等价审批"], warnings: [] }, bindings: [], recentRuns: [] },
      vision: { models: Array.from({ length: 4 }, (_, i) => ({ id: `v${i}`, name: `视觉模型 ${i}`, task: "detect", status: "installed" })), sources: Array.from({ length: 4 }, (_, i) => ({ id: `cam-${i}`, kind: "rtsp", status: "online" })), tasks: Array.from({ length: 6 }, (_, i) => ({ id: `task-${i}`, status: "running" })), events: Array.from({ length: 30 }, (_, i) => event(i)) },
      data: { connections: Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, kind: "mqtt", status: "connected" })), datasets: Array.from({ length: 12 }, (_, i) => ({ id: `ds-${i}`, name: `数据集 ${i}`, fields: Array.from({ length: 10 }, (_, f) => ({ key: `f${f}`, label: `字段 ${f}`, unit: "°C", type: "number" })) })) },
    },
    contextTrust: "client-snapshot",
    recentConversation: turns,
  };
}

const directory = await mkdtemp(path.join(process.cwd(), ".measure-"));
try {
  const operations = new OperationsService(directory);
  await operations.init();
  const host = await createIndustrialCapabilityHost(operations);
  const catalog = host.registry.listCapabilities().map((capability) => ({
    id: capability.id, label: capability.label, kind: capability.kind, inputSchemaVersion: capability.inputSchemaVersion, inputSchema: capability.inputSchema,
    decisionBoundary: "目录仅表示可调用；未返回 capabilityResult 前不得声称已经执行",
  }));
  const aiProvider = { id: "ai.openai-compatible", version: "1.0.0", label: "OpenAI 兼容模型", execution: "in-process", permissions: ["ai.invoke"], streaming: true, timeoutMs: 90_000 };
  const base = sampleContext();
  const question = "当前 AGV-17 的状态怎么样？最近的实验结论对节拍有什么影响？";
  const prepared = prepareAiInput(question, base);
  const context = { ...(prepared.context as Record<string, unknown>), availableCapabilities: catalog, aiProvider };
  const prompts = assistantPrompts("platform", prepared.question, context);
  const total = prompts.systemPrompt.length + reliabilitySystemBoundary(prepared.assessment).length + prompts.userPrompt.length;
  const parts: Array<[string, number]> = [["系统指令(含可靠性边界)", prompts.systemPrompt.length + reliabilitySystemBoundary(prepared.assessment).length], ["当前问题", prepared.question.length]];
  for (const [key, value] of Object.entries(context)) parts.push([`context.${key}`, JSON.stringify(value).length]);
  console.log(JSON.stringify({ capabilityCount: catalog.length, totalChars: total, contextChars: JSON.stringify(context).length, sent: prompts.contextSentChars }));
  for (const [name, size] of parts) console.log(`${name.padEnd(34)} ${String(size).padStart(7)}  ${(size / total * 100).toFixed(1)}%`);
  const platform = (context as { platform?: Record<string, unknown> }).platform ?? {};
  for (const [key, value] of Object.entries(platform)) console.log(`  platform.${key.padEnd(24)} ${String(JSON.stringify(value).length).padStart(7)}`);
  const perCapability = catalog.map((item) => ({ id: item.id, schema: JSON.stringify(item.inputSchema).length })).sort((a, b) => b.schema - a.schema);
  console.log("catalog schema total", perCapability.reduce((sum, item) => sum + item.schema, 0), "top", JSON.stringify(perCapability.slice(0, 5)));
} finally {
  await rm(directory, { recursive: true, force: true });
}
