import { AiAssistantMessages } from "./AiAssistantMessages";
import { AiAssistantComposer } from "./AiAssistantComposer";
import { AssistantModelControls, type AssistantSessionOptions } from "./AssistantModelControls";
import { useAssistantScroll } from "../ai/useAssistantScroll";
import { assistantContextSources } from "../ai/assistantContextSources";
import { useFloatingPanelDrag } from "../hooks/useFloatingPanelDrag";
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Bot, LayoutDashboard, MessageSquare, RotateCcw, Sparkles, Workflow, X } from "lucide-react";
import type { SceneDashboardState } from "@bim-studio/contracts";
import { type AssistantMode } from "../api";
import type { BimAssistantPreparedContext } from "../bimAssistant";
import { translate as tr, type AppLocale } from "../i18n";
import { AiChangeConfirmation } from "./AiChangeConfirmation";
import { AskDataQuickQuery } from "./AskDataQuickQuery";
import { AiCapabilityCatalog } from "./AiCapabilityCatalog";
import type { AiWorkspaceTask } from "../ai/capabilityCatalog";
import { assistantModeTabs } from "../ai/assistantModeTabs";
import { assistantSuggestions } from "../ai/assistantSuggestions";
import {
  assistantWorkspaceTarget,
} from "../ai/assistantReliability";
import { useAiProjectContext } from "../ai/useAiProjectContext";
import { useAssistantSessions } from "../ai/useAssistantSessions";
import { useAssistantChatRun } from "../ai/useAssistantChatRun";
import { AiAssistantSessionControls } from "./AiAssistantSessionControls";
import { AiContextDisclosure } from "./AiContextDisclosure";
import { BimAssistantEvidence, type BimAssistantAction } from "./BimAssistantEvidence";
import { IndustrialAgentWorkspace } from "./IndustrialAgentWorkspace";
import "./AiAssistantReliability.css";

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
  const [sessionOptions, setSessionOptions] = useState<AssistantSessionOptions>({});
  const [question, setQuestion] = useState("");
  const [confirmDashboard, setConfirmDashboard] = useState(false);
  const [applyBusy, setApplyBusy] = useState(false);
  const [applyError, setApplyError] = useState<string>();
  const [applyNotice, setApplyNotice] = useState<string>();
  const panelDrag = useFloatingPanelDrag<HTMLElement>();
  const { platformContext, contextSources, datasets, platformLoaded, projectMissing } = useAiProjectContext(projectId, locale);
  const t = (zh: string, en: string) => tr(locale, zh, en);
  const workspaceTarget = useMemo(() => assistantWorkspaceTarget(context), [context]);
  const effectiveSources = useMemo(() => assistantContextSources(workspaceTarget, contextSources, locale), [contextSources, locale, workspaceTarget]);
  const requestScope = JSON.stringify([projectId, workspaceTarget.scene?.id, workspaceTarget.script?.id, workspaceTarget.selected?.id, mode]);
  const scopeLabel = [workspaceTarget.project?.name, workspaceTarget.scene?.name, workspaceTarget.script?.name,
    workspaceTarget.selected?.name ?? workspaceTarget.selected?.id].filter(Boolean).join(" · ");
  const sessions = useAssistantSessions(projectId, JSON.stringify([workspaceTarget.scene?.id, workspaceTarget.script?.id]));
  const { conversation } = sessions;
  const { answer, setAnswer, execution, busy, stopped, setStopped, error, setError, lastPrompt, setLastPrompt, lastScope,
    dashboard, setDashboard, bimEvidence, setBimEvidence, requestAbort, cancelRequest, ask } = useAssistantChatRun({
    sessions, projectId, requestScope: `${requestScope}:${sessions.identity}`, scopeLabel, scopeId: workspaceTarget.scene?.id ?? workspaceTarget.script?.id,
    question, setQuestion, mode, locale, context, platformContext, sources: effectiveSources, sessionOptions,
    prepareBim: onPrepareBimContext,
    onBegin: () => { messageScroll.follow(); setApplyNotice(undefined); setApplyError(undefined); setConfirmDashboard(false); },
  });
  const messageScroll = useAssistantScroll(`${conversation.length}:${answer}:${busy}:${error ?? ""}:${stopped}:${experience}`,
    conversation.length > 0 || busy || Boolean(answer || error) || stopped);


  useEffect(() => {
    if (mode === "component" && !workspaceTarget.selected) setMode(surface === "studio" ? "scene" : "platform");
  }, [mode, surface, workspaceTarget.selected]);

  useEffect(() => {
    cancelRequest();
    setAnswer("");
    setQuestion("");
    setLastPrompt("");
    setStopped(false);
    messageScroll.follow();
    setError(undefined);
    setDashboard(undefined);
    setConfirmDashboard(false);
    setBimEvidence(undefined);
    setApplyNotice(undefined);
    panelDrag.reset();
    return () => {
      void cancelRequest();
    };
  }, [projectId, workspaceTarget.scene?.id, workspaceTarget.script?.id]);

  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      if (confirmDashboard) setConfirmDashboard(false);
      else { cancelRequest(); onClose(); }
    };
    window.addEventListener("keydown", dismiss);
    return () => window.removeEventListener("keydown", dismiss);
  }, [confirmDashboard, onClose]);

  useEffect(() => {
    setDashboard(undefined);
    setConfirmDashboard(false);
    setBimEvidence(undefined);
    if (!requestAbort.current) return;
    cancelRequest();
    setQuestion((draft) => draft || lastPrompt);
    setStopped(true);
  }, [workspaceTarget.selected?.id]);

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

  const tabs = assistantModeTabs(locale, surface, Boolean(workspaceTarget.selected), Boolean(onApplyDashboard));
  const suggestions = assistantSuggestions(mode, locale);
  const latestReliability = conversation.at(-1)?.reliability;

  return (
    <aside
      ref={panelDrag.panelRef}
      className={`ai-assistant-panel ai-assistant-${surface} ${experience === "agent" ? "agent-active" : ""}`}
      style={panelDrag.style}
    >
      <header
        data-drag-handle="true"
        title={t("拖动标题栏移动助手面板", "Drag the title bar to move the assistant panel")}
        onPointerDown={panelDrag.onPointerDown}
        onPointerMove={panelDrag.onPointerMove}
        onPointerUp={panelDrag.onPointerUp}
        onPointerCancel={panelDrag.onPointerCancel}
      >
        <div>
          <Bot size={18} />
          <span>
            <strong>{t("平台 AI 助手", "Platform AI Assistant")}</strong>
          </span>
        </div>
        <div className="ai-assistant-header-actions">
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
              setStopped(false);
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
      <div className="ai-assistant-body" ref={messageScroll.bodyRef} onScroll={messageScroll.onScroll}>
        {experience === "agent" ? (
          <IndustrialAgentWorkspace locale={locale} {...(projectId ? { projectId } : {})} context={context} />
        ) : <>
          <AiAssistantSessionControls locale={locale} sessions={sessions} disabled={busy} onSwitch={() => {
            void cancelRequest(); setAnswer(""); setLastPrompt(""); setQuestion(""); setStopped(false); setError(undefined);
            setDashboard(undefined); setConfirmDashboard(false); setBimEvidence(undefined);
          }} />
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
        <AiAssistantMessages locale={locale} conversation={conversation} busy={busy} error={error}
          stopped={stopped} lastPrompt={lastPrompt} lastScope={lastScope} answer={answer} execution={execution}
          onRetry={() => void ask(lastPrompt)} />
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
      {experience === "chat" && <AssistantModelControls locale={locale} mode={mode} value={sessionOptions}
        onChange={setSessionOptions} disabled={busy} />}
      {experience === "chat" && <AiAssistantComposer locale={locale} question={question} busy={busy}
        onChange={setQuestion} onSend={() => { if (!sessions.loading) void ask(); }} onStop={() => {
          cancelRequest();
          setStopped(true);
          setQuestion((draft) => draft || lastPrompt);
        }} />}
    </aside>
  );
}
