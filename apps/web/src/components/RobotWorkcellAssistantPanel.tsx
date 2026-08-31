import type { SceneSnapshot, Vector3Value, WorkcellAuditInput, WorkcellAuditResult, WorkcellBounds, WorkcellObjectRole } from "@bim-studio/contracts";
import {
  AlertTriangle, Bot, CheckCircle2, FlaskConical, Gauge, ListChecks,
  LoaderCircle, Play, Save, ScanSearch, ShieldCheck, Timer,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { runRobotWorkcellAssistant } from "./robotWorkcellAssistant";
import type {
  RobotAssistantObjectInput, RobotAssistantTargetInput, RobotTaskDraftStep,
  RobotWorkcellAssistantInput, RobotWorkcellAssistantResult,
} from "./robotWorkcellAssistantTypes";
import { primitiveWorldBounds, workcellRole } from "./workcellAuditModel";
import "./RobotWorkcellAssistantPanel.css";

export type RobotTaskDraft = RobotWorkcellAssistantResult["taskDraft"];
export type RobotAuditCapabilityRunner = (projectId: string, input: WorkcellAuditInput) => Promise<WorkcellAuditResult>;

interface PanelProps {
  projectId: string;
  scene: SceneSnapshot;
  runWorkcellAudit: RobotAuditCapabilityRunner;
  onSaveDraft: (draft: RobotTaskDraft) => void | Promise<void>;
  onOpenFormalSimulation: (draft: RobotTaskDraft) => void;
}

export interface RobotAssistantScenePreparation {
  input?: RobotWorkcellAssistantInput;
  issue?: string;
}

/**
 * 从已有场景配置生成机器人工位任务。只读取用户已配置的数据；模型缺少包围盒时保留缺证据状态。
 */
export function prepareRobotAssistantScene(scene: SceneSnapshot): RobotAssistantScenePreparation {
  const robotModel = scene.models.find((model) => model.rig?.robot?.enabled);
  const robot = robotModel?.rig?.robot;
  if (!robotModel || !robot) return { issue: "当前场景尚未启用机器人关节链" };

  const targetIds = [...new Set(robot.targetObjectIds?.filter(Boolean) ?? [])];
  const candidates = sceneObjects(scene);
  const missingTargetIds = targetIds.filter((id) => !candidates.some((item) => item.id === id));
  if (missingTargetIds.length) {
    return { issue: `机器人配置的目标在当前场景中不存在：${missingTargetIds.join("、")}` };
  }
  const targets = candidates
    .filter((item) => targetIds.length ? targetIds.includes(item.id) : item.role === "target")
    .map((item): RobotAssistantTargetInput => ({
      id: item.id, name: item.name, position: { ...item.position },
      ...(item.rotation ? { orientationEulerDeg: radiansToDegrees(item.rotation) } : {}),
    }));
  if (!targets.length) return { issue: targetIds.length ? "机器人配置的目标在当前场景中不存在" : "请为机器人配置目标对象或创建目标点" };

  const targetIdSet = new Set(targets.map((item) => item.id));
  const objects = candidates
    .filter((item) => item.id !== robotModel.modelId && !targetIdSet.has(item.id) && item.role !== "target")
    .map((item): RobotAssistantObjectInput => ({
      id: item.id, name: item.name, role: assistantObjectRole(item.role), position: { ...item.position },
      ...(item.bounds ? { bounds: item.bounds } : {}),
    }));
  const poseByBone = new Map(robotModel.rig?.bones.map((item) => [item.bonePath, item.rotation]) ?? []);
  const tool = candidates.find((item) => item.id === robot.toolObjectId);
  return {
    input: {
      sceneId: scene.id,
      taskName: `${robotModel.name} · 工位任务草稿`,
      robot: {
        id: robotModel.modelId, name: robotModel.name, baseBonePath: robot.baseBonePath,
        base: { ...robotModel.transform.position },
        currentTcpPosition: { ...(tool?.position ?? robotModel.transform.position) },
        joints: robot.joints.map((joint) => ({
          ...joint,
          ...(poseByBone.get(joint.bonePath)
            ? { currentAngleDeg: toDegrees(poseByBone.get(joint.bonePath)![joint.axis]) }
            : {}),
        })),
        ...(robot.toolObjectId ? { toolObjectId: robot.toolObjectId } : {}),
      },
      targets,
      objects,
      // 首版采用可解释的保守默认值；结果页明确这是规划预算，不是控制器承诺。
      cycleGoal: { targetSec: 30, tcpSpeedMps: .5, jointSpeedDegPerSec: 90, controllerOverheadSec: .2, toolActionSec: .5, safetyMarginPercent: 20 },
      clearanceThreshold: .25,
    },
  };
}

export function RobotWorkcellAssistantPanel({ projectId, scene, runWorkcellAudit, onSaveDraft, onOpenFormalSimulation }: PanelProps) {
  const prepared = useMemo(() => prepareRobotAssistantScene(scene), [scene]);
  const [result, setResult] = useState<RobotWorkcellAssistantResult>();
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setResult(undefined);
    setError("");
    setSaved(false);
  }, [scene.id]);

  async function run() {
    if (!prepared.input) return;
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      setResult(await runRobotWorkcellAssistant(prepared.input, (input) => runWorkcellAudit(projectId, input)));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!result) return;
    setSaving(true);
    setError("");
    try {
      await onSaveDraft(result.taskDraft);
      setSaved(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }

  return <RobotWorkcellAssistantPanelView
    preparation={prepared} {...(result ? { result } : {})} busy={busy} saving={saving} saved={saved} error={error}
    onRun={() => void run()} onSave={() => void save()}
    onOpenFormalSimulation={() => { if (result) onOpenFormalSimulation(result.taskDraft); }}
  />;
}

