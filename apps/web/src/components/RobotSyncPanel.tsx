import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, LoaderCircle, Play, Radio, RotateCcw } from "lucide-react";
import type { IndustrialValidationStudyRecord, RobotSyncResult, SceneSnapshot } from "@bim-studio/contracts";
// 走 robot-sync 子路径：插件根导出会连入 engine.ts（node:crypto），浏览器包必须绕开。
import { runRobotSyncScenario } from "@bim-studio/workcell-validation-plugin/robot-sync";
import { api } from "../api";
import { buildRobotSyncScenario, buildRobotSyncStudyInput, defaultRobotSyncSettings, robotSyncEvidenceFromStudy, type RobotSyncSettings } from "./robotSyncStudy";
import "./RobotSyncPanel.css";

interface Props {
  projectId: string;
  scene: SceneSnapshot;
  study?: IndustrialValidationStudyRecord;
  onStudyChange?: (study: IndustrialValidationStudyRecord) => void;
}

const EVENT_LABEL: Record<RobotSyncResult["timeline"][number]["event"], string> = {
  "step-start": "运动开始", "step-complete": "运动结束", "signal-wait": "等待信号", "signal-acquired": "信号放行",
  "signal-set": "置位信号", "signal-timeout": "等待超时", "deferred-clearance": "活动窗口推迟", deadlocked: "互等死锁",
};

