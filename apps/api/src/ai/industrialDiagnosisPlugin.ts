import type {
  IndustrialDiagnosisAction,
  IndustrialDiagnosisHypothesis,
  IndustrialDiagnosisInput,
  IndustrialDiagnosisResult,
  IndustrialSemanticNode,
} from "@bim-studio/contracts";
import type { CapabilityProvider, PluginRegistry } from "@bim-studio/plugin-runtime";
import { industrialDiagnosisInputSchema, industrialDiagnosisOutputSchema } from "./industrialDiagnosisSchemas.js";

/**
 * 注册轻量工业诊断插件。它编排已有模型证据，不替代预测模型，也不会把语言模型文本
 * 当成根因结论；没有配置外部 AI Provider 时仍可稳定运行。
 */
export async function registerIndustrialDiagnosisPlugin(registry: PluginRegistry): Promise<void> {
  const manifest = {
    schemaVersion: 1 as const,
    id: "bim.ai.industrial-diagnosis",
    name: "Industrial evidence diagnosis",
    version: "1.0.0",
    apiVersion: "1.0",
    hosts: ["cloud"] as const,
    capabilities: ["industrial.ai.diagnosis"],
    permissions: ["operations.read"],
    extensionPoints: [
      {
        kind: "capability.provider" as const,
        id: "bim.industrial-diagnosis",
        capabilityIds: ["industrial.ai.diagnosis.compose"],
        execution: "in-process" as const,
        limits: { timeoutMs: 5_000, maxInputBytes: 512 * 1024, memoryMb: 64 },
      },
    ],
  };
  const registered = registry.register(manifest, ({ registerCapability }) => {
    const result = registerCapability(createIndustrialDiagnosisProvider());
    if (!result.ok) throw new Error(`工业诊断能力注册失败：${result.message}`);
  });
  if (!registered.ok) throw new Error(`工业诊断插件不兼容：${registered.message}`);
  const enabled = await registry.enable(manifest.id);
  if (!enabled.ok) throw new Error(`工业诊断插件启用失败：${enabled.message}`);
}

export function createIndustrialDiagnosisProvider(): CapabilityProvider<
  IndustrialDiagnosisInput,
  IndustrialDiagnosisResult
> {
  return {
    descriptor: {
      id: "industrial.ai.diagnosis.compose",
      version: "1.0.0",
      label: "工业设备证据诊断",
      kind: "analysis",
      execution: "in-process",
      permissions: ["operations.read"],
      timeoutMs: 5_000,
      inputSchemaVersion: "1.0",
      outputSchemaVersion: "1.0",
      inputSchema: industrialDiagnosisInputSchema,
      outputSchema: industrialDiagnosisOutputSchema,
    },
    async invoke(request) {
      const result = composeIndustrialDiagnosis(request.input);
      return {
        status: "completed",
        decisionStatus:
          result.decisionStatus === "validated"
            ? "production"
            : result.decisionStatus === "insufficient-data"
              ? "insufficient-data"
              : "shadow",
        confidence: result.confidence,
        output: result,
        evidence: [
          {
            id: result.evidenceFingerprint,
            kind: "trace",
            label: "预测维护诊断证据",
            source: `assessment:${request.input.assessment.id}`,
            fingerprint: result.evidenceFingerprint,
          },
        ],
        suggestedActions: result.actions.map((action) => ({
          id: action.id,
          label: action.label,
          commandType: `maintenance.${action.kind}`,
          input: {
            actionId: action.id,
            assessmentId: request.input.assessment.id,
          },
          risk:
            action.priority === "now"
              ? ("high" as const)
              : action.priority === "next"
                ? ("medium" as const)
                : ("low" as const),
          requiresConfirmation: action.kind === "create-case" || action.kind === "inspect",
        })),
      };
    },
  };
}