export function RobotWorkcellAssistantPanelView({ preparation, result, busy, saving, saved, error, onRun, onSave, onOpenFormalSimulation }: {
  preparation: RobotAssistantScenePreparation;
  result?: RobotWorkcellAssistantResult;
  busy: boolean;
  saving: boolean;
  saved: boolean;
  error: string;
  onRun: () => void;
  onSave: () => void;
  onOpenFormalSimulation: () => void;
}) {
  const input = preparation.input;
  return <section className={`robot-assistant-panel ${result?.status ?? "idle"}`} aria-label="机器人工位助手">
    <header className="robot-assistant-header">
      <div className="robot-assistant-title">
        <span><Bot size={14} /> ROBOT WORKCELL ASSISTANT</span>
        <strong>机器人工位助手</strong>
        <small>从场景生成可复核任务草稿；不生成控制器程序，也不会自动下发机器人。</small>
      </div>
      <button className="robot-assistant-run" disabled={busy || !input} onClick={onRun}>
        {busy ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />}
        {busy ? "正在分析" : result ? "重新分析" : "生成任务草稿"}
      </button>
    </header>

    {!input && <div className="robot-assistant-empty"><ScanSearch size={20} /><span><strong>还不能生成工位任务</strong><small>{preparation.issue}</small></span></div>}
    {busy && <div className="robot-assistant-loading" role="status"><LoaderCircle className="spin" size={16} />正在运行关节限位、可达域、AABB 初筛和节拍预算…</div>}
    {error && <div className="robot-assistant-error" role="alert"><AlertTriangle size={15} />{error}</div>}
    {input && !result && !busy && <div className="robot-assistant-ready">
      <span><b>{input.robot.joints.length}</b> 关节</span><span><b>{input.targets.length}</b> 目标</span><span><b>{input.objects.length}</b> 场景对象</span>
      <small>已识别 {input.robot.name}，运行后再决定是否进入正式仿真。</small>
    </div>}
    {result && <RobotAssistantResult result={result} />}
    {result && <footer className="robot-assistant-actions">
      <p><ShieldCheck size={14} /><span><strong>人工确认策略</strong><small>草稿须经机器人程序员、安全复核、离线仿真与低速单步验证。</small></span></p>
      <div>
        <button className="secondary" disabled={saving} onClick={onSave}>
          {saving ? <LoaderCircle className="spin" size={14} /> : <Save size={14} />}
          {saved ? "草稿已保存" : "保存待复核草稿"}
        </button>
        <button className="primary" onClick={onOpenFormalSimulation}><FlaskConical size={14} />打开正式仿真</button>
      </div>
    </footer>}
  </section>;
}

