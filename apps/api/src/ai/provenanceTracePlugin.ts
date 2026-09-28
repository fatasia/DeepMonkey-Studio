import type { CapabilityJsonSchema, CapabilityProvider } from "@bim-studio/plugin-runtime";
import type { PluginRegistry } from "@bim-studio/plugin-runtime";
import type { AiProvenanceQuery } from "@bim-studio/contracts";
import type { ProvenanceLedgerStore } from "./provenanceLedger.js";

/**
 * H-C3 档案室：`provenance.trace` 查询能力（read/low）。
 *
 * 回答"这个结论由哪次运行、哪个假设、哪些证据支持"：按 resultFingerprint /
 * proposalFingerprint / 时间窗任一维度查三跳链（假设→运行→判定[→报告]），
 * 返回结构化链与全库完整性核查。注册进 PluginRegistry 后由 MCP tools/list
 * 自动暴露（read-only hint），网关侧加入 CURATED 白名单（计划模式亦放行 read）。
 * 诚实条款：无记录时 matched=false + 零链，查询方必须如实呈现"无档案记录"，不得伪造。
 */

const TRACE_INPUT_SCHEMA: CapabilityJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    query: {
      type: "object",
      additionalProperties: false,
      description: "三跳查询条件；四类维度可任选组合，全缺省返回全部链（受 limit 约束）。",
      properties: {
        resultFingerprint: { type: "string", minLength: 16, maxLength: 16, description: "按内核运行结果指纹精确查链（16 位小写十六进制）。" },
        proposalFingerprint: { type: "string", minLength: 16, maxLength: 16, description: "按假设提案指纹查该假设的全部运行与判定（16 位小写十六进制）。" },
        since: { type: "string", description: "时间窗起点（UTC ISO 8601，含）。" },
        until: { type: "string", description: "时间窗终点（UTC ISO 8601，含）。" },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "返回链数上限，缺省 20。" },
      },
    },
  },
};

const TRACE_OUTPUT_SCHEMA: CapabilityJsonSchema = {
  type: "object",
  description: "三跳链查询结果：matched=false 表示档案无记录（如实未命中）。",
  additionalProperties: true,
};

export function createProvenanceTraceProvider(ledger: ProvenanceLedgerStore): CapabilityProvider<{ query?: unknown }> {
  return {
    descriptor: {
      id: "provenance.trace",
      version: "1.0.0",
      label: "实验档案三跳查询",
      kind: "query",
      execution: "in-process",
      permissions: ["simulation.read"],
      timeoutMs: 5_000,
      inputSchemaVersion: "1.0",
      outputSchemaVersion: "1.0",
      inputSchema: TRACE_INPUT_SCHEMA,
      outputSchema: TRACE_OUTPUT_SCHEMA,
    },
    async invoke(request) {
      const input = (request.input ?? {}) as { query?: unknown };
      const trace = await ledger.trace(request.projectId, (input.query ?? {}) as AiProvenanceQuery);
      return {
        status: "completed",
        decisionStatus: "research-candidate",
        output: trace,
        evidence: trace.chains.map((chain) => ({
          id: chain.hypothesis.proposalFingerprint,
          kind: "trace" as const,
          label: `三跳链：${chain.hypothesis.hypothesisId}（${chain.runs.length} 次运行，${chain.integrity === "intact" ? "链完整" : "链断裂"}）`,
          source: `provenance:${chain.hypothesis.targetModel}`,
          ...(chain.runs[0] ? { fingerprint: chain.runs[0].resultFingerprint } : { fingerprint: chain.hypothesis.proposalFingerprint }),
        })),
      };
    },
  };
}

/** 独立插件注册：与假设 harness 同构（registerXxxPlugin 模式）。 */
export async function registerProvenanceTracePlugin(registry: PluginRegistry, options: { ledger: ProvenanceLedgerStore }): Promise<void> {
  const manifest = {
    schemaVersion: 1 as const,
    id: "bim.ai.provenance-trace",
    name: "Provenance trace archive",
    version: "1.0.0",
    apiVersion: "1.0",
    hosts: ["cloud"] as const,
    capabilities: ["provenance.trace"],
    permissions: ["simulation.read"],
    extensionPoints: [{
      kind: "capability.provider" as const,
      id: "bim.provenance-trace",
      capabilityIds: ["provenance.trace"],
      execution: "in-process" as const,
      limits: { timeoutMs: 5_000, maxInputBytes: 64 * 1024, memoryMb: 64 },
    }],
  };
  const registered = registry.register(manifest, ({ registerCapability }) => {
    const result = registerCapability(createProvenanceTraceProvider(options.ledger));
    if (!result.ok) throw new Error(`档案查询能力注册失败：${result.message}`);
  });
  if (!registered.ok) throw new Error(`档案查询插件不兼容：${registered.message}`);
  const enabled = await registry.enable(manifest.id);
  if (!enabled.ok) throw new Error(`档案查询插件启用失败：${enabled.message}`);
}