export function composeIndustrialDiagnosis(input: IndustrialDiagnosisInput): IndustrialDiagnosisResult {
  const { assessment, model, asset } = input;
  const facts = buildFacts(input);
  const limited = assessment.decisionStatus === "insufficient-data" || assessment.decisionStatus === "drift-blocked";
  const hypotheses = limited || assessment.riskLevel === "normal" ? [] : buildHypotheses(assessment.topContributors);
  const actions = buildActions(input, limited);
  const limitations = buildLimitations(input, limited);
  return {
    generatedBy: "industrial-diagnosis-plugin",
    reasoningMode: "evidence-orchestration",
    severity: assessment.riskLevel,
    decisionStatus: assessment.decisionStatus,
    confidence: clamp(assessment.dataQuality, 0, 1),
    headline: diagnosisHeadline(assessment.riskLevel, limited),
    summary: diagnosisSummary(input, hypotheses, limited),
    facts,
    hypotheses,
    actions,
    validationDraft: {
      sourceAssessmentId: assessment.id,
      objective: limited
        ? "验证数据质量与特征映射后重新评估"
        : `验证“${hypotheses[0]?.title ?? "设备劣化"}”是否会触发联锁与告警`,
      signals: unique(["motorRunning", "alarm", ...assessment.topContributors.slice(0, 3).map((item) => item.feature)]),
      acceptanceCriteria: limited
        ? ["数据完整率达到模型门槛", "特征漂移回到允许范围"]
        : ["故障注入后设备进入安全状态", "告警锁存可见且复位后恢复", "验收结果生成可追溯证据指纹"],
      ...(asset?.sceneId ? { sceneId: asset.sceneId } : {}),
      ...(asset?.objectIds[0] ? { objectId: asset.objectIds[0] } : {}),
    },
    semanticGraph: buildSemanticGraph(input),
    limitations,
    evidenceFingerprint: assessment.evidenceFingerprint,
  };
}

function buildFacts({ assessment, model, asset }: IndustrialDiagnosisInput): string[] {
  return [
    `模型 ${model.name} ${model.version}（${model.algorithm}）`,
    `数据完整率 ${(assessment.dataQuality * 100).toFixed(0)}%，漂移 ${assessment.driftScore.toFixed(2)}σ，样本 ${assessment.sampleCount} 条`,
    assessment.score === undefined
      ? "模型未产生有效风险分数"
      : `风险分数 ${(assessment.score * 100).toFixed(1)}%，等级 ${assessment.riskLevel}`,
    asset ? `诊断对象 ${asset.name}，关联 ${asset.objectIds.length} 个场景对象` : "尚未绑定场景设备",
  ];
}

function buildHypotheses(
  contributors: IndustrialDiagnosisInput["assessment"]["topContributors"],
): IndustrialDiagnosisHypothesis[] {
  return contributors.slice(0, 3).map((item, index) => {
    const mapped = featureMeaning(item.feature);
    return {
      id: `hypothesis-${index + 1}`,
      rank: index + 1,
      title: mapped.title,
      rationale: `${item.feature} 是当前第 ${index + 1} 贡献特征（贡献值 ${item.value.toFixed(3)}）；${mapped.rationale}`,
      evidence: [item.feature, `contribution:${item.value}`],
      status: "candidate",
    };
  });
}

function buildActions(input: IndustrialDiagnosisInput, limited: boolean): IndustrialDiagnosisAction[] {
  if (limited)
    return [
      {
        id: "validate-data",
        kind: "validate-data",
        priority: "now",
        label: "核对数据与特征映射",
        reason: input.assessment.message,
      },
      {
        id: "rerun",
        kind: "monitor",
        priority: "next",
        label: "修复后重新评估",
        reason: "当前证据不足以支持设备处置",
      },
    ];
  if (input.assessment.riskLevel === "normal")
    return [
      {
        id: "monitor",
        kind: "monitor",
        priority: "observe",
        label: "继续按现有频率监测",
        reason: "当前模型证据未达到点检或建案门槛",
      },
    ];
  const urgent = input.assessment.riskLevel === "critical";
  return [
    {
      id: "inspect",
      kind: "inspect",
      priority: urgent ? "now" : "next",
      label: urgent ? "立即点检关键部件" : "安排重点点检",
      reason: "优先验证高贡献特征对应的物理部件",
    },
    {
      id: "simulate",
      kind: "simulate",
      priority: "next",
      label: "生成虚拟验收方案",
      reason: "验证故障、联锁、告警与复位逻辑",
    },
    {
      id: "create-case",
      kind: "create-case",
      priority: urgent ? "now" : "next",
      label: "创建维护 Case",
      reason: "保存责任人、证据与后续处置结果",
    },
  ];
}

