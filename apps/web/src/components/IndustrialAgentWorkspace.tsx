import { useEffect, useMemo, useRef, useState } from "react";
import { AiExecutionDetails } from "./AiExecutionDetails";
import { AiHarnessDenialCard } from "./AiHarnessDenialCard";
import { AiHypothesisVerdictCard } from "./AiHypothesisVerdictCard";
import { AiMemoryPanel } from "./AiMemoryPanel";
import { AiProvenancePanel } from "./AiProvenancePanel";
import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleGauge,
  ClipboardList,
  FileCheck2,
  History,
  Layers,
  LoaderCircle,
  Map,
  PauseCircle,
  Play,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Workflow,
} from "lucide-react";
import type { AgentCheckpoint, AgentToolDefinition } from "@bim-studio/industrial-agent-orchestrator";
import { translate as tr, type AppLocale } from "../i18n";
import {
  agentEvidenceViews,
  agentDecisionStatusLabel,
  agentGuardCircuit,
  agentGuardDenials,
  agentObjectiveExamples,
  agentProgress,
  agentStatusLabel,
  agentStatusTone,
  agentVerdictEnvelopes,
  describeAgentEffect,
  describeApprovalSource,
  AUTONOMY_APPROVER_ID,
  isAgentTerminal,
  isAutonomousRun,
  selectedToolPreview,
} from "../ai/industrialAgentViewModel";
import "./IndustrialAgentWorkspace.css";
import { IndustrialAgentContinuation } from "./IndustrialAgentContinuation";
import { AssistantModelControls, type AssistantSessionOptions } from "./AssistantModelControls";
import { AgentCrossProjectNotice, AgentRecoveryFailureNotice, AgentRunHistoryPanel } from "./AgentRunHistoryPanel";
import {
  browserRunHistoryStore,
  isStaleCheckpoint,
} from "../ai/agentRunHistory";
import {
  AGENT_POLL_INTERVAL_MS,
  createAgentPollBackoff,
  shouldReportPollFailure,
} from "../ai/agentRunPolling";
import { ServerRequestError } from "@bim-studio/server-sdk";
import { SCENE_EDIT_DEFAULT_CORRECTIONS, SCENE_EDIT_MAX_CORRECTIONS, type SceneEditPort } from "../ai/sceneEditSession";
import { useSceneEditLoop } from "../hooks/useSceneEditLoop";
import { SceneEditLoopCard } from "./SceneEditLoopCard";

const DEFAULT_BUDGET = { maxSteps: 10, maxToolCalls: 6, maxDurationMs: 90_000 };

