import type { IndustrialValidationStudyRecord, SceneSnapshot, WorkcellAuditResult } from "@bim-studio/contracts";
import { AlertTriangle, Bot, CheckCircle2, Crosshair, LoaderCircle, ScanSearch } from "lucide-react";
import { useState } from "react";
import { api, type CapabilityInvocationResult } from "../api";
import { workcellAuditInputFromScene } from "./workcellAuditModel";
import { buildWorkcellAuditStudyInput, matchingWorkcellStudy } from "./workcellAuditStudy";
import { WorkcellTrajectoryEvidence } from "./WorkcellTrajectoryEvidence";
import "./WorkcellAuditPanel.css";

export function WorkcellAuditPanel({ projectId, scene, study, onStudyChange, onOpenTarget }: {
  projectId: string;
  scene: SceneSnapshot;
  study?: IndustrialValidationStudyRecord;
  onStudyChange?: (study: IndustrialValidationStudyRecord) => void;
  onOpenTarget: (sceneId: string, objectId: string) => void;
}) {
  const [invocation, setInvocation] = useState<CapabilityInvocationResult<WorkcellAuditResult>>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const result = invocation?.output;
  const auditInput = workcellAuditInputFromScene(scene);
  const hasObjects = auditInput.objects.length > 0;
  const currentStudy = matchingWorkcellStudy(study, scene.id);

  async function audit() {
    setBusy(true);
    setError("");
    try {
      if (!hasObjects) throw new Error("当前场景没有可检查的模型、组件或目标点");
      const response = await api.invokeCapability<WorkcellAuditResult>(projectId, "manufacturing.workcell.audit", auditInput);
      if (!response.output) throw new Error(response.error?.message ?? "工位体检没有返回确定性结果");
      setInvocation(response);
      const saved = await api.saveValidationStudy(
        projectId,
        buildWorkcellAuditStudyInput({
          scene,
          result: response.output,
          scenarioInput: auditInput,
          ...(currentStudy ? { existing: currentStudy } : {}),
        }),
      );
      onStudyChange?.(saved);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  return <section className={`workcell-audit-panel ${result?.status ?? "idle"}`}>
    <header>
      <div><span><Bot size={14} />AI 自动编排 · 确定性校验</span><strong>当前工位体检</strong><small>自动盘点空间关系；配置关节链和轨迹后，同步检查可达性、连续广相位与多机器人时段冲突。</small></div>
      <button disabled={busy || !hasObjects} onClick={() => void audit()}>{busy ? <LoaderCircle className="spin" size={14} /> : <ScanSearch size={14} />}{result ? "重新检查" : "一键检查工位"}</button>
    </header>
    {!hasObjects && <p className="workcell-audit-empty">导入设备或创建组件后，即可执行工位碰撞、间隙和机器人可达性体检。</p>}
    {error && <p className="workcell-audit-error"><AlertTriangle size={13} />{error}</p>}
    {!result && currentStudy?.latestResult && <div className={`workcell-audit-previous ${currentStudy.latestResult.status}`}>
      <span><strong>上次体检已留证 · v{currentStudy.revision}</strong><small>{formatCompletedAt(currentStudy.latestResult.completedAt)}</small></span>
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
        <span><b>{result.inventory.robot}</b>机器人</span><span><b>{result.inventory.tool}</b>工具</span><span><b>{result.collisionPairs.length}</b>空间关系</span><span><b>{result.reachability.length}</b>可达目标</span><span><b>{result.trajectoryAnalysis?.segmentChecks.length ?? 0}</b>轨迹段</span>
      </div>
      {result.trajectoryAnalysis && <WorkcellTrajectoryEvidence analysis={result.trajectoryAnalysis} />}
      {result.findings.length > 0 && <div className="workcell-audit-findings">{result.findings.slice(0, 6).map((finding) => <button key={finding.id} className={finding.severity} disabled={!finding.objectIds[0]} onClick={() => finding.objectIds[0] && onOpenTarget(scene.id, finding.objectIds[0])}>
        <Crosshair size={12} /><span><strong>{finding.title}</strong><small>{finding.detail}</small></span>
      </button>)}</div>}
      <code title={result.evidenceFingerprint}>{result.evidenceFingerprint}</code>
    </div>}
  </section>;
}

function statusLabel(status: WorkcellAuditResult["status"]): string {
  return ({ passed: "工位检查通过", warning: "存在待确认风险", failed: "发现确定失败项", "needs-data": "需要补充模型数据" })[status];
}

function formatCompletedAt(value: string): string {
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? value : timestamp.toLocaleString("zh-CN", { hour12: false });
}