function buildLimitations(input: IndustrialDiagnosisInput, limited: boolean): string[] {
  const items = ["高贡献特征只能形成待验证假设，不能直接证明机械根因"];
  if (limited) items.unshift(input.assessment.message);
  if (input.model.benchmarkOnly) items.push("模型基于公开或合成基准，只允许影子验证");
  if (!input.model.productionEligible) items.push("模型尚未通过生产发布门禁");
  if (!input.asset) items.push("未绑定场景设备，暂不能一键定位或生成对象级验收映射");
  return unique(items);
}

function buildSemanticGraph(input: IndustrialDiagnosisInput) {
  const assessmentId = `assessment:${input.assessment.id}`;
  const modelId = `model:${input.model.id}`;
  const assetId = `asset:${input.asset?.id ?? input.assessment.deploymentId}`;
  const nodes: IndustrialSemanticNode[] = [
    { id: assessmentId, kind: "assessment", label: "维护评估" },
    { id: modelId, kind: "model", label: input.model.name },
    { id: assetId, kind: "asset", label: input.asset?.name ?? "未绑定设备" },
    {
      id: `evidence:${input.assessment.evidenceFingerprint}`,
      kind: "evidence",
      label: "评估证据指纹",
    },
  ];
  for (const item of input.assessment.topContributors.slice(0, 5))
    nodes.push({
      id: `signal:${item.feature}`,
      kind: "signal",
      label: item.feature,
    });
  return {
    nodes,
    edges: [
      { from: assetId, to: modelId, relation: "assessed-by" as const },
      { from: assessmentId, to: modelId, relation: "derived-from" as const },
      {
        from: assessmentId,
        to: `evidence:${input.assessment.evidenceFingerprint}`,
        relation: "derived-from" as const,
      },
      ...input.assessment.topContributors.slice(0, 5).map((item) => ({
        from: assetId,
        to: `signal:${item.feature}`,
        relation: "observes" as const,
      })),
    ],
  };
}

function featureMeaning(feature: string): { title: string; rationale: string } {
  const key = feature.toLowerCase();
  if (/vib|振动|accel/.test(key))
    return {
      title: "旋转部件振动异常",
      rationale: "建议核查轴承、联轴器、松动与不对中",
    };
  if (/temp|温度|thermal/.test(key))
    return {
      title: "热状态偏离",
      rationale: "建议核查润滑、散热、负载与局部过热",
    };
  if (/current|amp|电流|power/.test(key))
    return {
      title: "电气负载异常",
      rationale: "建议核查过载、堵转、电源质量与驱动参数",
    };
  if (/pressure|压力/.test(key))
    return {
      title: "压力回路异常",
      rationale: "建议核查泄漏、阀件、堵塞与设定值",
    };
  if (/soc|soh|rul|voltage|电压|容量/.test(key))
    return {
      title: "电池健康或寿命偏离",
      rationale: "建议结合 SOC/SOH/RUL 多模型结果与工况复核",
    };
  return {
    title: `${feature} 特征偏离`,
    rationale: "需要结合设备机理、工况和现场点检确认",
  };
}

function diagnosisHeadline(risk: IndustrialDiagnosisInput["assessment"]["riskLevel"], limited: boolean): string {
  if (limited) return "证据不足，先修复数据再决策";
  if (risk === "critical") return "设备存在高风险，需要立即验证与处置";
  if (risk === "warning") return "设备出现劣化迹象，建议安排重点点检";
  if (risk === "normal") return "当前运行正常，继续按现有频率监测";
  return "当前风险未知，需要补充有效数据";
}

function diagnosisSummary(
  input: IndustrialDiagnosisInput,
  hypotheses: IndustrialDiagnosisHypothesis[],
  limited: boolean,
): string {
  if (limited) return input.assessment.message;
  if (input.assessment.riskLevel === "normal") return "当前数据质量和模型输出均未达到处置门槛，保持现有监测频率即可。";
  const lead = hypotheses[0]?.title ?? "设备状态偏离";
  return `模型证据首先指向“${lead}”。该结论是待验证假设，建议结合点检和虚拟调试确认后再形成根因结论。`;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