export function RobotSyncPanel({ projectId, scene, study, onStudyChange }: Props) {
  const [settings, setSettings] = useState<RobotSyncSettings | undefined>(() => defaultRobotSyncSettings(scene));
  const [evidence, setEvidence] = useState(() => robotSyncEvidenceFromStudy(study));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const sequence = useRef(0);
  const running = useRef(false);
  const studyId = study?.id;
  const studyRevision = study?.revision;
  useEffect(() => {
    sequence.current += 1;
    running.current = false;
    setBusy(false);
    setError("");
    const saved = robotSyncEvidenceFromStudy(study);
    setEvidence(saved);
    setSettings(saved?.settings ?? defaultRobotSyncSettings(scene));
  }, [scene.id, scene.updatedAt, studyId, studyRevision]);

  const robotOptions = scene.models.filter((model) => model.rig?.robot?.enabled);
  function update(next: RobotSyncSettings) {
    sequence.current += 1;
    running.current = false;
    setSettings(next);
    setEvidence(undefined);
    setBusy(false);
    setError("");
  }
  async function run() {
    if (running.current || !settings) return;
    running.current = true;
    const runId = ++sequence.current;
    setBusy(true);
    setError("");
    try {
      const frozen = structuredClone(settings);
      const scenario = buildRobotSyncScenario(scene, frozen);
      // 仅在浏览器中运行确定性调度；不是接入实际控制器，也不向设备下发命令。
      const result = runRobotSyncScenario(scenario);
      if (runId !== sequence.current) return;
      const saved = await api.saveValidationStudy(projectId, buildRobotSyncStudyInput(scene, frozen, scenario, result, study));
      if (runId !== sequence.current) return;
      setEvidence({ scenario, result, settings: frozen });
      onStudyChange?.(saved);
    } catch (reason) {
      if (runId === sequence.current) setError(reason instanceof Error ? reason.message : "互锁报告未保存；请检查参数并重试");
    } finally {
      if (runId === sequence.current) {
        running.current = false;
        setBusy(false);
      }
    }
  }
  const result = evidence?.result;
  const robotsByProgram = new Map(evidence?.scenario.programs.map((program) => [program.programId, robotOptions.find((robot) => robot.modelId === program.robotStableId)?.name ?? program.robotStableId]) ?? []);
  const status = result?.status === "completed" && !result.violations.length ? "通过调度检查" : result?.status === "completed" ? "存在活动窗口推迟" : result?.status === "deadlock" ? "发现互等死锁" : result?.status === "signal-timeout" ? "发现等待超时" : "未运行";

  return <section className="robot-sync-panel" aria-label="多机器人信号互锁评审">
    <header><div><span><Radio size={14} />工位评审 · 信号互锁</span><h3>多机器人调度复核</h3><p>仿真控制器级事件调度；时间取手动声明值。活动窗口互斥只提示潜在过近，不计算 TCP 距离、连杆扫掠或控制器认证。</p></div>
      <button type="button" disabled={!settings || busy || settings.durations.some((value) => !Number.isFinite(value) || value <= 0)} title={!settings ? "当前场景至少需要两台已配置机器人" : settings.durations.some((value) => !Number.isFinite(value) || value <= 0) ? "先输入两台机器人各自的运动时长" : undefined} onClick={() => void run()}>{busy ? <LoaderCircle className="spin" size={15} /> : result ? <RotateCcw size={15} /> : <Play size={15} />}{busy ? "正在保存报告" : result ? "重新运行并留证" : "运行互锁评审"}</button>
    </header>
    {!settings && <p className="robot-sync-empty">当前场景不足两台机器人；在场景中启用至少两台机器人关节链后可配置互锁。</p>}
    {settings && <div className="robot-sync-configuration">
      <p>每台机器人按“等待信号 → 运动 → 置位信号”执行；空信号表示跳过。运动时长是工程师输入，不从模型轨迹推断。</p>
      {settings.robotIds.map((id, index) => <fieldset key={index} disabled={busy}><legend>程序 {index + 1}</legend>
        <label>机器人<select value={id} onChange={(event) => update({ ...settings, robotIds: settings.robotIds.map((value, slot) => slot === index ? event.target.value : value) as [string, string] })}>{robotOptions.map((robot) => <option key={robot.modelId} value={robot.modelId}>{robot.name}</option>)}</select></label>
        <label>运动时长 · s<input type="number" min="0.001" max="3600" step="0.1" value={settings.durations[index]} onChange={(event) => update({ ...settings, durations: settings.durations.map((value, slot) => slot === index ? event.target.valueAsNumber : value) as [number, number] })} /></label>
        <label>等待信号<input type="text" maxLength={64} placeholder="留空表示立即开始" value={settings.waits[index]} onChange={(event) => update({ ...settings, waits: settings.waits.map((value, slot) => slot === index ? event.target.value : value) as [string, string] })} /></label>
        <label>置位信号<input type="text" maxLength={64} placeholder="留空表示不置位" value={settings.sets[index]} onChange={(event) => update({ ...settings, sets: settings.sets.map((value, slot) => slot === index ? event.target.value : value) as [string, string] })} /></label>
      </fieldset>)}
      <label>等待超时 · s<input type="number" min="0.001" max="3600" step="0.1" value={settings.timeoutSeconds} onChange={(event) => update({ ...settings, timeoutSeconds: event.target.valueAsNumber })} /></label>
      <label>活动窗口互斥阈值 · m<input type="number" min="0" max="100" step="0.1" value={settings.clearMeters} onChange={(event) => update({ ...settings, clearMeters: event.target.valueAsNumber })} /></label>
      {settings.durations.some((value) => !Number.isFinite(value) || value <= 0) && <small className="robot-sync-input-hint">请输入两台机器人的运动时长（秒）后才能运行；不会从模型猜测真实节拍。</small>}
      <small>阈值大于 0 时，重叠活动窗口会被串行推迟并记录“潜在过近”；0 表示不启用窗口互斥。此阈值不是实测安全间隙。</small>
    </div>}
    {busy && <p className="robot-sync-feedback" role="status"><LoaderCircle className="spin" size={14} />正在留存互锁报告…</p>}
    {error && <p className="robot-sync-error" role="alert"><AlertTriangle size={15} />{error}；请修正参数或刷新任务后重试。</p>}
    {result && <div className={`robot-sync-report ${result.status === "completed" && !result.violations.length ? "passed" : "attention"}`}>
      <div className="robot-sync-report-summary">{result.status === "completed" && !result.violations.length ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}<strong>{status}</strong><span>周期 {result.cycleSeconds.toFixed(2)} s</span><span>潜在互斥推迟 {result.violations.length} 项</span></div>
      <small>记录 {study ? `v${study.revision} · ` : ""}场景 {scene.name} · {result.timeline.length} 条事件。报告仅代表已保存的输入与仿真调度，非几何/安全认证。</small>
      {result.violations.length > 0 && <ul className="robot-sync-violations">{result.violations.map((violation, index) => <li key={`${violation.programId}-${violation.atSeconds}-${index}`}>t={violation.atSeconds.toFixed(2)} s · {robotsByProgram.get(violation.programId)} 相对 {robotsByProgram.get(violation.programIdOther ?? "")} 被推迟；请复核真实空间间隙</li>)}</ul>}
      <details open={result.status !== "completed"}><summary>调度事件时间线 · {result.timeline.length} 条</summary><ol>{result.timeline.map((entry, index) => <li key={`${entry.programId}-${entry.stepId}-${entry.event}-${index}`}><time>{entry.atSeconds.toFixed(2)} s</time><span>{robotsByProgram.get(entry.programId)}</span><strong>{EVENT_LABEL[entry.event]}</strong><small>{entry.stepId}</small></li>)}</ol></details>
    </div>}
  </section>;
}
