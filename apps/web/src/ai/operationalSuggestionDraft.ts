import type { AiSampleResult, OperationalCaseRecord } from "@bim-studio/contracts";

export interface OperationalSuggestionDraft {
  projectId: string;
  reference: string;
  source: "local-sample" | "project-data" | "uploaded-file";
  title: string;
  type: OperationalCaseRecord["type"];
  evidence: string[];
  actions: string[];
  sourceRefs: string[];
}

/** 建议来自已执行结果，样例永远保留来源；不把检测到的普通物体称为工业缺陷。 */
export function sampleSuggestionDraft(result: AiSampleResult): OperationalSuggestionDraft {
  if (result.kind === "query") throw new Error("查询样例使用原生查询计划，不生成处置事项");
  const sample = {
    maintenance: { title: "维护评估核对", type: "maintenance", actions: ["核对温度与振动特征对风险评分的贡献", "使用留出的正常与异常样本检查误报，再决定是否调整阈值", "确认设备对象与采样窗口后再建立影子评估绑定"] },
    energy: { title: "能耗偏差核对", type: "energy", actions: ["按同一统计时段核对产量和 kWh 单位", "区分空转时段与负载变化，定位单耗上升来源", "对照相同产量工况复跑基线，复核调整前后单耗"] },
    vision: { title: "视觉识别复核", type: "quality", actions: ["逐个核对检测框、类别与原图，标记误识别或漏检", "更换本地验证图片复跑，比较光照和遮挡条件", "验证工业目标类别后再配置业务识别规则"] },
  } as const;
  const selected = sample[result.kind];
  return {
    projectId: result.projectId,
    reference: `ai-draft:${result.kind}:${result.engine}:${result.inputFingerprint}`,
    source: "local-sample", title: `样例 · ${selected.title}`, type: selected.type,
    evidence: ["来源：本地样例，仅用于验证操作链路", ...result.metrics.map(metric => `${metric.label}：${metric.value}`)],
    actions: [...selected.actions], sourceRefs: [result.runId, result.inputFingerprint, result.engine],
  };
}

export function batterySuggestionDraft(input: {
  projectId: string; task: string; result: Record<string, unknown>; source: OperationalSuggestionDraft["source"];
  reference: string; sourceLabel: string;
}): OperationalSuggestionDraft {
  const output = input.result;
  const profile = record(output.dataProfile);
  const pack = record(profile?.packAssessment);
  const metrics = [
    ["当前 SOC", output.finalSoc, "%"], ["当前 SOH", output.currentSoh, "%"],
    ["估计容量", output.predictedCapacityAh, " Ah"], ["预计寿命", output.predictedCycleLife, " 圈"],
    ["Pack 平均 SOH", pack?.meanSohPct, "%"], ["最弱电芯 SOH", pack?.weakestSohPct, "%"],
    ["SOH 极差", pack?.sohSpreadPct, "%"],
  ].filter(([, value]) => typeof value === "number" && Number.isFinite(value))
    .map(([label, value, unit]) => `${label}：${Number(value).toFixed(2)}${unit}`);
  const actions = pack ? [
    `优先复测 ${String(pack.weakestCellId ?? "最弱电芯")}${pack.weakestModuleId ? `（${String(pack.weakestModuleId)}）` : ""} 的容量、内阻与采样线`,
    "检查静置压差、SOC 一致性和均衡记录，排除采样偏差后再判定更换",
    "按相同负载窗口复跑 Pack 聚合，确认 SOH 极差是否持续扩大",
  ] : ["核对电芯体系、容量、采样窗口与模型适用范围", "对照模型曲线与输入采样，记录异常点和缺失字段", "使用独立验证样本复跑；完成验证前保持人工复核"];
  return {
    projectId: input.projectId, reference: `ai-draft:battery:${input.reference}`, source: input.source,
    title: `${input.source === "local-sample" ? "样例 · " : ""}电池 ${input.task.toUpperCase()} 结果复核`, type: "maintenance",
    evidence: [`来源：${input.sourceLabel}`, ...metrics, ...(typeof output.summary === "string" ? [output.summary] : [])],
    actions,
    sourceRefs: [input.reference, input.task, input.source],
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function suggestionCaseInput(draft: OperationalSuggestionDraft, title: string, actionText: string): Partial<OperationalCaseRecord> {
  const actions = actionText.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  if (!title.trim()) throw new Error("请填写处置标题");
  if (!actions.length) throw new Error("至少保留一条可执行建议");
  if (title.length > 160 || actions.length > 20 || actions.some(action => action.length > 500)) throw new Error("标题最多 160 字，建议最多 20 条，每条最多 500 字");
  return {
    type: draft.type, title: title.trim(), severity: "info", status: "triage", owner: "待核对",
    externalRef: draft.reference, sourceRefs: draft.sourceRefs, objectRefs: [],
    hypothesis: draft.evidence, suggestedActions: actions,
  };
}
