import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, AlertTriangle, Bot, Box, Database, Focus, Layers3, LayoutDashboard, LoaderCircle, RotateCcw, ScanSearch, Send, Sparkles, Trash2, X } from "lucide-react";
import type { AskDataQueryDraftResult, AskDataQueryReadResult, SceneDashboardState } from "@bim-studio/contracts";
import { api, type AssistantMode } from "../api";
import type { BimAssistantPreparedContext } from "../bimAssistant";
import { translate as tr, type AppLocale } from "../i18n";
import { AiChangeConfirmation } from "./AiChangeConfirmation";
import { AskDataQuickQuery } from "./AskDataQuickQuery";
import { AiCapabilityCatalog } from "./AiCapabilityCatalog";
import type { AiWorkspaceTask } from "../ai/capabilityCatalog";
import { assistantSuggestions } from "../ai/assistantSuggestions";
import {
  assistantReliabilityFromResponse,
  assistantWorkspaceTarget,
  queryCapabilityReliability,
  type AssistantContextSource,
  type AssistantReliabilitySummary,
} from "../ai/assistantReliability";
import { useAiProjectContext } from "../ai/useAiProjectContext";
import { AiContextDisclosure } from "./AiContextDisclosure";
import { AiResponseEvidence } from "./AiResponseEvidence";
import { BimAssistantEvidence, type BimAssistantAction } from "./BimAssistantEvidence";
import "./AiAssistantReliability.css";

type ConversationItem = {
  id: string;
  mode: AssistantMode;
  question: string;
  answer: string;
  model?: string;
  reliability: AssistantReliabilitySummary;
};

interface AiAssistantPanelProps {
  locale: AppLocale;
  projectId: string | undefined;
  context: unknown;
  surface?: "studio" | "platform";
  onPrepareBimContext?: (question: string) => Promise<BimAssistantPreparedContext>;
  onBimAction?: (action: BimAssistantAction, context: BimAssistantPreparedContext, componentId?: string) => void;
  onApplyDashboard?: (dashboard: SceneDashboardState) => void;
  onOpenWorkspaceTask?: (task: Extract<AiWorkspaceTask, { workspace: "operations" }>) => void;
  onClose: () => void;
}

