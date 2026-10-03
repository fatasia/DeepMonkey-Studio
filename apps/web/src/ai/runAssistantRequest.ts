import type { AskDataQueryDraftResult, AskDataQueryReadResult, SceneDashboardState } from "@bim-studio/contracts";
import type { api, AssistantMode } from "../api";
import type { AssistantSessionOptions } from "../apiClients/aiApi";
import type { BimAssistantPreparedContext } from "../bimAssistant";
import { translate as tr, type AppLocale } from "../i18n";
import { assistantReliabilityFromResponse, queryCapabilityReliability, type AssistantContextSource, type AssistantReliabilitySummary } from "./assistantReliability";

import { parseDashboardStreamPreview } from "./dashboardStreamPreview";

/** chat 整体 deadline 缺省（K9）：覆盖 sql 规划/读取、BIM 准备与流式全程。集中导出供测试注入。 */
export const CHAT_REQUEST_DEADLINE_MS = 180_000;

export interface AssistantRequestResult {
  text: string;
  model?: string;
  execution?: import("@bim-studio/contracts").AiAssistantResponse["execution"];
  dashboard?: SceneDashboardState;
  dashboardPageDraft?: unknown;
  prepared?: BimAssistantPreparedContext;
  /**
   * T2（审计 §二 2.1 / P1-9 chat 最小版）：sql 受控问数歧义时的结构化澄清——
   * question + 服务端数据集目录候选；缺省（无歧义/无候选）不渲染澄清卡。
   */
  clarification?: AssistantClarification;
  reliability: AssistantReliabilitySummary;
}

export interface AssistantClarification {
  question: string;
  options: Array<{ id: string; label: string }>;
}

/** Dashboard providers stream a JSON envelope; expose only its human-readable text through the shared message flow. */
export function dashboardAssistantStreamText(content: string): string {
  const match = /"text"\s*:\s*"((?:\\.|[^"\\])*)/.exec(content);
  if (!match) return "";
  try { return JSON.parse(`"${match[1]}"`) as string; } catch { return ""; }
}

/** 一次请求从本地 BIM 准备、问数规划到流式读取共用取消信号；每个 await 后检查所有权。 */
export async function runAssistantRequest(input: {
  client: Pick<typeof api, "invokeCapability" | "streamAssistant" | "listDatasets">;
  mode: AssistantMode;
  prompt: string;
  projectId?: string;
  sessionOptions?: AssistantSessionOptions;
  locale: AppLocale;
  context: unknown;
  platformContext: unknown;
  sources: AssistantContextSource[];
  recentConversation: Array<{ mode: AssistantMode; question: string; answer: string; scope?: string }>;
  signal: AbortSignal;
  onDelta: (delta: string) => void;
  onDashboardStream?: (preview: { labels: string[]; types: string[] }) => void;
  onExecution?: (execution: AssistantRequestResult["execution"]) => void;
  onPrepared?: (prepared: BimAssistantPreparedContext) => void;
  prepareBim?: (question: string) => Promise<BimAssistantPreparedContext>;
  /** K9 整体 deadline；缺省 180s。手动取消（外部 signal）语义不受影响。 */
  overallDeadlineMs?: number;
}): Promise<AssistantRequestResult> {
  const { signal, locale } = input;
  const t = (zh: string, en: string) => tr(locale, zh, en);
  // K9：整体 deadline 级联——内部 controller 承接外部取消与超时两个来源；
  // 超时触发时 abort 下游（fetch/流随之解体）并由 race 抛本地化错误，迟到 rejection 吞掉。
  const overallDeadlineMs = input.overallDeadlineMs ?? CHAT_REQUEST_DEADLINE_MS;
  const deadlineController = new AbortController();
  // 入口前已取消的外部 signal 不会触发 abort 事件,必须立即级联(K9 首跑真缺陷)。
  if (signal.aborted) deadlineController.abort(signal.reason);
  const onOuterAbort = () => deadlineController.abort();
  signal.addEventListener("abort", onOuterAbort, { once: true });
  const timeoutMessage = t("AI 请求超时（超过 3 分钟）。请重试，或拆小问题后重试。", "AI request timed out after 3 minutes. Retry, or try a smaller question.");
  const deadlineRejected = overallDeadlineMs <= 0 ? new Promise<never>(() => {}) : new Promise<never>((_, reject) => {
    deadlineController.signal.addEventListener("abort", () => {
      if (deadlineController.signal.reason instanceof Error && deadlineController.signal.reason.message === timeoutMessage) reject(deadlineController.signal.reason);
    }, { once: true });
    setTimeout(() => { deadlineController.abort(new Error(timeoutMessage)); }, overallDeadlineMs);
  });
  const workload = runAssistantRequestInner({ ...input, signal: deadlineController.signal });
  // deadline 赢得竞速时,内层随 abort 解体后的迟到 rejection 必须吞掉(K9 首跑 unhandled 真缺陷)。
  workload.catch(() => undefined);
  return (async () => {
    try {
      return await Promise.race([workload, deadlineRejected]);
    } finally {
      signal.removeEventListener("abort", onOuterAbort);
    }
  })();
}

