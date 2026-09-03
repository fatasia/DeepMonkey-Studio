import type { IndustrialValidationStudyRecord, SceneSnapshot, WorkcellAuditInput, WorkcellAuditResult } from "@bim-studio/contracts";
import { AlertTriangle, Bot, CheckCircle2, Crosshair, LoaderCircle, ScanSearch } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type CapabilityInvocationResult } from "../api";
import { starterWorkcellScenePlanningParameters, workcellAuditInputFromScene } from "./workcellAuditModel";
import { buildWorkcellAuditStudyInput, matchingWorkcellStudy } from "./workcellAuditStudy";
import { WorkcellErgonomicsEvidence } from "./WorkcellErgonomicsEvidence";
import { WorkcellErgonomicsSetup } from "./WorkcellErgonomicsSetup";
import { WorkcellTrajectoryEvidence } from "./WorkcellTrajectoryEvidence";
import { WorkcellLoadEvidence } from "./WorkcellLoadEvidence";
import { WorkcellPlanningSetup } from "./WorkcellPlanningSetup";
import "./WorkcellAuditPanel.css";

export function WorkcellAuditPanel({ projectId, scene, study, onStudyChange, onAuditComplete, onContinueValidation, onOpenTarget }: {
  projectId: string;
  scene: SceneSnapshot;
  study?: IndustrialValidationStudyRecord;
  onStudyChange?: (study: IndustrialValidationStudyRecord) => void;
  onAuditComplete?: (result: WorkcellAuditResult) => void;
  onContinueValidation?: (result: WorkcellAuditResult) => void;
  onOpenTarget: (sceneId: string, objectId: string) => void;
}) {
  const [invocation, setInvocation] = useState<CapabilityInvocationResult<WorkcellAuditResult>>();
  const [evidenceInput, setEvidenceInput] = useState<WorkcellAuditInput>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const runSequence = useRef(0);
  const result = invocation?.output;
  const [planningParameters, setPlanningParameters] = useState(starterWorkcellScenePlanningParameters);
  const baseAuditInput = useMemo(
    () => workcellAuditInputFromScene(scene, planningParameters),
    [planningParameters, scene],
  );
  const [ergonomicsProfiles, setErgonomicsProfiles] = useState(() => structuredClone(baseAuditInput.ergonomicsProfiles ?? []));
  const auditInput = useMemo(() => {
    const next = structuredClone(baseAuditInput);
    if (ergonomicsProfiles.length) next.ergonomicsProfiles = structuredClone(ergonomicsProfiles);
    else delete next.ergonomicsProfiles;
    return next;
  }, [baseAuditInput, ergonomicsProfiles]);
  const hasObjects = auditInput.objects.length > 0;
  const currentStudy = matchingWorkcellStudy(study, scene.id);
  // 自动识别只负责预建档案；人员对象必须由用户显式确认，因此选择器展示全部场景对象。
  const operatorOptions = baseAuditInput.objects;

  useEffect(() => {
    runSequence.current += 1;
    setInvocation(undefined);
    setEvidenceInput(undefined);
    setBusy(false);
    setError("");
    setPlanningParameters(starterWorkcellScenePlanningParameters());
    setErgonomicsProfiles(structuredClone(baseAuditInput.ergonomicsProfiles ?? []));
  }, [scene.id, scene.updatedAt]);

  function updatePlanningParameters(next: typeof planningParameters) {
    runSequence.current += 1;
    setPlanningParameters(next);
    setInvocation(undefined);
    setEvidenceInput(undefined);
    setBusy(false);
    setError("");
  }

  function updateErgonomicsProfiles(next: typeof ergonomicsProfiles) {
    runSequence.current += 1;
    setErgonomicsProfiles(next);
    setInvocation(undefined);
    setEvidenceInput(undefined);
    setBusy(false);
    setError("");
  }

  async function audit() {
    const runId = ++runSequence.current;
    setBusy(true);
    setError("");
    try {
      if (!hasObjects) throw new Error("当前场景没有可检查的模型、组件或目标点");
      if (auditInput.planningAssumptions?.status !== "engineer-confirmed") throw new Error("请先确认本次安全间隙与候选轨迹规划基准");
      const scenarioInput = structuredClone(auditInput);
      const response = await api.invokeCapability<WorkcellAuditResult>(projectId, "manufacturing.workcell.audit", scenarioInput);
      if (runId !== runSequence.current) return;
      if (!response.output) throw new Error(response.error?.message ?? "工位体检没有返回确定性结果");
      setInvocation(response);
      setEvidenceInput(scenarioInput);
      const saved = await api.saveValidationStudy(
        projectId,
        buildWorkcellAuditStudyInput({
          scene,
          result: response.output,
          scenarioInput,
          ...(currentStudy ? { existing: currentStudy } : {}),
        }),
      );
      if (runId !== runSequence.current) return;
      onStudyChange?.(saved);
      onAuditComplete?.(response.output);
    } catch (reason) {
      if (runId === runSequence.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (runId === runSequence.current) setBusy(false);
    }
  }

  return <section className={`workcell-audit-panel ${result?.status ?? "idle"}`}>
    <header>
      <div><span><Bot size={14} />阶段 1 · 快速验证</span><strong>检查当前工位</strong><small>从现有模型和任务中检查可定位的阻断项，结果直接关联场景对象并保存证据。</small></div>
      <button
        type="button"
        disabled={busy || !hasObjects || planningParameters.status !== "engineer-confirmed"}
        title={planningParameters.status !== "engineer-confirmed" ? "先检查并确认本次规划基准" : undefined}
        onClick={() => void audit()}
      >{busy ? <LoaderCircle className="spin" size={14} /> : <ScanSearch size={14} />}{busy ? "正在验证" : result ? "重新验证" : "运行快速验证"}</button>
    </header>
    {!hasObjects && <p className="workcell-audit-empty">导入设备或创建对象后，即可运行工位快速验证。</p>}
    {hasObjects && <WorkcellPlanningSetup
      value={planningParameters}
      trajectoryCount={baseAuditInput.trajectories?.length ?? 0}
      resultVisible={Boolean(result)}
      disabled={busy}
      onChange={updatePlanningParameters}
    />}
    <WorkcellErgonomicsSetup
      profiles={ergonomicsProfiles}
      operatorOptions={operatorOptions}
      objects={baseAuditInput.objects}
      resultVisible={Boolean(result)}
      disabled={busy}
      onChange={updateErgonomicsProfiles}
    />
    {error && <p className="workcell-audit-error"><AlertTriangle size={13} />{error}</p>}
    {!result && currentStudy?.latestResult && <div className={`workcell-audit-previous ${currentStudy.latestResult.status}`}>
      <span><strong>上次快速验证已留证 · v{currentStudy.revision}</strong><small>{formatCompletedAt(currentStudy.latestResult.completedAt)}</small></span>
      <em>{currentStudy.latestResult.status === "passed" ? "通过" : `${currentStudy.latestResult.failureCount} 项待处理`}</em>
      <code title={currentStudy.latestResult.evidenceFingerprint}>{currentStudy.latestResult.evidenceFingerprint}</code>
    </div>}
    {result && <div className="workcell-audit-result">
      <div className="workcell-audit-summary">
        {result.status === "passed" ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}
        <span><strong>{statusLabel(result.status)}</strong><small>{result.summary}</small></span>
        <em>证据覆盖 {(result.evidenceCoverage * 100).toFixed(0)}%</em>
      </div>
      <div className="workcell-audit-metrics">
        <span><b>{result.inventory.robot}</b>机器人</span><span><b>{result.inventory.tool}</b>工具</span><span><b>{result.collisionPairs.length}</b>空间关系</span><span><b>{result.reachability.length}</b>可达目标</span><span><b>{result.loadChecks.length}</b>负载筛查</span><span><b>{result.ergonomicsChecks?.length ?? 0}</b>人工作业</span><span><b>{result.trajectoryAnalysis?.segmentChecks.length ?? 0}</b>轨迹段</span>
      </div>
      {result.planningEvidence && <div className={`workcell-audit-planning-evidence ${result.planningEvidence.status}`}>
        <strong>{result.planningEvidence.status === "confirmed" ? "规划基准已留证" : "规划基准证据不足"}</strong>
        <span>
          {result.planningEvidence.clearanceThresholdMeters === undefined ? "间隙待声明" : `间隙 ${formatNumber(result.planningEvidence.clearanceThresholdMeters)} m`}
          {result.planningEvidence.generatedTrajectorySpeedMps !== undefined ? ` · 候选速度 ${formatNumber(result.planningEvidence.generatedTrajectorySpeedMps)} m/s` : ""}
          {result.planningEvidence.generatedTrajectoryTcpRadiusMeters !== undefined ? ` · TCP 半径 ${formatNumber(result.planningEvidence.generatedTrajectoryTcpRadiusMeters)} m` : ""}
        </span>
        <small>{result.planningEvidence.declaration}</small>
      </div>}
      <p className="workcell-audit-scope">快速验证覆盖机器人规划、空间广相位，以及人工作业的可达、工作高度、前伸和搬运策略阈值；不包含完整 IK、网格级连续碰撞、动力学、真实控制器时序或完整人体工效认证。</p>
      <WorkcellLoadEvidence checks={result.loadChecks} />
      <WorkcellErgonomicsEvidence checks={result.ergonomicsChecks ?? []} onOpenObject={(objectId) => onOpenTarget(scene.id, objectId)} />
      {result.trajectoryAnalysis && <WorkcellTrajectoryEvidence
        analysis={result.trajectoryAnalysis}
        trajectories={evidenceInput?.trajectories ?? []}
        onOpenObject={(objectId) => onOpenTarget(scene.id, objectId)}
      />}
      {result.findings.length > 0 && <div className="workcell-audit-findings">{result.findings.slice(0, 6).map((finding) => <button type="button" key={finding.id} className={finding.severity} disabled={!finding.objectIds[0]} onClick={() => finding.objectIds[0] && onOpenTarget(scene.id, finding.objectIds[0])}>
        <Crosshair size={12} /><span><strong>{finding.title}</strong><small>{finding.detail}</small></span>
      </button>)}</div>}
      <code title={result.evidenceFingerprint}>{result.evidenceFingerprint}</code>
    </div>}
    {result && result.status !== "passed" && onContinueValidation && <footer className="workcell-audit-actions">
      <p>先定位并修正阻断项；控制逻辑可独立验证，未完成的几何检查不会被标记为通过。</p>
      <button type="button" onClick={() => onContinueValidation(result)}>仍验证控制逻辑</button>
    </footer>}
  </section>;
}

function statusLabel(status: WorkcellAuditResult["status"]): string {
  return ({ passed: "快速验证未发现阻断项", warning: "快速验证存在待确认项", failed: "快速验证发现阻断项", "needs-data": "快速验证证据不足" })[status];
}

function formatCompletedAt(value: string): string {
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? value : timestamp.toLocaleString("zh-CN", { hour12: false });
}

function formatNumber(value: number): string {
  return Number(value.toFixed(3)).toLocaleString("zh-CN");
}
