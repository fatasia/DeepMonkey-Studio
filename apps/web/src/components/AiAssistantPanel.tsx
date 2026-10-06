import { AiAssistantMessages } from "./AiAssistantMessages";
import { AiAssistantComposer } from "./AiAssistantComposer";
import { AssistantModelControls, type AssistantSessionOptions } from "./AssistantModelControls";
import { useAssistantScroll } from "../ai/useAssistantScroll";
import { assistantContextSources } from "../ai/assistantContextSources";
import { useFloatingPanelDrag } from "../hooks/useFloatingPanelDrag";
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Bot, Boxes, ChevronDown, Database, LayoutDashboard, MessageSquare, Replace, RotateCcw, Sparkles, Workflow, X } from "lucide-react";
import type { DataDatasetRecord, SceneDashboardState } from "@bim-studio/contracts";
import { api, type AssistantMode } from "../api";
import type { BimAssistantPreparedContext } from "../bimAssistant";
import { translate as tr, type AppLocale } from "../i18n";
import { AiChangeConfirmation } from "./AiChangeConfirmation";
import { AiModeSelect } from "./AiModeSelect";
import { AskDataQuickQuery } from "./AskDataQuickQuery";
import { AiCapabilityCatalog } from "./AiCapabilityCatalog";
import type { AiWorkspaceTask } from "../ai/capabilityCatalog";
import { assistantModeTabs } from "../ai/assistantModeTabs";
import { assistantSuggestions } from "../ai/assistantSuggestions";
import {
  assistantContextReadiness,
  assistantWorkspaceTarget,
} from "../ai/assistantReliability";
import { useAiProjectContext } from "../ai/useAiProjectContext";
import { useAssistantSessions } from "../ai/useAssistantSessions";
import { useAssistantChatRun } from "../ai/useAssistantChatRun";
import { AiAssistantSessionControls, AiAssistantSessionPicker } from "./AiAssistantSessionControls";
import { AiContextDisclosure, CHAT_HISTORY_WINDOW } from "./AiContextDisclosure";
import { AiMemoryPanel } from "./AiMemoryPanel";
import { AiProvenancePanel } from "./AiProvenancePanel";
import { AiBimClarificationCard } from "./AiBimClarificationCard";
import { BimAssistantEvidence, type BimAssistantAction } from "./BimAssistantEvidence";
import { IndustrialAgentWorkspace } from "./IndustrialAgentWorkspace";
import type { SceneEditPort } from "../ai/sceneEditSession";
import "./AiAssistantReliability.css";