/** 一次请求从本地 BIM 准备、问数规划到流式读取共用取消信号；每个 await 后检查所有权。 */
async function runAssistantRequestInner(input: {
  client: Pick<typeof api, "invokeCapability" | "streamAssistant" | "listDatasets">;
  mode: AssistantMode;
  prompt: string;
  projectId?: string;
  sessionOptions?: AssistantSessionOptions;
  locale: AppLocale;
  context: unknown;
  platformContext: unknown;
  sources: AssistantContextSource[];
  recentConversation: Array<{ mode: AssistantMode; question: string; answer: string; scope?: string }>;
  signal: AbortSignal;
  onDelta: (delta: string) => void;
  onDashboardStream?: (preview: { labels: string[]; types: string[] }) => void;
  onExecution?: (execution: AssistantRequestResult["execution"]) => void;
  onPrepared?: (prepared: BimAssistantPreparedContext) => void;
  prepareBim?: (question: string) => Promise<BimAssistantPreparedContext>;
}): Promise<AssistantRequestResult> {
  const { client, signal, mode, prompt, projectId, locale } = input;
  const t = (zh: string, en: string) => tr(locale, zh, en);
  signal.throwIfAborted();
  if (mode === "sql") {
    if (!projectId) throw new Error(t("请先选择项目", "Select a project first"));
    const drafted = await client.invokeCapability<AskDataQueryDraftResult>(projectId, "data.query.draft", { prompt }, "web-user", signal);
    signal.throwIfAborted();
    const plan = drafted.output?.planning.plan;
    if (!plan) {
      const issue = drafted.output?.planning.issues[0]?.message;
      // T2：needs-input（如数据集不匹配）且确有候选时，返回结构化澄清（候选不虚构），
      // 而不是把歧义当错误抛出。T1：候选优先消费服务端随响应透传的目录段；
      // 服务端未透传（旧服务端/其他歧义）才回退本地目录自拼，目录不可用则保持原错误路径。
      if (drafted.output?.planning.status === "needs-input") {
        let options = (drafted.output.planning.candidates ?? []).slice(0, 8)
          .map((candidate) => ({ id: candidate.id, label: candidate.name }));
        if (!options.length) {
          let datasets: import("@bim-studio/contracts").DataDatasetRecord[] = [];
          try { datasets = await client.listDatasets(projectId); } catch { /* 目录读取失败时走下方原错误抛出。 */ }
          signal.throwIfAborted();
          options = datasets.filter(dataset => dataset.projectId === projectId).slice(0, 8)
            .map(dataset => ({ id: dataset.id, label: dataset.name }));
        }
        if (options.length) {
          return {
            text: issue ?? t("需要先确认要查询的数据集", "The dataset to query needs to be confirmed first"),
            ...(drafted.output?.model ? { model: drafted.output.model } : {}),
            clarification: { question: issue ?? t("请选择要查询的数据集", "Choose the dataset to query"), options },
            reliability: queryCapabilityReliability({
              traceId: drafted.traceId, evidenceCount: 0, warnings: [...drafted.warnings],
              sourceLabel: t("受控问数澄清", "Controlled query clarification"),
            }),
          };
        }
      }
      throw new Error(issue ?? drafted.warnings[0] ?? drafted.error?.message ?? t("无法生成受控查询计划", "Unable to create a controlled query plan"));
    }
    const read = await client.invokeCapability<AskDataQueryReadResult>(projectId, "data.query.read", { plan }, "web-user", signal);
    signal.throwIfAborted();
    if (!read.output) throw new Error(read.error?.message ?? t("查询没有返回数据", "The query returned no data"));
    return {
      text: formatAskDataResult(read.output, locale),
      ...(drafted.output?.model ? { model: drafted.output.model } : {}),
      reliability: queryCapabilityReliability({
        traceId: read.traceId, evidenceCount: read.evidence.length,
        warnings: [...drafted.warnings, ...read.warnings],
        evidenceFingerprint: read.output.evidenceFingerprint, sourceLabel: read.output.datasetName,
      }),
    };
  }
  const prepared = mode === "bim" && input.prepareBim ? await input.prepareBim(prompt) : undefined;
  signal.throwIfAborted();
  if (prepared) input.onPrepared?.(prepared);
  let dashboardRaw = "";
  let dashboardVisible = "";
  const result = await client.streamAssistant(mode, prompt, {
    workspace: input.context, platform: input.platformContext, contextTrust: "client-snapshot",
    ...(prepared ? { bimEvidence: prepared } : {}), recentConversation: input.recentConversation,
  }, (delta) => {
    if (signal.aborted) return;
    if (mode !== "dashboard") { input.onDelta(delta); return; }
    dashboardRaw += delta;
    const next = dashboardAssistantStreamText(dashboardRaw);
    if (next.startsWith(dashboardVisible) && next.length > dashboardVisible.length) input.onDelta(next.slice(dashboardVisible.length));
    dashboardVisible = next;
    // T7:流式期布局预览——只解析已完整闭合的 widget,坏数据 fail-quiet 不冒充草稿。
    if (input.onDashboardStream && dashboardRaw.length <= 262_144) {
      const preview = parseDashboardStreamPreview(dashboardRaw);
      input.onDashboardStream({ labels: preview.labels, types: preview.types });
    }
  }, { ...input.sessionOptions, ...(projectId ? { projectId } : {}), signal,
    onExecution: execution => { if (!signal.aborted) input.onExecution?.(execution); } });
  signal.throwIfAborted();
  const sources: AssistantContextSource[] = prepared
    ? [...input.sources, { id: "bim-evidence-snapshot", label: t("BIM 构件匹配快照", "BIM component match snapshot"),
      state: prepared.confidence === "insufficient" ? "partial" : "ready", kind: "snapshot", count: prepared.matchCount }]
    : input.sources;
  return {
    text: result.text, model: result.model,
    ...(result.execution ? { execution: result.execution } : {}),
    ...(result.dashboard ? { dashboard: result.dashboard } : {}), ...(prepared ? { prepared } : {}),
    ...(result.dashboardPageDraft ? { dashboardPageDraft: result.dashboardPageDraft } : {}),
    reliability: assistantReliabilityFromResponse(result, mode, sources, prepared),
  };
}

function formatAskDataResult(result: AskDataQueryReadResult, locale: AppLocale): string {
  const columns = result.columns.map((column) => `${column.label}${column.unit ? ` (${column.unit})` : ""}`);
  const rows = result.rows.slice(0, 12).map((row) => result.columns.map((column) => `${column.label}: ${formatCell(row[column.key])}`).join(" · "));
  const summary = locale === "zh-CN"
    ? `数据集：${result.datasetName}\n字段：${columns.join("、")}\n匹配 ${result.matchedRows} 行，返回 ${result.returnedRows} 行${result.truncated ? "（已限量）" : ""}`
    : `Dataset: ${result.datasetName}\nFields: ${columns.join(", ")}\n${result.matchedRows} matched, ${result.returnedRows} returned${result.truncated ? " (limited)" : ""}`;
  return `${summary}\n\n${rows.map((row) => `- ${row}`).join("\n")}\n\nEvidence: ${result.evidenceFingerprint}`;
}

function formatCell(value: unknown): string {
  return typeof value === "number" ? Number(value.toFixed(4)).toLocaleString() : String(value ?? "—");
}