function RobotAssistantResult({ result }: { result: RobotWorkcellAssistantResult }) {
  const limitsOutside = result.jointLimits.filter((item) => item.status === "outside-limit").length;
  const reachable = result.reachability.filter((item) => item.status === "reachable").length;
  const collisions = result.collisionScreening.pairs.filter((item) => item.intersects).length;
  return <div className="robot-assistant-result">
    <div className="robot-assistant-summary">
      {result.status === "ready-for-formal-simulation" ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
      <span>
        <strong>{assistantStatusLabel(result.status)}</strong>
        <small>
          证据覆盖 {(result.workcellAudit.evidenceCoverage * 100).toFixed(0)}% · 指纹 {shortFingerprint(result.evidenceFingerprint)}
        </small>
      </span>
      <em>{result.taskDraft.controllerProgramGenerated ? "已有程序" : "仅草稿"}</em>
    </div>
    <div className="robot-assistant-metrics">
      <Metric icon={<ListChecks size={14} />} value={`${result.taskDraft.steps.length}`} label="任务步骤" />
      <Metric icon={<Gauge size={14} />} value={`${reachable}/${result.reachability.length}`} label="目标可达" />
      <Metric icon={<ShieldCheck size={14} />} value={`${limitsOutside}`} label="限位越界" danger={limitsOutside > 0} />
      <Metric
        icon={<Timer size={14} />}
        value={result.cycleBudget.plannedBudgetSec === undefined ? "待补充" : `${result.cycleBudget.plannedBudgetSec}s`}
        label="规划节拍"
      />
    </div>
    <ResultDetails result={result} collisionCount={collisions} />
  </div>;
}

function ResultDetails({ result, collisionCount }: { result: RobotWorkcellAssistantResult; collisionCount: number }) {
  return <div className="robot-assistant-details">
    <Detail title="任务草稿" meta={`${result.taskDraft.steps.length} 步`} open>
      {result.taskDraft.steps.map((step) => <TaskStep key={step.id} step={step} />)}
    </Detail>
    <Detail title="可达性与关节限位" meta={`${result.reachability.length} 目标 · ${result.jointLimits.length} 检查`}>
      <ul>{result.reachability.map((item) => <li key={`${item.robotId}:${item.targetId}`}>
        <span>{item.targetId}</span>
        <b className={item.status}>{reachabilityLabel(item.status)}</b>
        <small>{item.distance.toFixed(2)} m / 最大 {item.maximumReach.toFixed(2)} m</small>
      </li>)}</ul>
      <ul>{result.jointLimits.map((item) => <li key={`${item.waypointId}:${item.jointId}`}>
        <span>{item.waypointId} · {item.jointName}</span>
        <b className={item.status}>{limitLabel(item.status)}</b>
        <small>
          {item.angleDeg === undefined
            ? "缺少角度"
            : `${item.angleDeg.toFixed(1)}° · [${item.minAngleDeg}°, ${item.maxAngleDeg}°]`}
        </small>
      </li>)}</ul>
    </Detail>
    <Detail title="碰撞初筛" meta={collisionCount ? `${collisionCount} 个 AABB 相交` : collisionLabel(result.collisionScreening.status)}>
      <p className="robot-assistant-declaration">{result.collisionScreening.declaration}</p>
      <ul>{result.collisionScreening.pairs.map((item) => <li key={item.objectIds.join(":")}>
        <span>{item.objectIds.join(" ↔ ")}</span>
        <b className={item.intersects ? "outside-limit" : "reachable"}>
          {item.intersects ? "包围盒相交" : "未相交"}
        </b>
        <small>静态距离 {item.distance.toFixed(3)} m</small>
      </li>)}</ul>
    </Detail>
    <Detail title="节拍预算" meta={cycleStatusLabel(result.cycleBudget.status)}>
      <p className="robot-assistant-declaration">{result.cycleBudget.declaration}</p>
      <ul>{result.cycleBudget.lines.map((item) => <li key={item.id}>
        <span>{item.label}</span><b>{item.seconds.toFixed(3)} s</b><small>{item.basis}</small>
      </li>)}</ul>
    </Detail>
    <Detail title="缺失证据" meta={result.missingEvidence.length ? `${result.missingEvidence.length} 项` : "已满足初筛"} warning={result.missingEvidence.length > 0}>
      {result.missingEvidence.length
        ? <ol>{result.missingEvidence.map((item) => <li key={item}>{item}</li>)}</ol>
        : <p className="robot-assistant-declaration">当前初筛输入完整；仍需执行下列正式仿真。</p>}
    </Detail>
    <Detail title="正式仿真清单" meta={`${result.formalSimulationItems.length} 项`} warning>
      <ol>{result.formalSimulationItems.map((item) => <li key={item}>{item}</li>)}</ol>
    </Detail>
  </div>;
}

function Detail({ title, meta, open, warning, children }: { title: string; meta: string; open?: boolean; warning?: boolean; children: React.ReactNode }) {
  return <details open={open} className={warning ? "warning" : ""}><summary><span>{title}</span><em>{meta}</em></summary><div>{children}</div></details>;
}
function Metric({ icon, value, label, danger }: { icon: React.ReactNode; value: string; label: string; danger?: boolean }) {
  return <span className={danger ? "danger" : ""}>{icon}<b>{value}</b><small>{label}</small></span>;
}
function TaskStep({ step }: { step: RobotTaskDraftStep }) {
  return <div className="robot-assistant-step">
    <i>{step.id.split("-")[1]}</i>
    <span><strong>{step.label}</strong><small>待正式仿真与人工复核</small></span>
  </div>;
}

interface AssistantSceneObject {
  id: string;
  name: string;
  role: WorkcellObjectRole;
  position: Vector3Value;
  rotation?: Vector3Value;
  bounds?: WorkcellBounds;
}

function sceneObjects(scene: SceneSnapshot): AssistantSceneObject[] {
  return [
    ...scene.models.map((item) => ({
      id: item.modelId, name: item.name, role: workcellRole(item.name),
      position: item.transform.position, rotation: item.transform.rotation,
    })),
    ...scene.primitives.map((item) => ({
      id: item.modelId, name: item.name, role: workcellRole(item.name),
      position: item.transform.position, rotation: item.transform.rotation,
      bounds: primitiveWorldBounds(item.kind, item.transform.position, item.transform.rotation, item.transform.scale),
    })),
    ...(scene.annotations ?? []).map((item) => ({ id: item.id, name: item.name, role: workcellRole(item.name), position: item.position })),
  ];
}
function assistantObjectRole(role: ReturnType<typeof workcellRole>): RobotAssistantObjectInput["role"] {
  return role === "tool" || role === "obstacle" ? role : "equipment";
}
function radiansToDegrees(value: { x: number; y: number; z: number }) { return { x: toDegrees(value.x), y: toDegrees(value.y), z: toDegrees(value.z) }; }
function toDegrees(value: number): number { return Math.round(value * 180 / Math.PI * 1_000) / 1_000; }
function shortFingerprint(value: string): string { return value.length > 22 ? `${value.slice(0, 12)}…${value.slice(-8)}` : value; }
function assistantStatusLabel(status: RobotWorkcellAssistantResult["status"]): string {
  return ({ blocked: "发现阻断项", "needs-data": "需要补充证据", "ready-for-formal-simulation": "可进入正式仿真" })[status];
}
function reachabilityLabel(status: RobotWorkcellAssistantResult["reachability"][number]["status"]): string {
  return ({ reachable: "包络内", outside: "超出包络", "inner-dead-zone": "内盲区", "needs-data": "待补充" })[status];
}
function limitLabel(status: RobotWorkcellAssistantResult["jointLimits"][number]["status"]): string {
  return ({ "within-limit": "限位内", "outside-limit": "已越界", "needs-data": "待补充" })[status];
}
function collisionLabel(status: RobotWorkcellAssistantResult["collisionScreening"]["status"]): string {
  return ({
    "aabb-conflict": "AABB 相交", "clearance-warning": "间隙预警",
    "no-aabb-conflict-detected": "未检出 AABB 相交", "needs-data": "待补充包围盒",
  })[status];
}
function cycleStatusLabel(status: RobotWorkcellAssistantResult["cycleBudget"]["status"]): string {
  return ({
    "planned-budget-within-target": "规划预算内", "planned-budget-over-target": "规划预算超时",
    "needs-data": "待补充速度或位姿",
  })[status];
}
