import { useEffect, useMemo, useRef, useState } from "react";
import { AiExecutionDetails } from "./AiExecutionDetails";
import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleGauge,
  FileCheck2,
  LoaderCircle,
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
  agentProgress,
  agentStatusLabel,
  agentStatusTone,
  describeAgentEffect,
  isAgentTerminal,
  selectedToolPreview,
} from "../ai/industrialAgentViewModel";
import "./IndustrialAgentWorkspace.css";
import { IndustrialAgentContinuation } from "./IndustrialAgentContinuation";
import { AssistantModelControls, type AssistantSessionOptions } from "./AssistantModelControls";

const DEFAULT_BUDGET = { maxSteps: 10, maxToolCalls: 6, maxDurationMs: 90_000 };

export function IndustrialAgentWorkspace(props: {
  locale: AppLocale;
  projectId?: string;
  context: unknown;
  surface?: "assistant" | "script";
  onBack?: () => void;
}) {
  const { locale, projectId, context, surface = "assistant" } = props;
  const [objective, setObjective] = useState("");
  const [modelOptions, setModelOptions] = useState<AssistantSessionOptions>({});
  const [tools, setTools] = useState<AgentToolDefinition[]>([]);
  const [selectedToolIds, setSelectedToolIds] = useState<Set<string>>(new Set());
  const [checkpoint, setCheckpoint] = useState<AgentCheckpoint>();
  const [loadingTools, setLoadingTools] = useState(Boolean(projectId));
  const [busy, setBusy] = useState(false);
  const [restored, setRestored] = useState(false);
  const [error, setError] = useState<string>();
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

  useEffect(() => {
    setCheckpoint(undefined);
    setObjective("");
    setBusy(false);
    setTools([]);
    setSelectedToolIds(new Set());
    setRestored(false);
    setError(undefined);
    if (!projectId) {
      setTools([]);
      setSelectedToolIds(new Set());
      setLoadingTools(false);
      return;
    }
    const controller = new AbortController();
    setLoadingTools(true);
    void getAgentApi().then(async (client) => {
      const [catalogResult, recoveryResult] = await Promise.allSettled([
        client.listIndustrialAgentTools(projectId, controller.signal),
        restoreRun(client, projectId, controller.signal),
      ]);
      if (controller.signal.aborted) return;
      if (catalogResult.status === "rejected") throw catalogResult.reason;
      setTools(catalogResult.value.tools);
      setSelectedToolIds(new Set(catalogResult.value.tools.map((tool) => tool.id)));
      if (recoveryResult.status === "fulfilled" && recoveryResult.value) {
        setCheckpoint(recoveryResult.value);
        setObjective(recoveryResult.value.objective);
        setRestored(true);
      } else if (recoveryResult.status === "rejected" && !controller.signal.aborted) {
        // 旧 checkpoint 不可达时仍允许创建新任务，网络恢复后也可再次打开面板重试。
        setError(t("上次运行暂时无法恢复，你仍可开始新任务", "The previous run is temporarily unavailable; you can still start a new task"));
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
    const controller = new AbortController();
    let refreshing = false;
    const timer = window.setInterval(() => {
      if (refreshing) return;
      refreshing = true;
      void getAgentApi().then((client) => controller.signal.aborted ? undefined : client.getIndustrialAgentRun(projectId, checkpoint.id, controller.signal))
        .then((next) => { if (next && !controller.signal.aborted) updateCheckpoint(next); })
        .catch((reason) => {
          if (!controller.signal.aborted) setError(errorMessage(reason));
        }).finally(() => { refreshing = false; });
    }, 1_200);
    return () => {
      window.clearInterval(timer);
      controller.abort();
    };
  }, [busy, checkpoint?.id, checkpoint?.status, projectId]);

  function updateCheckpoint(next: AgentCheckpoint) {
    if (next.projectId !== projectId) return;
    setCheckpoint((current) => current?.id === next.id && current.revision > next.revision ? current : next);
    setError(undefined);
    if (projectId) rememberRun(projectId, next.id);
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
        budget: DEFAULT_BUDGET,
      });
      // 后台任务不因切页重放；只在所属项目记住 ID，界面更新仍要求当前请求所有权。
      if (next.projectId === projectId) rememberRun(projectId, next.id);
      if (isCurrent()) updateCheckpoint(next);
    } catch (reason) {
      if (isCurrent()) setError(errorMessage(reason));
    } finally {
      if (isCurrent()) { actionPending.current = false; setBusy(false); }
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
      <header className="industrial-agent-heading">
        <span><Workflow size={17} /></span>
        <div>
          <strong>{t("工业任务 Agent", "Industrial task agent")}</strong>
          <small>{t("有边界、有确认、有证据的受控执行", "Bounded, confirmed and evidence-backed execution")}</small>
        </div>
        {props.onBack && <button type="button" onClick={props.onBack}><ArrowLeft size={13} />{t("返回脚本", "Back to script")}</button>}
      </header>

      {!checkpoint ? (
        <div className="industrial-agent-start">
          <AssistantModelControls locale={locale} mode="platform" value={modelOptions} onChange={setModelOptions} disabled={busy} />
          <label>
            <span>{t("用一句话说明要完成的目标", "Describe the outcome in one sentence")}</span>
            <textarea
              value={objective}
              onChange={(event) => setObjective(event.target.value)}
              placeholder={t("例如：检查当前产线的设备风险，给出有证据的处理建议；涉及控制时先让我确认。", "Example: inspect line risks and return evidence-backed actions; ask before any control change.")}
            />
          </label>
          <div className="industrial-agent-examples" aria-label={t("目标示例", "Objective examples")}>
            <button type="button" disabled={busy || loadingTools || !projectId || !tools.some(tool => tool.effect === "read" && !tool.requiresApproval)} title={t("使用当前配置的模型执行只读任务；需要大模型配置和可读能力。", "Run a read-only task with the configured model; requires model configuration and read capabilities.")} onClick={() => void start(true)}><Play size={13} />{t("一键运行样例", "Run sample")}</button>
            {[t("检查设备异常并定位可能原因", "Inspect anomalies and locate likely causes"), t("先仿真验证，再给出调试建议", "Validate in simulation before proposing debugging actions")].map((item) => (
              <button key={item} type="button" onClick={() => setObjective(item)}>{item}</button>
            ))}
          </div>
          <AgentCapabilityPreview
            locale={locale}
            tools={tools}
            selectedToolIds={selectedToolIds}
            loading={loadingTools}
            onToggle={(id) => setSelectedToolIds((current) => {
              const next = new Set(current);
              if (next.has(id)) next.delete(id); else next.add(id);
              return next;
            })}
          />
          <div className="industrial-agent-start-actions">
            <span>
              <ShieldCheck size={13} />
              {preview.highRiskCount
                ? t(`${preview.highRiskCount} 项高风险能力仅在用户逐次确认后执行`, `${preview.highRiskCount} high-risk capabilities require per-action confirmation`)
                : t("当前能力不会直接写入或控制现场", "Selected capabilities do not write to or control the site")}
            </span>
            <button className="primary" type="button" disabled={busy || loadingTools || !projectId || !objective.trim() || selectedToolIds.size === 0} onClick={() => void start()}>
              {busy ? <LoaderCircle className="spin" size={14} /> : <Play size={14} />}
              {t("预览并运行", "Review and run")}
            </button>
          </div>
        </div>
      ) : (
        <IndustrialAgentRunView
          locale={locale}
          checkpoint={checkpoint}
          tools={tools}
          busy={busy}
          restored={restored}
          {...(error ? { error } : {})}
          onAction={(action) => void act(action)}
          onSelect={(id) => void act("resume", id)}
          onNew={() => {
            setCheckpoint(undefined);
            setRestored(false);
            setError(undefined);
            setObjective("");
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
  error?: string;
  onAction: (action: "approve" | "resume" | "cancel" | "refresh") => void;
  onNew: () => void;
  onSelect?: (id: string) => void;
}) {
  const { checkpoint } = props;
  const t = (zh: string, en: string) => tr(props.locale, zh, en);
  const statusTone = agentStatusTone(checkpoint.status);
  const pendingTool = props.tools.find((tool) => tool.id === checkpoint.pendingTool?.call.toolId);
  const evidence = agentEvidenceViews(checkpoint, props.tools);
  const terminal = isAgentTerminal(checkpoint.status);
  return (
    <div className="industrial-agent-run">
      <header className={`industrial-agent-status ${statusTone}`} aria-live="polite">
        <span>{statusTone === "success" ? <CheckCircle2 size={17} /> : statusTone === "danger" ? <Ban size={17} /> : <LoaderCircle className={checkpoint.status === "running" ? "spin" : ""} size={17} />}</span>
        <div><strong>{agentStatusLabel(checkpoint.status, props.locale)}</strong><small>{checkpoint.objective}</small></div>
        <em>{agentProgress(checkpoint)}%</em>
      </header>
      <div className="industrial-agent-progress"><i style={{ width: `${agentProgress(checkpoint)}%` }} /></div>
      <dl className="industrial-agent-metrics">
        <div><dt>{t("决策步骤", "Steps")}</dt><dd>{checkpoint.usage.steps} / {checkpoint.budget.maxSteps}</dd></div>
        <div><dt>{t("工具调用", "Tool calls")}</dt><dd>{checkpoint.usage.toolCalls} / {checkpoint.budget.maxToolCalls}</dd></div>
        <div><dt>{t("证据", "Evidence")}</dt><dd>{evidence.length}</dd></div>
      </dl>
      {props.restored && <p className="industrial-agent-notice"><RefreshCw size={12} />{t("已恢复上次检查点，未重复执行已完成的调用。", "Restored the last checkpoint without replaying completed calls.")}</p>}
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
      {checkpoint.failure && <div className="industrial-agent-error" role="alert"><AlertTriangle size={14} /><span><strong>{checkpoint.failure.message}</strong><small>{checkpoint.failure.code}</small></span></div>}
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
      </details>
      <footer className="industrial-agent-run-actions">
        {!terminal && checkpoint.status !== "awaiting-approval" && <><button type="button" disabled={props.busy} onClick={() => props.onAction("refresh")}><RefreshCw size={13} />{t("刷新", "Refresh")}</button>{checkpoint.status !== "awaiting-input" && <button type="button" disabled={props.busy} onClick={() => props.onAction("resume")}><Play size={13} />{t("从检查点继续", "Resume checkpoint")}</button>}<button type="button" disabled={props.busy} onClick={() => props.onAction("cancel")}><PauseCircle size={13} />{t("取消", "Cancel")}</button></>}
        {terminal && <>{checkpoint.failure && <button type="button" disabled={props.busy} onClick={() => props.onAction("refresh")}><RefreshCw size={13} />{t("刷新", "Refresh")}</button>}<button className="primary" type="button" disabled={props.busy} onClick={props.onNew}><Sparkles size={13} />{t("开始新任务", "New task")}</button></>}
      </footer>
    </div>
  );
}

type IndustrialAgentApi = typeof import("../api")["api"];

async function getAgentApi(): Promise<IndustrialAgentApi> {
  return (await import("../api")).api;
}

async function restoreRun(client: IndustrialAgentApi, projectId: string, signal: AbortSignal): Promise<AgentCheckpoint | undefined> {
  const runId = readRememberedRun(projectId);
  return runId ? client.getIndustrialAgentRun(projectId, runId, signal) : undefined;
}

function rememberRun(projectId: string, runId: string) {
  try { window.localStorage.setItem(`bim-studio:industrial-agent:${projectId}`, runId); } catch { /* 本地记忆不可用时仍可完成当前会话。 */ }
}

function readRememberedRun(projectId: string): string | undefined {
  try { return window.localStorage.getItem(`bim-studio:industrial-agent:${projectId}`) ?? undefined; } catch { return undefined; }
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
