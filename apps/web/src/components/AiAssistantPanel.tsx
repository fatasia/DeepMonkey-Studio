import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Activity, AlertTriangle, Bot, Box, Database, Focus, Layers3, LayoutDashboard, LoaderCircle, MessageSquare, RotateCcw, ScanSearch, Send, Sparkles, Square, Trash2, Workflow, X } from "lucide-react";
import type { SceneDashboardState } from "@bim-studio/contracts";
import { api, type AssistantMode } from "../api";
import type { BimAssistantPreparedContext } from "../bimAssistant";
import { translate as tr, type AppLocale } from "../i18n";
import { AiChangeConfirmation } from "./AiChangeConfirmation";
import { AskDataQuickQuery } from "./AskDataQuickQuery";
import { AiCapabilityCatalog } from "./AiCapabilityCatalog";
import type { AiWorkspaceTask } from "../ai/capabilityCatalog";
import { assistantSuggestions } from "../ai/assistantSuggestions";
import {
  assistantWorkspaceTarget,
  type AssistantContextSource,
  type AssistantReliabilitySummary,
} from "../ai/assistantReliability";
import { useAiProjectContext } from "../ai/useAiProjectContext";
import { runAssistantRequest } from "../ai/runAssistantRequest";
import { AiContextDisclosure } from "./AiContextDisclosure";
import { AiResponseEvidence } from "./AiResponseEvidence";
import { BimAssistantEvidence, type BimAssistantAction } from "./BimAssistantEvidence";
import { IndustrialAgentWorkspace } from "./IndustrialAgentWorkspace";
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
  const [experience, setExperience] = useState<"chat" | "agent">("chat");
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
  const [dragPosition, setDragPosition] = useState<{ x: number; y: number } | undefined>(undefined);
  const panelRef = useRef<HTMLElement>(null);
  const dragRef = useRef<{ pointerId: number; offsetX: number; offsetY: number } | undefined>(undefined);
  const previousUserSelectRef = useRef<string | undefined>(undefined);
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

  useEffect(() => {
    cancelRequest();
    setConversation([]);
    setAnswer("");
    setQuestion("");
    setLastPrompt("");
    setError(undefined);
    setDashboard(undefined);
    setConfirmDashboard(false);
    setBimEvidence(undefined);
    setApplyNotice(undefined);
    setDragPosition(undefined);
    return () => {
      requestAbort.current?.abort();
      requestAbort.current = undefined;
      if (previousUserSelectRef.current !== undefined) {
        document.body.style.userSelect = previousUserSelectRef.current;
        previousUserSelectRef.current = undefined;
      }
    };
  }, [projectId, workspaceTarget.scene?.id, workspaceTarget.script?.id]);

  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      if (confirmDashboard) setConfirmDashboard(false);
      else { cancelRequest(); onClose(); }
    };
    window.addEventListener("keydown", dismiss);
    return () => window.removeEventListener("keydown", dismiss);
  }, [confirmDashboard, onClose]);

  function cancelRequest() {
    requestAbort.current?.abort();
    requestAbort.current = undefined;
    setBusy(false);
  }

  function dragBounds() {
    const panel = panelRef.current;
    const parent = panel?.offsetParent as HTMLElement | null;
    const rect = parent?.getBoundingClientRect();
    return rect
      ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
      : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  }

  function handleDragStart(event: ReactPointerEvent<HTMLElement>) {
    if ((event.target as HTMLElement).closest("button, input, textarea, a")) return;
    const panel = panelRef.current;
    if (!panel) return;
    const bounds = dragBounds();
    const rect = panel.getBoundingClientRect();
    dragRef.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    };
    previousUserSelectRef.current = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragPosition({
      x: Math.max(8, rect.left - bounds.left),
      y: Math.max(8, rect.top - bounds.top),
    });
  }

  function handleDragMove(event: ReactPointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    const panel = panelRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !panel) return;
    const bounds = dragBounds();
    const rect = panel.getBoundingClientRect();
    const maxX = Math.max(8, bounds.width - rect.width - 8);
    const maxY = Math.max(8, bounds.height - rect.height - 8);
    setDragPosition({
      x: Math.min(maxX, Math.max(8, event.clientX - bounds.left - drag.offsetX)),
      y: Math.min(maxY, Math.max(8, event.clientY - bounds.top - drag.offsetY)),
    });
  }

  function handleDragEnd(event: ReactPointerEvent<HTMLElement>) {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    dragRef.current = undefined;
    if (previousUserSelectRef.current !== undefined) {
      document.body.style.userSelect = previousUserSelectRef.current;
      previousUserSelectRef.current = undefined;
    }
  }

  async function ask(retryPrompt?: string) {
    const prompt = (retryPrompt ?? question).trim();
    if (!prompt || requestAbort.current) return;
    const controller = new AbortController();
    requestAbort.current = controller;
    const isCurrent = () => requestAbort.current === controller && !controller.signal.aborted;
    setLastPrompt(prompt);
    if (!retryPrompt) setQuestion("");
    setBusy(true);
    setError(undefined);
    setApplyNotice(undefined);
    setApplyError(undefined);
    setDashboard(undefined);
    setConfirmDashboard(false);
    setBimEvidence(undefined);
    setAnswer("");
    try {
      let streamed = "";
      const result = await runAssistantRequest({
        client: api, mode, prompt, locale, context, platformContext, sources: effectiveSources,
        ...(projectId ? { projectId } : {}),
        ...(onPrepareBimContext ? { prepareBim: onPrepareBimContext } : {}),
        recentConversation: conversation.slice(-6).map(({ mode, question, answer }) => ({ mode, question, answer })),
        signal: controller.signal,
        onPrepared: (prepared) => { if (isCurrent()) setBimEvidence(prepared); },
        onDelta: (delta) => { if (isCurrent()) { streamed += delta; setAnswer(streamed); } },
      });
      if (!isCurrent()) return;
      setAnswer(result.text);
      setDashboard(result.dashboard);
      setBimEvidence(result.prepared);
      setConversation((current) => [
        ...current,
        { id: `${Date.now()}`, mode, question: prompt, answer: result.text, reliability: result.reliability,
          ...(result.model ? { model: result.model } : {}) },
      ].slice(-12));
    } catch (reason) {
      if (isCurrent()) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (requestAbort.current === controller) {
        requestAbort.current = undefined;
        setBusy(false);
      }
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
    <aside
      ref={panelRef}
      className={`ai-assistant-panel ai-assistant-${surface} ${experience === "agent" ? "agent-active" : ""}`}
      style={dragPosition ? { left: `${dragPosition.x}px`, top: `${dragPosition.y}px`, right: "auto", bottom: "auto" } : undefined}
    >
      <header
        data-drag-handle="true"
        title={t("拖动标题栏移动助手面板", "Drag the title bar to move the assistant panel")}
        onPointerDown={handleDragStart}
        onPointerMove={handleDragMove}
        onPointerUp={handleDragEnd}
        onPointerCancel={handleDragEnd}
      >
        <div>
          <Bot size={18} />
          <span>
            <strong>{t("平台 AI 助手", "Platform AI Assistant")}</strong>
          </span>
        </div>
        <div className="ai-assistant-header-actions">
          {conversation.length > 0 && (
            <button
              title={t("清空对话", "Clear conversation")}
              aria-label={t("清空对话", "Clear conversation")}
              disabled={busy}
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
          <button aria-label={t("关闭 AI 助手", "Close AI assistant")} title={t("关闭 AI 助手", "Close AI assistant")} onClick={() => { cancelRequest(); onClose(); }}>
            <X size={15} />
          </button>
        </div>
      </header>
      <nav className="ai-assistant-tabs">
        <div className="ai-assistant-experience" role="tablist" aria-label={t("AI 使用方式", "AI experience")}>
          <button role="tab" disabled={busy} aria-selected={experience === "chat"} title={t("问答与生成", "Ask & create")} aria-label={t("问答与生成", "Ask & create")} className={experience === "chat" ? "active" : ""} onClick={() => setExperience("chat")}>
            <MessageSquare size={14} />
          </button>
          <button role="tab" disabled={busy} aria-selected={experience === "agent"} title={t("执行任务", "Run task")} aria-label={t("执行任务", "Run task")} className={experience === "agent" ? "active" : ""} onClick={() => setExperience("agent")}>
            <Workflow size={14} />
          </button>
        </div>
        {experience === "chat" && tabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            disabled={busy}
            className={mode === id ? "active" : ""}
            title={label}
            aria-label={label}
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
          </button>
        ))}
      </nav>
      <div className="ai-assistant-body">
        {experience === "agent" ? (
          <IndustrialAgentWorkspace locale={locale} {...(projectId ? { projectId } : {})} context={context} />
        ) : <>
          <AiContextDisclosure
          locale={locale}
          mode={mode}
          context={context}
          sources={effectiveSources}
          loading={!platformLoaded && !projectMissing}
        />
        {mode === "sql" && projectId && <AskDataQuickQuery projectId={projectId} datasets={datasets} locale={locale} />}
        {conversation.length === 0 && !answer && !busy && !error && mode !== "sql" && (
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
              <button type="button" disabled={!projectId || busy} onClick={() => void ask(suggestions[0])}>
                <Sparkles size={13} />{t("一键运行样例", "Run sample")}
              </button>
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
        {(busy || error) && lastPrompt && <section className="ai-conversation-turn" aria-label={t("当前请求", "Current request")}>
          <div className="ai-user-message">{lastPrompt}</div>
          {busy && !answer && <article role="status"><LoaderCircle className="spin" size={14} /> {t("正在处理，请稍候…", "Working on your request…")}</article>}
        </section>}
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
        </>}
      </div>
      {experience === "chat" && <footer>
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
        {busy ? <button aria-label={t("停止生成", "Stop generating")} title={t("停止生成", "Stop generating")} onClick={() => {
          cancelRequest();
          setApplyNotice(t("请求已停止，未应用任何更改。", "Request stopped; no changes were applied."));
        }}><Square size={15} /></button> : <button aria-label={t("发送", "Send")} title={t("发送", "Send")} disabled={!question.trim()} onClick={() => void ask()}><Send size={15} /></button>}
      </footer>}
    </aside>
  );
}