export function AiAssistantPanel({
  locale,
  projectId,
  context,
  surface = "platform",
  onPrepareBimContext,
  onBimAction,
  onApplyDashboard,
  onOpenWorkspaceTask,
  onClose,
}: AiAssistantPanelProps) {
  const [mode, setMode] = useState<AssistantMode>(() => surface === "studio" ? "scene" : "platform");
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [conversation, setConversation] = useState<ConversationItem[]>([]);
  const [dashboard, setDashboard] = useState<SceneDashboardState>();
  const [confirmDashboard, setConfirmDashboard] = useState(false);
  const [bimEvidence, setBimEvidence] = useState<BimAssistantPreparedContext>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [lastPrompt, setLastPrompt] = useState("");
  const [applyBusy, setApplyBusy] = useState(false);
  const [applyError, setApplyError] = useState<string>();
  const [applyNotice, setApplyNotice] = useState<string>();
  const requestAbort = useRef<AbortController | undefined>(undefined);
  const { platformContext, contextSources, datasets, platformLoaded, projectMissing } = useAiProjectContext(projectId, locale);
  const t = (zh: string, en: string) => tr(locale, zh, en);
  const workspaceTarget = useMemo(() => assistantWorkspaceTarget(context), [context]);
  const effectiveSources = useMemo<AssistantContextSource[]>(() => {
    const workspaceSources: AssistantContextSource[] = [
      workspaceTarget.scene
        ? {
            id: "workspace-scene",
            label: tr(locale, "当前三维场景快照", "Current 3D scene snapshot"),
            state: "ready",
            kind: "snapshot",
            ...(workspaceTarget.scene.modelCount === undefined ? {} : { count: workspaceTarget.scene.modelCount }),
          }
        : undefined,
      workspaceTarget.selected
        ? {
            id: "workspace-selection",
            label: tr(locale, "当前选中对象", "Current selected object"),
            state: "ready",
            kind: "snapshot",
            count: 1,
          }
        : undefined,
      workspaceTarget.dashboardWidgetCount !== undefined
        ? {
            id: "workspace-dashboard",
            label: tr(locale, "当前二维看板草稿", "Current 2D dashboard draft"),
            state: "ready",
            kind: "snapshot",
            count: workspaceTarget.dashboardWidgetCount,
        }
        : undefined,
      workspaceTarget.script
        ? {
            id: "workspace-script",
            label: tr(locale, "当前脚本快照", "Current script snapshot"),
            state: "ready",
            kind: "snapshot",
            count: 1,
          }
        : undefined,
      workspaceTarget.simulation
        ? {
            id: "workspace-simulation",
            label: tr(locale, "当前仿真任务快照", "Current simulation snapshot"),
            state: "ready",
            kind: "snapshot",
            count: 1,
          }
        : undefined,
    ].filter((source): source is AssistantContextSource => Boolean(source));
    return [...workspaceSources, ...contextSources];
  }, [contextSources, locale, workspaceTarget]);

  useEffect(() => {
    if (mode === "component" && !workspaceTarget.selected) setMode(surface === "studio" ? "scene" : "platform");
  }, [mode, surface, workspaceTarget.selected]);

  useEffect(() => () => requestAbort.current?.abort(), []);

  async function ask(retryPrompt?: string) {
    const prompt = (retryPrompt ?? question).trim();
    if (!prompt) return;
    setLastPrompt(prompt);
    setBusy(true);
    setError(undefined);
    setApplyNotice(undefined);
    setApplyError(undefined);
    setDashboard(undefined);
    setConfirmDashboard(false);
    setBimEvidence(undefined);
    setAnswer("");
    try {
      if (mode === "sql") {
        if (!projectId) throw new Error(t("请先选择项目", "Select a project first"));
        const drafted = await api.invokeCapability<AskDataQueryDraftResult>(projectId, "data.query.draft", { prompt });
        const plan = drafted.output?.planning.plan;
        if (!plan)
          throw new Error(
            drafted.output?.planning.issues[0]?.message ?? drafted.warnings[0] ?? drafted.error?.message ?? t("无法生成受控查询计划", "Unable to create a controlled query plan"),
          );
        const read = await api.invokeCapability<AskDataQueryReadResult>(projectId, "data.query.read", { plan });
        if (!read.output) throw new Error(read.error?.message ?? t("查询没有返回数据", "The query returned no data"));
        const resultText = formatAskDataResult(read.output, locale);
        const reliability = queryCapabilityReliability({
          traceId: read.traceId,
          evidenceCount: read.evidence.length,
          warnings: [...drafted.warnings, ...read.warnings],
          evidenceFingerprint: read.output.evidenceFingerprint,
          sourceLabel: read.output.datasetName,
        });
        setAnswer(resultText);
        setConversation((current) =>
          [
            ...current,
            {
              id: `${Date.now()}`,
              mode,
              question: prompt,
              answer: resultText,
              reliability,
              ...(drafted.output?.model ? { model: drafted.output.model } : {}),
            },
          ].slice(-12),
        );
        setQuestion("");
        return;
      }
      const prepared = mode === "bim" && onPrepareBimContext ? await onPrepareBimContext(prompt) : undefined;
      if (prepared) setBimEvidence(prepared);
      const requestContext = {
        workspace: context,
        platform: platformContext,
        contextTrust: "client-snapshot",
        ...(prepared ? { bimEvidence: prepared } : {}),
        recentConversation: conversation
          .slice(-6)
          .map(({ mode: itemMode, question: itemQuestion, answer: itemAnswer }) => ({ mode: itemMode, question: itemQuestion, answer: itemAnswer })),
      };
      let streamed = "";
      requestAbort.current?.abort();
      const controller = new AbortController();
      requestAbort.current = controller;
      const result = await api.streamAssistant(mode, prompt, requestContext, (delta) => {
        streamed += delta;
        setAnswer(streamed);
      }, { ...(projectId ? { projectId } : {}), signal: controller.signal });
      setAnswer(result.text);
      setDashboard(result.dashboard);
      const responseSources = prepared
        ? [
            ...effectiveSources,
            {
              id: "bim-evidence-snapshot",
              label: t("BIM 构件匹配快照", "BIM component match snapshot"),
              state: prepared.confidence === "insufficient" ? "partial" as const : "ready" as const,
              kind: "snapshot" as const,
              count: prepared.matchCount,
            },
          ]
        : effectiveSources;
      const reliability = assistantReliabilityFromResponse(result, mode, responseSources, prepared);
      setConversation((current) => [
        ...current,
        { id: `${Date.now()}`, mode, question: prompt, answer: result.text, model: result.model, reliability },
      ].slice(-12));
      setQuestion("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      requestAbort.current = undefined;
      setBusy(false);
    }
  }

  async function applyDashboardDraft() {
    if (!dashboard || !onApplyDashboard) return;
    setApplyBusy(true);
    setApplyError(undefined);
    try {
      await Promise.resolve(onApplyDashboard(dashboard));
      setDashboard(undefined);
      setConfirmDashboard(false);
      setApplyNotice(t("已写入当前看板草稿，尚未保存或发布。", "Applied to the current dashboard draft; it has not been saved or published."));
    } catch (reason) {
      setApplyError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setApplyBusy(false);
    }
  }

  const tabs = useMemo(() => {
    if (surface === "studio") {
      return [
        { id: "scene" as const, label: t("场景", "Scene"), icon: Box },
        ...(workspaceTarget.selected ? [{ id: "component" as const, label: t("对象", "Object"), icon: Focus }] : []),
        { id: "bim" as const, label: "BIM", icon: Layers3 },
        { id: "operations" as const, label: t("仿真运营", "Simulation"), icon: Activity },
        ...(onApplyDashboard ? [{ id: "dashboard" as const, label: t("看板", "Dashboard"), icon: LayoutDashboard }] : []),
        { id: "sql" as const, label: t("问数据", "Ask Data"), icon: Database },
      ];
    }
    return [
      { id: "platform" as const, label: t("全平台", "Platform"), icon: Sparkles },
      { id: "operations" as const, label: t("运营", "Operations"), icon: Activity },
      { id: "vision" as const, label: t("视觉", "Vision"), icon: ScanSearch },
      { id: "bim" as const, label: "BIM", icon: Box },
      { id: "sql" as const, label: t("问数据", "Ask Data"), icon: Database },
    ];
  }, [locale, onApplyDashboard, surface, workspaceTarget.selected]);
  const suggestions = assistantSuggestions(mode, locale);
  const latestReliability = conversation.at(-1)?.reliability;

  return (
    <aside className={`ai-assistant-panel ai-assistant-${surface}`}>
      <header>
        <div>
          <Bot size={18} />
          <span>
            <strong>{t("平台 AI 助手", "Platform AI Assistant")}</strong>
            <small>
              {platformLoaded
                ? t("项目上下文快照已连接", "Project context snapshot connected")
                : projectMissing
                  ? t("请先选择或创建项目", "Select or create a project first")
                  : t("正在读取平台上下文", "Loading platform context")}
            </small>
          </span>
        </div>
        <div className="ai-assistant-header-actions">
          {conversation.length > 0 && (
            <button
              title={t("清空对话", "Clear conversation")}
              onClick={() => {
                setConversation([]);
                setAnswer("");
                setError(undefined);
                setApplyNotice(undefined);
              }}
            >
              <Trash2 size={14} />
            </button>
          )}
          <button aria-label={t("关闭 AI 助手", "Close AI assistant")} onClick={() => { requestAbort.current?.abort(); onClose(); }}>
            <X size={15} />
          </button>
        </div>
      </header>
      <nav className="ai-assistant-tabs">
        {tabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={mode === id ? "active" : ""}
            aria-pressed={mode === id}
            onClick={() => {
              setMode(id);
              setAnswer("");
              setDashboard(undefined);
              setConfirmDashboard(false);
              setError(undefined);
              setApplyError(undefined);
            }}
          >
            <Icon size={12} />
            {label}
          </button>
        ))}
      </nav>
      <div className="ai-assistant-context-bar">
        <span className={platformLoaded ? "ready" : ""}>{platformLoaded ? "PROJECT SNAPSHOT" : projectMissing ? "NO PROJECT" : "LOADING"}</span>
        <small>
          {projectMissing
            ? t("选择项目后才能读取证据并执行任务", "Select a project to read evidence and run tasks")
            : t("快照只作为模型输入；Capability 执行结果才是事实证据", "The snapshot is model input; only Capability results are execution evidence")}
        </small>
      </div>
      <div className="ai-assistant-body">
        <AiContextDisclosure
          locale={locale}
          mode={mode}
          context={context}
          sources={effectiveSources}
          loading={!platformLoaded && !projectMissing}
        />
        {mode === "sql" && projectId && <AskDataQuickQuery projectId={projectId} datasets={datasets} locale={locale} />}
        {conversation.length === 0 && !answer && mode !== "sql" && (
          <div className="ai-assistant-empty">
            <Sparkles size={23} />
            <strong>{t("问当前平台，不问空泛知识", "Ask your platform, not generic knowledge")}</strong>
            <span>
              {t("项目证据与插件能力会按当前部署动态发现。", "Project evidence and plugin capabilities are discovered from this deployment.")}
            </span>
            {(mode === "platform" || mode === "scene") && (
              <AiCapabilityCatalog
                locale={locale}
                canOpenTask={(task) => Boolean(projectId) && (task.workspace === "ask-data" || Boolean(onOpenWorkspaceTask))}
                onOpenTask={(task) => {
                  if (task.workspace === "ask-data") {
                    setMode("sql");
                    return;
                  }
                  onOpenWorkspaceTask?.(task);
                }}
              />
            )}
            <div className="ai-platform-suggestions">
              {suggestions.map((item) => (
                <button key={item} onClick={() => setQuestion(item)}>
                  {item}
                </button>
              ))}
            </div>
          </div>
        )}
        {conversation.map((item) => (
          <section className="ai-conversation-turn" key={item.id}>
            <div className="ai-user-message">{item.question}</div>
            <article>
              <small>{item.model ?? t("模型回答", "Model response")}</small>
              <p>{item.answer}</p>
              <AiResponseEvidence locale={locale} reliability={item.reliability} />
            </article>
          </section>
        ))}
        {answer && (conversation.at(-1)?.answer !== answer || busy) && (
          <article className="ai-streaming-answer">
            <small>{busy ? t("正在基于项目证据分析", "Analyzing project evidence") : t("模型回答", "Model response")}</small>
            <p>{answer}</p>
          </article>
        )}
        {dashboard && onApplyDashboard && !confirmDashboard && (
          <button className="primary ai-apply-dashboard" onClick={() => setConfirmDashboard(true)}>
            <LayoutDashboard size={13} />
            {t("查看并应用", "Review & apply")}
          </button>
        )}
        {dashboard && onApplyDashboard && confirmDashboard && (
          <AiChangeConfirmation
            locale={locale}
            widgetCount={dashboard.widgets.length}
            widgetLabels={dashboard.widgets.map((widget) => widget.title || widget.type)}
            evidenceLabels={latestReliability?.sourceLabels ?? []}
            busy={applyBusy}
            {...(applyError ? { error: applyError } : {})}
            onCancel={() => {
              setConfirmDashboard(false);
              setApplyError(undefined);
            }}
            onConfirm={() => void applyDashboardDraft()}
          />
        )}
        {applyNotice && <div className="ai-assistant-apply-notice" role="status">{applyNotice}</div>}
        {bimEvidence && (
          <BimAssistantEvidence
            locale={locale}
            evidence={bimEvidence}
            {...(onBimAction ? { onAction: onBimAction } : {})}
          />
        )}
        {error && (
          <section className="ai-assistant-error-state" role="alert">
            <strong><AlertTriangle size={13} /> {t("本次请求未完成", "Request did not complete")}</strong>
            <span>{error}</span>
            <small>{t("没有自动写入任何变更；原问题已保留。", "No changes were applied automatically; the original prompt is preserved.")}</small>
            <button type="button" disabled={busy || !lastPrompt} onClick={() => void ask(lastPrompt)}>
              <RotateCcw size={12} /> {t("重试原问题", "Retry original prompt")}
            </button>
          </section>
        )}
      </div>
      <footer>
        <textarea
          aria-label={t("向 AI 助手提问", "Ask the AI assistant")}
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void ask();
            }
          }}
          placeholder={t("问模型、事件、风险、数据或下一步动作……", "Ask about models, events, risks, data or next actions…")}
        />
        <button aria-label={t("发送", "Send")} disabled={busy || !question.trim()} onClick={() => void ask()}>
          {busy ? <LoaderCircle className="spin" size={15} /> : <Send size={15} />}
        </button>
      </footer>
    </aside>
  );
}

function formatAskDataResult(result: AskDataQueryReadResult, locale: AppLocale): string {
  const columns = result.columns.map((column) => `${column.label}${column.unit ? ` (${column.unit})` : ""}`);
  const rows = result.rows.slice(0, 12).map((row) => result.columns.map((column) => `${column.label}: ${formatCell(row[column.key])}`).join(" · "));
  const summary =
    locale === "zh-CN"
      ? `数据集：${result.datasetName}\n字段：${columns.join("、")}\n匹配 ${result.matchedRows} 行，返回 ${result.returnedRows} 行${result.truncated ? "（已限量）" : ""}`
      : `Dataset: ${result.datasetName}\nFields: ${columns.join(", ")}\n${result.matchedRows} matched, ${result.returnedRows} returned${result.truncated ? " (limited)" : ""}`;
  return `${summary}\n\n${rows.map((row) => `- ${row}`).join("\n")}\n\nEvidence: ${result.evidenceFingerprint}`;
}

function formatCell(value: unknown): string {
  if (typeof value === "number") return Number(value.toFixed(4)).toLocaleString();
  return String(value ?? "—");
}