export function IndustrialAgentWorkspace(props: {
  locale: AppLocale;
  projectId?: string;
  context: unknown;
  surface?: "assistant" | "script";
  /** 仅 Studio 提供:场景改动闭环端口(差异预览→应用→验证→撤销)。 */
  sceneEdit?: SceneEditPort;
  onBack?: () => void;
}) {
  const { locale, projectId, context, surface = "assistant" } = props;
  const [objective, setObjective] = useState("");
  const [planMode, setPlanMode] = useState(false);
  const [modelOptions, setModelOptions] = useState<AssistantSessionOptions>({});
  const [tools, setTools] = useState<AgentToolDefinition[]>([]);
  const [selectedToolIds, setSelectedToolIds] = useState<Set<string>>(new Set());
  const [checkpoint, setCheckpoint] = useState<AgentCheckpoint>();
  const [loadingTools, setLoadingTools] = useState(Boolean(projectId));
  const [busy, setBusy] = useState(false);
  const [restored, setRestored] = useState(false);
  const [error, setError] = useState<string>();
  // H-autonomy 要素①：执行模式与发现面（持久化默认读回 + 逐次覆盖）。
  const [executionMode, setExecutionMode] = useState<"confirm" | "autonomous">("confirm");
  const [generalAvailable, setGeneralAvailable] = useState(false);
  const [discovery, setDiscovery] = useState<"curated" | "general">("curated");
  const [modeSaving, setModeSaving] = useState(false);
  const [sceneEditOn, setSceneEditOn] = useState(false);
  const [maxCorrections, setMaxCorrections] = useState(SCENE_EDIT_DEFAULT_CORRECTIONS);
  const sceneLoop = useSceneEditLoop(props.sceneEdit, projectId);
  // H-C5-K11：恢复失败与跨项目运行显式可见，不再只有一句泛化提示或静默丢弃。
  const [recoveryFailure, setRecoveryFailure] = useState<{ runId: string; notFound: boolean; message?: string }>();
  const [crossProject, setCrossProject] = useState<{ runId: string; projectId: string }>();
  const requestEpoch = useRef(0);
  const activeProject = useRef(projectId);
  const actionPending = useRef(false);
  if (activeProject.current !== projectId) {
    activeProject.current = projectId;
    requestEpoch.current += 1;
    actionPending.current = false;
  }
  useEffect(() => () => { requestEpoch.current += 1; }, []);
  const t = (zh: string, en: string) => tr(locale, zh, en);
  const preview = useMemo(() => selectedToolPreview(tools, selectedToolIds), [selectedToolIds, tools]);
  const sceneMode = sceneEditOn && Boolean(props.sceneEdit);
  const runSceneEdit = () => {
    const text = objective.trim();
    if (text) void sceneLoop.start({ objective: text, mode: planMode ? "plan" : executionMode, maxCorrections, modelOptions });
  };

  useEffect(() => {
    setCheckpoint(undefined);
    setObjective("");
    setBusy(false);
    setTools([]);
    setSelectedToolIds(new Set());
    setRestored(false);
    setError(undefined);
    setRecoveryFailure(undefined);
    setCrossProject(undefined);
    setExecutionMode("confirm");
    setGeneralAvailable(false);
    setDiscovery("curated");
    if (!projectId) {
      setTools([]);
      setSelectedToolIds(new Set());
      setLoadingTools(false);
      return;
    }
    const controller = new AbortController();
    setLoadingTools(true);
    void getAgentApi().then(async (client) => {
      const runId = latestRememberedRunId(projectId);
      const [catalogResult, recoveryResult, settingsResult] = await Promise.allSettled([
        client.listIndustrialAgentTools(projectId, controller.signal),
        runId ? client.getIndustrialAgentRun(projectId, runId, controller.signal) : Promise.resolve(undefined),
        client.getAgentAutonomySettings(projectId, controller.signal),
      ]);
      if (controller.signal.aborted) return;
      if (catalogResult.status === "rejected") throw catalogResult.reason;
      setTools(catalogResult.value.tools);
      setSelectedToolIds(new Set(catalogResult.value.tools.map((tool) => tool.id)));
      // H-autonomy 要素①：持久化默认读回（失败不阻塞工作台，回落 confirm/curated 现状）。
      if (settingsResult.status === "fulfilled") {
        setExecutionMode(settingsResult.value.settings.mode === "autonomous" ? "autonomous" : "confirm");
        setGeneralAvailable(settingsResult.value.settings.generalDevelopment === true);
      }
      if (recoveryResult.status === "fulfilled" && recoveryResult.value) {
        setCheckpoint(recoveryResult.value);
        setObjective(recoveryResult.value.objective);
        setRestored(true);
      } else if (recoveryResult.status === "rejected" && !controller.signal.aborted && runId) {
        // K11：旧 checkpoint 不可达时给出 runId 与重试入口；仍允许创建新任务。
        setRecoveryFailure({ runId, notFound: isNotFound(recoveryResult.reason), message: errorMessage(recoveryResult.reason) });
      }
    }).catch((reason) => {
      if (!controller.signal.aborted) setError(errorMessage(reason));
    }).finally(() => {
      if (!controller.signal.aborted) setLoadingTools(false);
    });
    return () => controller.abort();
  }, [projectId]);

  useEffect(() => {
    if (!projectId || checkpoint?.status !== "running" || busy) return;
    // K10：失败后指数退避（1.2s→…→15s 封顶），连续失败只在首次上报，成功即复位。
    const backoff = createAgentPollBackoff();
    const controller = new AbortController();
    let refreshing = false;
    let timer = 0;
    const schedule = (delay: number) => { timer = window.setTimeout(tick, delay); };
    const tick = () => {
      if (refreshing) return;
      refreshing = true;
      void getAgentApi().then((client) => controller.signal.aborted ? undefined : client.getIndustrialAgentRun(projectId, checkpoint.id, controller.signal))
        .then((next) => {
          if (controller.signal.aborted) return;
          backoff.reset();
          schedule(AGENT_POLL_INTERVAL_MS);
          if (next) updateCheckpoint(next);
        })
        .catch((reason) => {
          if (controller.signal.aborted) return;
          const failures = backoff.failures + 1;
          schedule(backoff.next());
          if (shouldReportPollFailure(failures)) setError(errorMessage(reason));
        })
        .finally(() => { refreshing = false; });
    };
    schedule(AGENT_POLL_INTERVAL_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [busy, checkpoint?.id, checkpoint?.status, projectId]);

  function updateCheckpoint(next: AgentCheckpoint) {
    if (next.projectId !== projectId) {
      // K11：跨项目 checkpoint 不静默丢弃——显式标注并保留本地视图。
      setCrossProject({ runId: next.id, projectId: next.projectId });
      return;
    }
    setCrossProject(undefined);
    setCheckpoint((current) => current?.id === next.id && current.revision > next.revision ? current : next);
    setError(undefined);
    if (projectId) rememberCheckpoint(projectId, next);
  }

  /** 从历史区打开一条本地记住的运行；失败给出 runId 与重试入口（K11）。 */
  async function openRememberedRun(runId: string) {
    if (!projectId || actionPending.current) return;
    const epoch = requestEpoch.current;
    const isCurrent = () => requestEpoch.current === epoch;
    actionPending.current = true;
    setBusy(true);
    setError(undefined);
    setRecoveryFailure(undefined);
    try {
      const client = await getAgentApi();
      if (!isCurrent()) return;
      const next = await client.getIndustrialAgentRun(projectId, runId);
      if (!isCurrent()) return;
      if (next.projectId !== projectId) {
        // 用户主动点开的跨项目运行：只标注，不替换当前视图（作用域守卫保持项目隔离）。
        setCrossProject({ runId: next.id, projectId: next.projectId });
        return;
      }
      setCheckpoint(next);
      setObjective(next.objective);
      setRestored(true);
    } catch (reason) {
      if (!isCurrent()) return;
      setRecoveryFailure({ runId, notFound: isNotFound(reason), message: errorMessage(reason) });
    } finally {
      if (isCurrent()) { actionPending.current = false; setBusy(false); }
    }
  }

  async function retryRecovery(runId: string) {
    await openRememberedRun(runId);
  }

  async function start(sample = false) {
    const runObjective = sample ? t("只读检查当前项目可用能力与数据，引用实际证据给出一条可验证结论；没有数据时明确说明缺失，不执行写入或控制。", "Inspect current project capabilities and data read-only. Return one verifiable conclusion with actual evidence; report missing data and perform no writes or controls.") : objective.trim();
    const toolIds = sample ? tools.filter(tool => tool.effect === "read" && !tool.requiresApproval).map(tool => tool.id) : [...selectedToolIds];
    if (!projectId || !runObjective || toolIds.length === 0 || actionPending.current) return;
    if (sample) setObjective(runObjective);
    const epoch = requestEpoch.current;
    const isCurrent = () => requestEpoch.current === epoch;
    actionPending.current = true;
    setBusy(true);
    setRestored(false);
    setError(undefined);
    try {
      const client = await getAgentApi();
      if (!isCurrent()) return;
      const next = await client.startIndustrialAgentRun(projectId, {
        objective: runObjective,
        modelOptions,
        context,
        allowedToolIds: toolIds,
        ...(planMode ? { planMode: true } : {}),
        // H-autonomy：执行模式逐次覆盖（confirm 不带字段=历史请求形状不变）；general 面显式声明。
        ...(executionMode === "autonomous" ? { executionMode } : {}),
        ...(discovery === "general" ? { discovery } : {}),
        budget: DEFAULT_BUDGET,
      });
      // 后台任务不因切页重放；只在所属项目记住 ID，界面更新仍要求当前请求所有权。
      if (next.projectId === projectId) rememberCheckpoint(projectId, next);
      if (isCurrent()) updateCheckpoint(next);
    } catch (reason) {
      if (isCurrent()) setError(errorMessage(reason));
    } finally {
      if (isCurrent()) { actionPending.current = false; setBusy(false); }
    }
  }

  /** H-autonomy 要素①：切换执行模式即持久化（新运行默认随之生效）；失败回滚并显式报错。 */
  async function changeExecutionMode(mode: "confirm" | "autonomous") {
    if (!projectId || modeSaving || mode === executionMode) return;
    const epoch = requestEpoch.current;
    const isCurrent = () => requestEpoch.current === epoch;
    const previous = executionMode;
    setExecutionMode(mode);
    setModeSaving(true);
    setError(undefined);
    try {
      const client = await getAgentApi();
      await client.updateAgentAutonomySettings(projectId, { mode });
    } catch (reason) {
      if (isCurrent()) setExecutionMode(previous);
      setError(errorMessage(reason));
    } finally {
      if (isCurrent()) setModeSaving(false);
    }
  }

  /** H-autonomy 要素④：通用开发发现面切换（开关由服务端门控，关闭时请求 400 fail-closed）。 */
  async function changeDiscovery(next: "curated" | "general") {
    if (!projectId || next === discovery || loadingTools) return;
    const controller = new AbortController();
    setLoadingTools(true);
    setError(undefined);
    try {
      const client = await getAgentApi();
      const view = await client.listIndustrialAgentTools(projectId, controller.signal, next);
      if (controller.signal.aborted) return;
      setTools(view.tools);
      setSelectedToolIds(new Set(view.tools.map((tool) => tool.id)));
      setDiscovery(view.discovery);
    } catch (reason) {
      if (!controller.signal.aborted) setError(errorMessage(reason));
    } finally {
      if (!controller.signal.aborted) setLoadingTools(false);
    }
  }

  async function act(action: "approve" | "resume" | "cancel" | "refresh", selectionId?: string) {
    if (!projectId || !checkpoint || actionPending.current) return;
    const epoch = requestEpoch.current;
    const isCurrent = () => requestEpoch.current === epoch;
    actionPending.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const client = await getAgentApi();
      if (!isCurrent()) return;
      const next = action === "approve" && checkpoint.pendingTool
        ? await client.approveIndustrialAgentRun(projectId, checkpoint.id, checkpoint.pendingTool.fingerprint)
        : action === "resume"
          ? await client.resumeIndustrialAgentRun(projectId, checkpoint.id, checkpoint.revision, selectionId)
          : action === "cancel"
            ? await client.cancelIndustrialAgentRun(projectId, checkpoint.id)
            : await client.getIndustrialAgentRun(projectId, checkpoint.id);
      if (isCurrent()) updateCheckpoint(next);
    } catch (reason) {
      if (!isCurrent()) return;
      const message = errorMessage(reason);
      // 多窗口或自动轮询已在推进时，保留 checkpoint 并继续刷新，不制造重复执行。
      setError(action === "resume" && /正在推进|run-busy/i.test(message) ? t("运行仍在推进，已继续跟踪进度", "The run is already progressing; tracking continues") : message);
    } finally {
      if (isCurrent()) { actionPending.current = false; setBusy(false); }
    }
  }

  return (
    <section className={`industrial-agent-workspace ${surface}`} aria-label={t("工业 Agent 工作区", "Industrial Agent workspace")}>
      {/* 助手面板里页签已标明"执行任务"，标题块只在脚本工作区（带返回入口）出现。 */}
      {props.onBack && (
        <header className="industrial-agent-heading">
          <span><Workflow size={17} /></span>
          <div>
            <strong>{t("工业任务 Agent", "Industrial task agent")}</strong>
            <small>{t("有边界、有确认、有证据的受控执行", "Bounded, confirmed and evidence-backed execution")}</small>
          </div>
          <button type="button" onClick={props.onBack}><ArrowLeft size={13} />{t("返回脚本", "Back to script")}</button>
        </header>
      )}

      {sceneLoop.session && !checkpoint ? (
        <SceneEditLoopCard locale={locale} session={sceneLoop.session} busy={sceneLoop.busy} onApprove={() => void sceneLoop.approve()} onReject={() => void sceneLoop.reject()}
          onCancel={sceneLoop.cancel} onUndo={() => void sceneLoop.undo()} onNew={() => { sceneLoop.reset(); setObjective(""); }} />
      ) : !checkpoint ? (
        <div className="industrial-agent-start">
          {/* H-C2/H-C3/K13：记忆、实验档案、历史运行合并为一条折叠行（与对话页上下文组同构），默认收起。 */}
          {projectId && (
            <details className="ai-context-disclosure ai-context-group" aria-label={t("记忆与历史运行", "Memory and run history")}>
              <summary>
                <span><History size={13} aria-hidden="true" /><strong>{t("记忆 · 档案 · 历史运行", "Memory · archive · runs")}</strong></span>
                <span className="ready">{t("展开", "Expand")}<ChevronDown size={12} /></span>
              </summary>
              <div className="ai-context-group-body">
                <AiMemoryPanel locale={locale} projectId={projectId} />
                <AiProvenancePanel locale={locale} projectId={projectId} />
                <AgentRunHistoryPanel locale={locale} projectId={projectId} onOpen={(runId) => void openRememberedRun(runId)} />
              </div>
            </details>
          )}
          <div className="ai-composer-box industrial-agent-objective">
            <textarea
              aria-label={t("任务目标", "Task objective")}
              value={objective}
              onChange={(event) => setObjective(event.target.value)}
              placeholder={t("用一句话说明目标，例如：检查当前产线的设备风险，给出有证据的处理建议。", "Describe the outcome, e.g. inspect line risks and return evidence-backed actions.")}
            />
            <div className="ai-composer-toolbar">
              <div className="ai-composer-tools">
                {/* H-autonomy 要素①：计划/逐次确认/自主执行合并为一个执行方式下拉；确认/自主切换即持久化为新运行默认。 */}
                <label className="ai-mode-select" title={t("计划只读探索不执行；逐次确认为默认；自主执行在授权内自动执行，取消与审计仍生效。", "Plan explores read-only; confirm-each is the default; autonomous runs within authorization with cancel and audit intact.")}>
                  {planMode ? <Map size={12} aria-hidden="true" /> : executionMode === "autonomous" ? <Play size={12} aria-hidden="true" /> : <ShieldCheck size={12} aria-hidden="true" />}
                  <select aria-label={t("执行方式", "Execution mode")} disabled={modeSaving || busy} value={planMode ? "plan" : executionMode}
                    onChange={(event) => {
                      const next = event.target.value;
                      if (next === "plan") { setPlanMode(true); return; }
                      setPlanMode(false);
                      if (next !== executionMode) void changeExecutionMode(next as "confirm" | "autonomous");
                    }}>
                    <option value="plan">{t("只出计划", "Plan only")}</option>
                    <option value="confirm">{t("逐次确认", "Confirm each")}</option>
                    <option value="autonomous">{t("自主执行", "Autonomous")}</option>
                  </select>
                </label>
                {props.sceneEdit && (
                  <button type="button" className="ai-plan-chip" aria-pressed={sceneEditOn} disabled={busy || sceneLoop.busy}
                    title={t("让 AI 直接改动当前场景:先预览差异,应用后截图自检,整批可一键撤销。", "Let AI edit the current scene: review the diff, apply, self-check against a screenshot, undo in one step.")}
                    onClick={() => setSceneEditOn((value) => !value)}>
                    <Layers size={13} aria-hidden="true" />{t("场景改动", "Scene edit")}
                  </button>
                )}
                {sceneMode && (
                  <label className="ai-mode-select" title={t("未达成时最多自动修正的轮次(含上限,防止失控)", "Maximum automatic correction rounds when the goal is not met")}>
                    <select aria-label={t("修正轮次上限", "Correction round limit")} disabled={sceneLoop.busy} value={maxCorrections} onChange={(event) => setMaxCorrections(Number(event.target.value))}>
                      {Array.from({ length: SCENE_EDIT_MAX_CORRECTIONS + 1 }, (_, n) => <option key={n} value={n}>{t(`修正 ${n} 轮`, ` corrections`)}</option>)}
                    </select>
                  </label>
                )}
                <AssistantModelControls compact locale={locale} mode="platform" value={modelOptions} onChange={setModelOptions} disabled={busy} />
              </div>
              <button className="ai-composer-send is-labeled" type="button" aria-label={sceneMode ? t("生成改动方案", "Draft scene plan") : t("预览并运行", "Review and run")}
                title={!projectId ? t("请先选择项目", "Select a project first") : sceneMode ? (props.sceneEdit?.unavailableReason() ?? t("生成可审阅的场景改动方案", "Draft a reviewable scene change plan")) : selectedToolIds.size === 0 ? t("至少选择一项能力", "Select at least one capability") : t("预览并运行", "Review and run")}
                disabled={sceneMode ? sceneLoop.busy || !projectId || !objective.trim() : busy || loadingTools || !projectId || !objective.trim() || selectedToolIds.size === 0} onClick={() => sceneMode ? runSceneEdit() : void start()}>
                {(sceneMode ? sceneLoop.busy : busy) ? <LoaderCircle className="spin" size={13} /> : <Play size={13} />}
                {sceneMode ? t("生成方案", "Draft plan") : t("运行", "Run")}
              </button>
            </div>
          </div>
          <p className={`industrial-agent-risk-line${planMode ? " is-plan" : ""}`} role="status">
            {planMode ? <ClipboardList size={13} aria-hidden="true" /> : <ShieldCheck size={13} aria-hidden="true" />}
            {sceneMode
              ? (planMode
                ? t("只出计划：生成场景改动与差异预览，不改动场景；确认后才应用。", "Plan only: drafts the scene diff without touching the scene; applies only after you confirm.")
                : executionMode === "autonomous"
                  ? t("自主执行：自动应用并以截图/状态自检，未达成时在轮次上限内自动修正；含不可撤销操作仍需确认。", "Autonomous: applies, self-checks against screenshot and state, auto-corrects within the round limit; irreversible actions still need confirmation.")
                  : t("逐次确认：每一轮改动应用前先审阅差异，整批原子应用、可一键撤销。", "Confirm each: review the diff before every round; applied atomically and undoable in one step."))
              : planMode
              ? t("只出计划：仅保留读取与分析工具，仿真、写入与控制调用会被拒绝并记录审计。", "Plan only: read and analyze tools only; simulate, write and control calls are rejected and audited.")
              : executionMode === "autonomous" && preview.highRiskCount
                ? t(`${preview.highRiskCount} 项高风险能力在授权内自动执行（可随时取消，审计与验证不变）`, `${preview.highRiskCount} high-risk capabilities auto-execute within authorization (cancellable; audit and verification unchanged)`)
                : preview.highRiskCount
                  ? t(`${preview.highRiskCount} 项高风险能力仅在用户逐次确认后执行`, `${preview.highRiskCount} high-risk capabilities require per-action confirmation`)
                  : t("当前能力不会直接写入或控制现场", "Selected capabilities do not write to or control the site")}
          </p>
          {!objective.trim() && !sceneMode && (
            <AgentObjectiveExamplesRow locale={locale} tools={tools} busy={busy} loading={loadingTools}
              hasProject={Boolean(projectId)} canSample={tools.some(tool => tool.effect === "read" && !tool.requiresApproval)}
              onSample={() => void start(true)} onPick={(item) => setObjective(item)} />
          )}
          {!sceneMode && <AgentCapabilityPreview
            locale={locale}
            tools={tools}
            selectedToolIds={selectedToolIds}
            loading={loadingTools}
            onToggle={(id) => setSelectedToolIds((current) => {
              const next = new Set(current);
              if (next.has(id)) next.delete(id); else next.add(id);
              return next;
            })}
          />}
          {/* H-autonomy 要素④：通用开发发现面（服务端开关开启才可见；切换重取工具面）。 */}
          {generalAvailable && !sceneMode && (
            <button type="button" className="ai-plan-chip industrial-agent-discovery" aria-pressed={discovery === "general"} disabled={loadingTools}
              title={t("按授权发现全部已注册能力（策划环之外仍受授权与拒绝清单收口）。", "Discover all registered capabilities by authorization; still bounded by scope and deny list.")}
              onClick={() => void changeDiscovery(discovery === "general" ? "curated" : "general")}>
              <Workflow size={13} aria-hidden="true" />
              {t("发现全部已注册能力", "Discover all registered")}
            </button>
          )}
        </div>
      ) : (
        <IndustrialAgentRunView
          locale={locale}
          checkpoint={checkpoint}
          tools={tools}
          busy={busy}
          restored={restored}
          {...(projectId ? { projectId } : {})}
          {...(error ? { error } : {})}
          {...(crossProject ? { crossProject } : {})}
          {...(crossProject ? { onDismissCrossProject: () => setCrossProject(undefined) } : {})}
          onAction={(action) => void act(action)}
          onSelect={(id) => void act("resume", id)}
          onNew={() => {
            setCheckpoint(undefined);
            setRestored(false);
            setError(undefined);
            setCrossProject(undefined);
            setObjective("");
          }}
        />
      )}
      {!checkpoint && recoveryFailure && (
        <AgentRecoveryFailureNotice
          locale={locale}
          runId={recoveryFailure.runId}
          notFound={recoveryFailure.notFound}
          {...(recoveryFailure.message ? { message: recoveryFailure.message } : {})}
          busy={busy}
          onRetry={() => void retryRecovery(recoveryFailure.runId)}
          onDismiss={() => setRecoveryFailure(undefined)}
          onClear={() => {
            if (projectId) {
              try { browserRunHistoryStore().forget(projectId, recoveryFailure.runId); } catch { /* 清除失败保留记录，仅关闭提示。 */ }
            }
            setRecoveryFailure(undefined);
          }}
        />
      )}
      {!checkpoint && error && <div className="industrial-agent-error" role="alert"><AlertTriangle size={14} />{error}</div>}
      {!projectId && <div className="industrial-agent-error" role="alert"><AlertTriangle size={14} />{t("请先选择项目，再运行工业任务", "Select a project before running an industrial task")}</div>}
    </section>
  );
}

function AgentCapabilityPreview(props: {
  locale: AppLocale;
  tools: readonly AgentToolDefinition[];
  selectedToolIds: ReadonlySet<string>;
  loading: boolean;
  onToggle: (id: string) => void;
}) {
  const t = (zh: string, en: string) => tr(props.locale, zh, en);
  const preview = selectedToolPreview(props.tools, props.selectedToolIds);
  return (
    <details className="industrial-agent-capabilities">
      <summary>
        <span><CircleGauge size={14} /><strong>{t("能力、风险与证据预览", "Capabilities, risk and evidence")}</strong></span>
        <span>{props.loading ? t("读取中", "Loading") : t(`${preview.selected.length} 项能力`, `${preview.selected.length} capabilities`)}<ChevronDown size={13} /></span>
      </summary>
      <div>
        <p><FileCheck2 size={13} />{t("结论必须引用能力返回的证据；写入与控制还必须返回执行后验证。", "Conclusions must cite capability evidence; writes and controls also require post-action verification.")}</p>
        <ul>
          {props.tools.map((tool) => (
            <li key={tool.id}>
              <label>
                <input type="checkbox" checked={props.selectedToolIds.has(tool.id)} onChange={() => props.onToggle(tool.id)} />
                <span><strong>{tool.label}</strong><small>{tool.description}</small></span>
              </label>
              <em className={tool.requiresApproval ? "high" : tool.effect}>{describeAgentEffect(tool.effect, props.locale)}{tool.requiresApproval ? ` · ${t("需确认", "Confirmation")}` : ""}</em>
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}

export function IndustrialAgentRunView(props: {
  locale: AppLocale;
  checkpoint: AgentCheckpoint;
  tools: readonly AgentToolDefinition[];
  busy: boolean;
  restored?: boolean;
  /** H-C3：档案动作位作用域；缺省时结论卡片不渲染"查看档案"。 */
  projectId?: string;
  error?: string;
  /** K11：收到的更新属于其他项目时显式标注（不静默丢弃）。 */
  crossProject?: { runId: string; projectId: string };
  onDismissCrossProject?: () => void;
  onAction: (action: "approve" | "resume" | "cancel" | "refresh") => void;
  onNew: () => void;
  onSelect?: (id: string) => void;
}) {
  const { checkpoint } = props;
  const t = (zh: string, en: string) => tr(props.locale, zh, en);
  const statusTone = agentStatusTone(checkpoint.status);
  const pendingTool = props.tools.find((tool) => tool.id === checkpoint.pendingTool?.call.toolId);
  const evidence = agentEvidenceViews(checkpoint, props.tools);
  const verdicts = agentVerdictEnvelopes(checkpoint);
  // H-C2：保安拒绝（语义预检/熔断）以 M6 气泡呈现；熔断计数取自 checkpoint 状态。
  const denials = agentGuardDenials(checkpoint);
  const circuit = agentGuardCircuit(checkpoint);
  const terminal = isAgentTerminal(checkpoint.status);
  return (
    <div className="industrial-agent-run">
      <header className={`industrial-agent-status ${statusTone}`} aria-live="polite">
        <span>{statusTone === "success" ? <CheckCircle2 size={17} /> : statusTone === "danger" ? <Ban size={17} /> : <LoaderCircle className={checkpoint.status === "running" ? "spin" : ""} size={17} />}</span>
        <div><strong>{agentStatusLabel(checkpoint.status, props.locale)}</strong><small>{checkpoint.objective}{checkpoint.planMode ? ` · ${t("计划模式", "Plan mode")}` : ""}{isAutonomousRun(checkpoint) ? ` · ${t("自主执行", "Autonomous")}` : ""}</small></div>
        <em>{agentProgress(checkpoint)}%</em>
      </header>
      <div className="industrial-agent-progress"><i style={{ width: `${agentProgress(checkpoint)}%` }} /></div>
      {/* K14 面板常驻：运行中同样可见记忆与档案（start 视图同款折叠行，默认收起不抢进度视觉）。 */}
      {props.projectId && <div className="industrial-agent-context">
        <AiMemoryPanel locale={props.locale} projectId={props.projectId} />
        <AiProvenancePanel locale={props.locale} projectId={props.projectId} />
      </div>}
      <dl className="industrial-agent-metrics">
        <div><dt>{t("决策步骤", "Steps")}</dt><dd>{checkpoint.usage.steps} / {checkpoint.budget.maxSteps}</dd></div>
        <div><dt>{t("工具调用", "Tool calls")}</dt><dd>{checkpoint.usage.toolCalls} / {checkpoint.budget.maxToolCalls}</dd></div>
        <div><dt>{t("证据", "Evidence")}</dt><dd>{evidence.length}</dd></div>
      </dl>
      {props.restored && <p className="industrial-agent-notice"><RefreshCw size={12} />{isStaleCheckpoint(checkpoint) ? t("已恢复上次检查点；距最后更新已超过 48 小时，状态可能陈旧。", "Restored the last checkpoint; it has not been updated for over 48h and may be stale.") : t("已恢复上次检查点，未重复执行已完成的调用。", "Restored the last checkpoint without replaying completed calls.")}</p>}
      {props.crossProject && props.onDismissCrossProject && (
        <AgentCrossProjectNotice locale={props.locale} runId={props.crossProject.runId} projectId={props.crossProject.projectId} onDismiss={props.onDismissCrossProject} />
      )}
      {checkpoint.status === "awaiting-approval" && checkpoint.pendingTool && (
        <section className="industrial-agent-approval" aria-label={t("待确认操作", "Action awaiting confirmation")}>
          <header><ShieldCheck size={15} /><span><strong>{t("执行前需要你确认", "Confirmation required before execution")}</strong><small>{pendingTool?.label ?? checkpoint.pendingTool.call.toolId}</small></span></header>
          <dl>
            <div><dt>{t("影响类型", "Effect")}</dt><dd>{pendingTool ? describeAgentEffect(pendingTool.effect, props.locale) : checkpoint.pendingTool.effect}</dd></div>
            <div><dt>{t("作用范围", "Scope")}</dt><dd>{checkpoint.pendingTool.call.resources.map((item) => `${item.kind}:${item.id}`).join(" · ")}</dd></div>
            <div><dt>{t("验证要求", "Verification")}</dt><dd>{t("完成后必须返回独立验证证据，否则自动判定失败", "Independent post-action evidence is mandatory; otherwise the run fails")}</dd></div>
          </dl>
          <details><summary>{t("查看精确参数", "Review exact arguments")}<ChevronDown size={12} /></summary><pre>{JSON.stringify(checkpoint.pendingTool.call.arguments, null, 2)}</pre></details>
          <div><button type="button" disabled={props.busy} onClick={() => props.onAction("cancel")}><PauseCircle size={13} />{t("取消任务", "Cancel")}</button><button className="primary" type="button" disabled={props.busy} onClick={() => props.onAction("approve")}><Check size={13} />{t("确认并继续", "Confirm and continue")}</button></div>
        </section>
      )}
      {checkpoint.completion && (
        <section className="industrial-agent-result">
          <header><Sparkles size={15} /><span><strong>{t("证据结论", "Evidence-backed result")}</strong><small>{agentDecisionStatusLabel(checkpoint.completion.decisionStatus, props.locale)}</small></span></header>
          <p>{checkpoint.completion.summary}</p>
        </section>
      )}
      {verdicts.length > 0 && <div className="industrial-agent-verdicts">
        {verdicts.map((item) => <AiHypothesisVerdictCard key={item.envelope.proposalFingerprint + item.envelope.resultFingerprint} locale={props.locale} envelope={item.envelope} {...(props.projectId ? { projectId: props.projectId } : {})} />)}
      </div>}
      {denials.length > 0 && <div className="industrial-agent-denials">
        {denials.map((item) => <AiHarnessDenialCard
          key={`${item.step}-${item.code}`}
          locale={props.locale}
          denial={item}
          {...(item.code === "variant-circuit-open" && circuit ? { circuitDenials: circuit.denials } : {})}
          {...(!terminal && item.code !== "variant-circuit-open" ? { onRecover: () => props.onAction("refresh") } : {})}
        />)}
      </div>}
      {/* 熔断终止由上方 M6 拒绝卡呈现（计数+恢复动作），不重复渲染通用错误条。 */}
      {checkpoint.failure && checkpoint.failure.code !== "variant-circuit-open" && <div className="industrial-agent-error" role="alert"><AlertTriangle size={14} /><span><strong>{checkpoint.failure.message}</strong><small>{checkpoint.failure.code}</small></span></div>}
      <IndustrialAgentContinuation locale={props.locale} checkpoint={checkpoint} busy={props.busy} onResume={() => props.onAction("resume")} {...(props.onSelect ? { onSelect: props.onSelect } : {})} />
      {props.error && <div className="industrial-agent-error" role="alert"><AlertTriangle size={14} />{props.error}</div>}
      {evidence.length > 0 && (
        <details className="industrial-agent-evidence" open={checkpoint.status === "completed"}>
          <summary><span><FileCheck2 size={14} /><strong>{t("证据与验证结果", "Evidence and verification")}</strong></span><span>{evidence.length}<ChevronDown size={13} /></span></summary>
          <ul>{evidence.map((item) => <li key={item.id}><span>{item.verified ? <CheckCircle2 size={13} /> : <FileCheck2 size={13} />}<b>{item.label}</b></span><small>{item.toolLabel} · {item.source}</small>{item.fingerprint && <code>{item.fingerprint}</code>}</li>)}</ul>
        </details>
      )}
      <details className="industrial-agent-history">
        <summary>{t("查看决策与工具记录", "Decision and tool history")}<span>{checkpoint.decisions.length + checkpoint.toolRecords.length}<ChevronDown size={13} /></span></summary>
        <ol>{checkpoint.decisions.map((record) => <li key={`decision-${record.step}`}><b>{record.step}</b><span>{record.decision.rationale}{record.execution && <AiExecutionDetails locale={props.locale} execution={record.execution} />}</span></li>)}</ol>
        {/* H-autonomy 要素③：审批来源随工具记录可见（策略签发 vs 人工确认），审计不只在服务端。 */}
        {checkpoint.toolRecords.length > 0 && <ul className="industrial-agent-tool-audit">
          {checkpoint.toolRecords.map((record) => <li key={`tool-${record.step}-${record.fingerprint}`}>
            <b>{record.step}</b>
            <span>{record.call.toolId}<small> · {record.outcome.status === "completed"
              ? t("已完成", "Completed")
              : record.outcome.status === "failed" ? t("失败", "Failed") : t("已阻断", "Blocked")}</small></span>
            <em>{record.approval
              ? (record.approval.approvedBy === AUTONOMY_APPROVER_ID
                ? describeApprovalSource(record.approval.approvedBy, props.locale)
                : `${t("人工确认", "Manually approved")} · ${record.approval.approvedBy}`)
              : t("无需确认", "No confirmation required")}</em>
          </li>)}
        </ul>}
      </details>
      <footer className="industrial-agent-run-actions">
        {!terminal && checkpoint.status !== "awaiting-approval" && <><button type="button" disabled={props.busy} onClick={() => props.onAction("refresh")}><RefreshCw size={13} />{t("刷新", "Refresh")}</button>{checkpoint.status !== "awaiting-input" && <button type="button" disabled={props.busy} onClick={() => props.onAction("resume")}><Play size={13} />{t("从检查点继续", "Resume checkpoint")}</button>}<button type="button" disabled={props.busy} onClick={() => props.onAction("cancel")}><PauseCircle size={13} />{t("取消", "Cancel")}</button></>}
        {terminal && <>{checkpoint.failure && <button type="button" disabled={props.busy} onClick={() => props.onAction("refresh")}><RefreshCw size={13} />{t("刷新", "Refresh")}</button>}<button className="primary" type="button" disabled={props.busy} onClick={props.onNew}><Sparkles size={13} />{t("开始新任务", "New task")}</button></>}
      </footer>
    </div>
  );
}

type IndustrialAgentApi = typeof import("../api")["api"];

/**
 * T11（审计 §二 T11）：目标示例随工具目录生成（agentObjectiveExamples），目录加载失败
 * 时回落通用目标而不是禁用态死角；样例按钮无可运行只读能力时给出可见原因，不再只有 title 提示。
 */
export function AgentObjectiveExamplesRow(props: {
  locale: AppLocale;
  tools: readonly AgentToolDefinition[];
  busy: boolean;
  loading: boolean;
  hasProject: boolean;
  canSample: boolean;
  onSample: () => void;
  onPick: (objective: string) => void;
}) {
  const t = (zh: string, en: string) => tr(props.locale, zh, en);
  const { examples, source } = agentObjectiveExamples(props.tools, props.locale);
  return (
    <div className="industrial-agent-examples" aria-label={t("目标示例", "Objective examples")}>
      <button type="button" disabled={props.busy || props.loading || !props.hasProject || !props.canSample}
        title={t("使用当前配置的模型执行只读任务；需要大模型配置和可读能力。", "Run a read-only task with the configured model; requires model configuration and read capabilities.")}
        onClick={props.onSample}><Play size={13} />{t("一键运行样例", "Run sample")}</button>
      {examples.map((item) => (
        <button key={item} type="button" title={source === "fallback" ? t("来自通用只读模板；能力目录可用后会给出匹配当前能力的示例。", "From the generic read-only template; examples match your capabilities once the catalog loads.") : item}
          onClick={() => props.onPick(item)}>{item}</button>
      ))}
      {!props.loading && props.hasProject && !props.canSample && (
        <small role="status">{t("当前没有可直接运行的只读能力：样例已禁用；能力目录加载失败时请检查服务连接后重试。", "No directly runnable read-only capability: the sample is disabled; if the catalog failed to load, check the service connection and retry.")}</small>
      )}
    </div>
  );
}

async function getAgentApi(): Promise<IndustrialAgentApi> {
  return (await import("../api")).api;
}

/** K13：把检查点写进滚动历史（最近 10 条；旧单槽键由 store 内部迁移兜底）。 */
function rememberCheckpoint(projectId: string, checkpoint: AgentCheckpoint) {
  try {
    browserRunHistoryStore().remember(projectId, {
      runId: checkpoint.id,
      objective: checkpoint.objective,
      savedAt: new Date().toISOString(),
      status: checkpoint.status,
    });
  } catch { /* 历史记忆不可用时放弃，当前会话不受影响。 */ }
}

function latestRememberedRunId(projectId: string): string | undefined {
  try { return browserRunHistoryStore().list(projectId)[0]?.runId; } catch { return undefined; }
}

/** 404（运行已被服务端清理）与网络/服务故障在恢复提示里分开表述。 */
function isNotFound(reason: unknown): boolean {
  return reason instanceof ServerRequestError && reason.status === 404;
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