interface AiAssistantPanelProps {
  locale: AppLocale;
  projectId: string | undefined;
  context: unknown;
  surface?: "studio" | "platform";
  onPrepareBimContext?: (question: string) => Promise<BimAssistantPreparedContext>;
  onBimAction?: (action: BimAssistantAction, context: BimAssistantPreparedContext, componentId?: string) => void;
  onApplyDashboard?: (dashboard: SceneDashboardState) => void;
  onValidateDashboardPageDraft?: (draft: unknown, datasets: readonly DataDatasetRecord[]) => { changeCount: number; labels: string[] };
  onApplyDashboardPageDraft?: (draft: unknown, datasets: readonly DataDatasetRecord[]) => void;
  onOpenWorkspaceTask?: (task: Extract<AiWorkspaceTask, { workspace: "operations" }>) => void;
  /** Studio 提供:"执行任务"页的场景改动闭环端口。 */
  sceneEdit?: SceneEditPort;
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
  onValidateDashboardPageDraft,
  onApplyDashboardPageDraft,
  onOpenWorkspaceTask,
  sceneEdit,
  onClose,
}: AiAssistantPanelProps) {
  const [mode, setMode] = useState<AssistantMode>(() => assistantWorkspaceTarget(context).workspace === "dashboard" ? "dashboard" : surface === "studio" ? "scene" : "platform");
  const [experience, setExperience] = useState<"chat" | "agent">("chat");
  const [sessionOptions, setSessionOptions] = useState<AssistantSessionOptions>({});
  const [question, setQuestion] = useState("");
  const [confirmDashboard, setConfirmDashboard] = useState(false);
  const [applyBusy, setApplyBusy] = useState(false);
  const [applyError, setApplyError] = useState<string>();
  const [applyNotice, setApplyNotice] = useState<string>();
  const [dashboardPageDraft, setDashboardPageDraft] = useState<{ raw: unknown; changeCount: number; labels: string[] }>();
  const [requestStartedAt, setRequestStartedAt] = useState<number>();
  const [capabilityDrawerOpen, setCapabilityDrawerOpen] = useState(false);
  const panelDrag = useFloatingPanelDrag<HTMLElement>();
  const { platformContext, contextSources, datasets, platformLoaded, projectMissing } = useAiProjectContext(projectId, locale);
  const t = (zh: string, en: string) => tr(locale, zh, en);
  const workspaceTarget = useMemo(() => assistantWorkspaceTarget(context), [context]);
  const requestContext = useMemo(() => mode === "dashboard" && workspaceTarget.workspace === "dashboard"
    ? { ...(context as Record<string, unknown>), datasets: datasets.map(dataset => ({ id: dataset.id, name: dataset.name, fields: dataset.fields })) }
    : context, [context, datasets, mode, workspaceTarget.workspace]);
  const effectiveSources = useMemo(() => assistantContextSources(workspaceTarget, contextSources, locale), [contextSources, locale, workspaceTarget]);
  const requestScope = JSON.stringify([projectId, workspaceTarget.scene?.id, workspaceTarget.dashboard?.id, workspaceTarget.script?.id, workspaceTarget.selected?.id, mode]);
  const scopeLabel = [workspaceTarget.project?.name, workspaceTarget.scene?.name, workspaceTarget.dashboard?.name, workspaceTarget.script?.name,
    workspaceTarget.selected?.name ?? workspaceTarget.selected?.id].filter(Boolean).join(" · ");
  const sessions = useAssistantSessions(projectId, JSON.stringify([workspaceTarget.scene?.id, workspaceTarget.dashboard?.id, workspaceTarget.script?.id]));
  const { conversation } = sessions;
  const { answer, setAnswer, execution, busy, stopped, setStopped, error, setError, lastPrompt, setLastPrompt, lastScope,
    dashboard, setDashboard, bimEvidence, setBimEvidence, requestAbort, cancelRequest, ask, dashboardStreamPreview } = useAssistantChatRun({
    sessions, projectId, requestScope: `${requestScope}:${sessions.identity}`, scopeLabel, scopeId: workspaceTarget.scene?.id ?? workspaceTarget.dashboard?.id ?? workspaceTarget.script?.id,
    question, setQuestion, mode, locale, context: requestContext, platformContext, sources: effectiveSources, sessionOptions,
    prepareBim: onPrepareBimContext,
    ...(onValidateDashboardPageDraft ? { onDashboardPageDraft: (raw: unknown) => {
      const preview = onValidateDashboardPageDraft(raw, datasets);
      setDashboardPageDraft({ raw, ...preview });
    } } : {}),
    onBegin: () => { messageScroll.follow(); setApplyNotice(undefined); setApplyError(undefined); setConfirmDashboard(false); setDashboardPageDraft(undefined); setRequestStartedAt(Date.now()); },
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
    setDashboardPageDraft(undefined);
    setConfirmDashboard(false);
    setBimEvidence(undefined);
    setApplyNotice(undefined);
    panelDrag.reset();
    return () => {
      void cancelRequest();
    };
  }, [projectId, workspaceTarget.scene?.id, workspaceTarget.dashboard?.id, workspaceTarget.script?.id]);

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
    setDashboardPageDraft(undefined);
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
      setDashboardPageDraft(undefined);
      setConfirmDashboard(false);
      setApplyNotice(t("已写入当前看板草稿，尚未保存或发布。", "Applied to the current dashboard draft; it has not been saved or published."));
    } catch (reason) {
      setApplyError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setApplyBusy(false);
    }
  }

  async function applyDashboardPageDraft() {
    if (!dashboardPageDraft || !onApplyDashboardPageDraft) return;
    setApplyBusy(true);
    setApplyError(undefined);
    try {
      await Promise.resolve(onApplyDashboardPageDraft(dashboardPageDraft.raw, datasets));
      setDashboardPageDraft(undefined);
      setConfirmDashboard(false);
      setApplyNotice(t("已应用到当前二维页面，可撤销；尚未保存或发布。", "Applied to the current 2D page and can be undone; it has not been saved or published."));
    } catch (reason) {
      setApplyError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setApplyBusy(false);
    }
  }

  // T8（审计 §二 2.3）：失败恢复从单一"重试原问题"扩为多路——
  // ①换备用模型重试：从模型目录取一个不同于当前模型的候选后重发；
  // ②改用受控问数：携带原问题切入问数据模式（目录不可用/无备用模型时按钮仍可用，等同原样重试）。
  async function retryWithAlternateModel() {
    if (!lastPrompt || busy) return;
    try {
      const catalog = await api.getAssistantModels();
      const current = sessionOptions.model ?? catalog.defaultModel;
      const alternate = catalog.models.map((item) => item.id).find((id) => id !== current);
      if (alternate) setSessionOptions({ model: alternate });
    } catch {
      // 模型目录不可用时保持当前会话选项原样重试（与"重试原问题"等价，不阻塞恢复）。
    }
    void ask(lastPrompt);
  }

  function switchToControlledQuery() {
    if (busy || !lastPrompt) return;
    selectMode("sql");
    setQuestion(lastPrompt);
  }

  // T1：澄清卡就地作答——点选项即以该答案重新发起提问。
  function answerClarification(answerText: string) {
    setQuestion("");
    void ask(answerText);
  }

  // T10（审计 §二 2.4）：三证体系首次引导的"在哪运行"动作——记忆/档案空态一键切到执行任务页签。
  function openAgentWorkspace() {
    if (busy) return;
    setExperience("agent");
  }

  const dashboardModeAvailable = Boolean(onApplyDashboard || onValidateDashboardPageDraft);
  const tabs = assistantModeTabs(locale, surface, Boolean(workspaceTarget.selected), dashboardModeAvailable);
  const suggestions = assistantSuggestions(mode, locale);
  const latestReliability = conversation.at(-1)?.reliability;
  const readiness = assistantContextReadiness(effectiveSources);
  const contextLoading = !platformLoaded && !projectMissing;
  const conversationActive = conversation.length > 0 || Boolean(answer) || busy || Boolean(error);
  const capabilityTaskProps = {
    canOpenTask: (task: AiWorkspaceTask) => Boolean(projectId) && (task.workspace === "ask-data" || Boolean(onOpenWorkspaceTask)),
    onOpenTask: (task: AiWorkspaceTask) => {
      if (task.workspace === "ask-data") { selectMode("sql"); return; }
      onOpenWorkspaceTask?.(task as Extract<AiWorkspaceTask, { workspace: "operations" }>);
    },
  };

  function selectMode(next: AssistantMode) {
    setMode(next);
    setStopped(false);
    setAnswer("");
    setDashboard(undefined);
    setDashboardPageDraft(undefined);
    setConfirmDashboard(false);
    setError(undefined);
    setApplyError(undefined);
  }

  function resetForSessionSwitch() {
    void cancelRequest(); setAnswer(""); setLastPrompt(""); setQuestion(""); setStopped(false); setError(undefined);
    setDashboard(undefined); setConfirmDashboard(false); setBimEvidence(undefined);
  }

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
        <div className="ai-assistant-title">
          <Bot size={18} />
          <span>
            <strong>{workspaceTarget.workspace === "dashboard" ? t("二维 AI 助手", "2D AI Assistant") : t("平台 AI 助手", "Platform AI Assistant")}</strong>
            {experience === "chat" && <AiAssistantSessionPicker locale={locale} sessions={sessions} disabled={busy} onSwitch={resetForSessionSwitch} />}
          </span>
        </div>
        <div className="ai-assistant-header-actions">
          <div className="ai-assistant-experience" role="tablist" aria-label={t("AI 使用方式", "AI experience")}>
            <button role="tab" disabled={busy} aria-selected={experience === "chat"} title={t("问答与生成", "Ask & create")} className={experience === "chat" ? "active" : ""} onClick={() => setExperience("chat")}>
              <MessageSquare size={13} /><span>{t("对话", "Chat")}</span>
            </button>
            <button role="tab" disabled={busy} aria-selected={experience === "agent"} title={t("执行任务", "Run task")} className={experience === "agent" ? "active" : ""} onClick={() => setExperience("agent")}>
              <Workflow size={13} /><span>{t("执行任务", "Run task")}</span>
            </button>
          </div>
          <button className="ai-assistant-close" aria-label={t("关闭 AI 助手", "Close AI assistant")} title={t("关闭 AI 助手（Esc）", "Close AI assistant (Esc)")} onClick={() => { cancelRequest(); onClose(); }}>
            <X size={15} />
          </button>
        </div>
      </header>
      <div className="ai-assistant-body" ref={messageScroll.bodyRef} onScroll={messageScroll.onScroll}>
        {experience === "agent" ? (
          <IndustrialAgentWorkspace locale={locale} {...(projectId ? { projectId } : {})} {...(sceneEdit ? { sceneEdit } : {})} context={context} />
        ) : <>
          <AiAssistantSessionControls locale={locale} sessions={sessions} disabled={busy} onSwitch={resetForSessionSwitch} />
          {/* 上下文、记忆、实验档案合并为一条折叠行：默认只露出范围与来源就绪度，细节按需展开。 */}
          <details className="ai-context-disclosure ai-context-group" aria-label={t("本次上下文", "Request context")}>
            <summary>
              <span>
                <Database size={13} aria-hidden="true" />
                <strong title={`${t("本次读取范围", "Context used for this request")} · ${scopeLabel || t("全平台", "Platform")}`}>{scopeLabel || t("全平台", "Platform")}</strong>
              </span>
              <span className={contextLoading ? "loading" : readiness.unavailable > 0 ? "partial" : "ready"}>
                {contextLoading
                  ? t("读取中", "Loading")
                  : t(`${readiness.ready}/${readiness.total} 个来源就绪`, `${readiness.ready}/${readiness.total} sources ready`)}
                {projectId && <small>{t(" · 记忆 · 档案", " · memory · archive")}</small>}
                <ChevronDown size={12} />
              </span>
            </summary>
            <div className="ai-context-group-body">
              <AiContextDisclosure embedded locale={locale} mode={mode} context={context} sources={effectiveSources} loading={contextLoading}
                {...(conversation.length > CHAT_HISTORY_WINDOW ? { historyWindow: { sent: CHAT_HISTORY_WINDOW, total: conversation.length } } : {})} />
              {/* K14：记忆与实验档案常驻（projectId 权限闸），收进上下文组内避免三条并列折叠行。 */}
              {projectId && <AiMemoryPanel locale={locale} projectId={projectId} onOpenAgent={openAgentWorkspace} />}
              {projectId && <AiProvenancePanel locale={locale} projectId={projectId} onOpenAgent={openAgentWorkspace} />}
            </div>
          </details>
          {/* T9：能力目录统一为折叠行（空态与对话中同一入口），展开才挂载目录，避免双请求。 */}
          {(mode === "platform" || mode === "scene") && (
            <details className="ai-context-disclosure ai-capability-drawer" aria-label={t("可用能力", "Available capabilities")}
              open={capabilityDrawerOpen} onToggle={(event) => setCapabilityDrawerOpen((event.target as HTMLDetailsElement).open)}>
              <summary>
                <span><Boxes size={13} aria-hidden="true" /><strong>{t("可用能力", "Available capabilities")}</strong></span>
                <span className="ready">{t("展开查看与提问", "Expand to browse and ask")}<ChevronDown size={12} /></span>
              </summary>
              {capabilityDrawerOpen && (
                <AiCapabilityCatalog locale={locale} askDisabled={busy} {...capabilityTaskProps}
                  onAskExample={(sample) => void ask(sample)} />
              )}
            </details>
          )}
          {mode === "sql" && projectId && <AskDataQuickQuery projectId={projectId} datasets={datasets} locale={locale} />}
          {!conversationActive && mode !== "sql" && (
            <div className="ai-assistant-empty">
              <Sparkles size={22} aria-hidden="true" />
              <strong>{t("问当前平台，不问空泛知识", "Ask your platform, not generic knowledge")}</strong>
              <span>{t("回答只基于本项目证据与已装载能力；点下面的问题即可直接提问。", "Answers use only this project's evidence and loaded capabilities; tap a question to ask it.")}</span>
              <div className="ai-platform-suggestions">
                {suggestions.map((item) => (
                  <button key={item} type="button" disabled={busy || sessions.loading} onClick={() => void ask(item)}>
                    <Sparkles size={12} aria-hidden="true" /><span>{item}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        <AiAssistantMessages locale={locale} conversation={conversation} busy={busy} error={error}
          stopped={stopped} lastPrompt={lastPrompt} lastScope={lastScope} answer={answer} execution={execution}
          onRetry={() => void ask(lastPrompt)} {...(projectId ? { projectId } : {})}
          {...(requestStartedAt !== undefined && busy ? { requestStartedAt } : {})}
          onAnswerClarification={answerClarification}
          {...(mode === "dashboard" ? { busyHint: t("正在生成结构化方案…", "Generating a structured plan…") } : {})} />
        {dashboard && onApplyDashboard && !confirmDashboard && (
          <button className="primary ai-apply-dashboard" onClick={() => setConfirmDashboard(true)}>
            <LayoutDashboard size={13} />
            {t("查看并应用", "Review & apply")}
          </button>
        )}
        {dashboardStreamPreview && !dashboardPageDraft && (
          <div className="ai-dashboard-stream-preview" role="status">
            {t(`正在生成布局：${dashboardStreamPreview.labels.length} 个组件`, `Generating layout: ${dashboardStreamPreview.labels.length} widgets`)}
            {dashboardStreamPreview.types.length > 0 && (
              <small>{dashboardStreamPreview.types.join(" · ")}</small>
            )}
          </div>
        )}
        {dashboardPageDraft && onApplyDashboardPageDraft && !confirmDashboard && (
          <button className="primary ai-apply-dashboard" onClick={() => setConfirmDashboard(true)}>
            <LayoutDashboard size={13} />
            {t("查看并应用二维变更", "Review & apply 2D changes")}
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
        {dashboardPageDraft && onApplyDashboardPageDraft && confirmDashboard && (
          <AiChangeConfirmation
            locale={locale}
            widgetCount={dashboardPageDraft.changeCount}
            widgetLabels={dashboardPageDraft.labels}
            evidenceLabels={latestReliability?.sourceLabels ?? []}
            changeDescription={t(`修改 ${dashboardPageDraft.changeCount} 个二维组件`, `Change ${dashboardPageDraft.changeCount} 2D components`)}
            scopeDescription={t("当前二维页面草稿", "Current 2D page draft")}
            busy={applyBusy}
            {...(applyError ? { error: applyError } : {})}
            onCancel={() => { setConfirmDashboard(false); setApplyError(undefined); }}
            onConfirm={() => void applyDashboardPageDraft()}
          />
        )}
        {applyNotice && <div className="ai-assistant-apply-notice" role="status">{applyNotice}</div>}
        {bimEvidence && (
          <>
            {/* T3（审计 §二 2.1）：bim 低置信不再"不问就答"——就地给出候选确认卡。 */}
            <AiBimClarificationCard locale={locale} evidence={bimEvidence}
              {...(onBimAction ? { onAction: onBimAction } : {})} />
            <BimAssistantEvidence
              locale={locale}
              evidence={bimEvidence}
              {...(onBimAction ? { onAction: onBimAction } : {})}
            />
          </>
        )}
          {error && (
          <section className="ai-assistant-error-state" role="alert">
            <strong><AlertTriangle size={13} /> {t("本次请求未完成", "Request did not complete")}</strong>
            <span>{error}</span>
            <small>{t("没有自动写入任何变更；原问题已保留。", "No changes were applied automatically; the original prompt is preserved.")}</small>
            <div className="ai-assistant-error-actions">
              <button type="button" disabled={busy || !lastPrompt} onClick={() => void ask(lastPrompt)}>
                <RotateCcw size={12} /> {t("重试原问题", "Retry original prompt")}
              </button>
              <button type="button" disabled={busy || !lastPrompt} title={t("从模型目录取另一个模型重发", "Retry with a different model from the catalog")}
                onClick={() => void retryWithAlternateModel()}>
                <Replace size={12} /> {t("换备用模型重试", "Retry with another model")}
              </button>
              {projectId && (
                <button type="button" disabled={busy || !lastPrompt}
                  title={t("原问题转入受控问数：查询走能力计划，数字全部来自数据集", "Move the prompt to controlled data query; numbers come only from datasets")}
                  onClick={switchToControlledQuery}>
                  <Database size={12} /> {t("改用受控问数", "Switch to controlled data query")}
                </button>
              )}
            </div>
          </section>
          )}
        </>}
      </div>
      {experience === "chat" && <AiAssistantComposer locale={locale} question={question} busy={busy}
        sendDisabled={sessions.loading} disabledReason={t("正在恢复会话，请稍候", "Restoring the conversation; please wait")}
        toolbar={<>
          {/* 提问范围:平台统一 details 弹层下拉(2026-10-06 UI 修复),替代原生 select 系统弹窗。 */}
          <AiModeSelect locale={locale} value={mode} options={tabs} disabled={busy}
            onChange={(next) => selectMode(next as AssistantMode)} />
          <AssistantModelControls compact allowAuto lastRoute={execution?.route} locale={locale} mode={mode} value={sessionOptions} onChange={setSessionOptions} disabled={busy} />
        </>}
        onChange={setQuestion} onSend={() => { if (!sessions.loading) void ask(); }} onStop={() => {
          cancelRequest();
          setStopped(true);
          setQuestion((draft) => draft || lastPrompt);
        }} />}
    </aside>
  );
}
