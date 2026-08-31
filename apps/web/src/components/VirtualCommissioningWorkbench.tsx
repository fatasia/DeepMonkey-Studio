import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ListChecks,
  LoaderCircle,
  Play,
  Plus,
} from "lucide-react";
import type {
  IndustrialDiagnosisValidationDraft,
  IndustrialValidationStudyRecord,
  SceneSnapshot,
  VirtualDebugResult,
  VirtualDebugSignalBinding,
  VirtualDebugSuiteCaseResult,
  VirtualDebugSuiteResult,
  WorkcellAuditInput,
  WorkcellAuditResult,
} from "@bim-studio/contracts";
import { api, type CapabilityInvocationResult } from "../api";
import {
  buildVirtualDebugGoldenSuite,
  buildVirtualDebugScenario,
  parseSignalValue,
  virtualDebugObjectOptions,
} from "./virtualCommissioningModel";
import { BindingRow, NumberField } from "./VirtualCommissioningControls";
import {
  createVirtualDebugBinding,
  defaultVirtualDebugBindings,
  downloadVirtualDebugEvidence,
  isVirtualDebugControlSignal,
  validationDraftFromStudy,
  VIRTUAL_DEBUG_SIGNALS,
} from "./virtualCommissioningDraft";
import { VirtualCommissioningEvidence } from "./VirtualCommissioningEvidence";
import { VirtualCommissioningSuiteEvidence } from "./VirtualCommissioningSuiteEvidence";
import { WorkcellAuditPanel } from "./WorkcellAuditPanel";
import { VirtualCommissioningTestDesignPanel } from "./VirtualCommissioningTestDesignPanel";
import { RobotWorkcellAssistantPanel, type RobotTaskDraft } from "./RobotWorkcellAssistantPanel";
import { buildIndustrialStudyContext } from "./industrialStudyFingerprints";
import { buildVirtualCommissioningStudyInput, matchingVirtualCommissioningStudy } from "./virtualCommissioningStudy";
import { matchingWorkcellStudy } from "./workcellAuditStudy";
import "./VirtualCommissioningWorkbench.css";

interface Props {
  projectId: string;
  scenes: SceneSnapshot[];
  initialDraft?: IndustrialDiagnosisValidationDraft;
  initialStudy?: IndustrialValidationStudyRecord;
  studies?: IndustrialValidationStudyRecord[];
  onStudyChange?: (study: IndustrialValidationStudyRecord) => void;
  onOpenTarget: (sceneId: string, objectId: string) => void;
}

export function VirtualCommissioningWorkbench({
  projectId,
  scenes,
  initialDraft,
  initialStudy,
  studies = [],
  onStudyChange,
  onOpenTarget,
}: Props) {
  const [sceneId, setSceneId] = useState(scenes[0]?.id ?? "");
  const scene = useMemo(() => scenes.find((item) => item.id === sceneId) ?? scenes[0], [sceneId, scenes]);
  const objects = useMemo(() => virtualDebugObjectOptions(scene), [scene]);
  const [bindings, setBindings] = useState<VirtualDebugSignalBinding[]>(() => defaultVirtualDebugBindings(scenes[0]));
  const [durationMs, setDurationMs] = useState(1_000);
  const [tickMs, setTickMs] = useState(50);
  const [faultEnabled, setFaultEnabled] = useState(true);
  const [faultAtMs, setFaultAtMs] = useState(500);
  const [resetEnabled, setResetEnabled] = useState(true);
  const [resetAtMs, setResetAtMs] = useState(800);
  const [speedSetpoint, setSpeedSetpoint] = useState(1_200);
  const [acceptanceAtMs, setAcceptanceAtMs] = useState(800);
  const [acceptanceSignal, setAcceptanceSignal] = useState("alarm");
  const [acceptanceText, setAcceptanceText] = useState("false");
  const [invocation, setInvocation] = useState<CapabilityInvocationResult<VirtualDebugResult>>();
  const [suiteInvocation, setSuiteInvocation] = useState<CapabilityInvocationResult<VirtualDebugSuiteResult>>();
  const [playheadMs, setPlayheadMs] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [appliedDraft, setAppliedDraft] = useState<IndustrialDiagnosisValidationDraft>();
  const [activeStudy, setActiveStudy] = useState(initialStudy);
  const activeVirtualStudy = matchingVirtualCommissioningStudy(activeStudy);
  const currentVirtualStudy = activeVirtualStudy?.sceneId === scene?.id
    ? activeVirtualStudy
    : studies.find((study) => matchingVirtualCommissioningStudy(study)?.sceneId === scene?.id);
  const currentWorkcellStudy = (scene ? matchingWorkcellStudy(activeStudy, scene.id) : undefined)
    ?? (scene ? studies.find((study) => matchingWorkcellStudy(study, scene.id)) : undefined);
  const result = invocation?.output;

  useEffect(() => {
    if (scene || !scenes[0]) return;
    setSceneId(scenes[0].id);
    setBindings(defaultVirtualDebugBindings(scenes[0]));
  }, [scene, scenes]);

  useEffect(() => {
    const virtualStudy = matchingVirtualCommissioningStudy(initialStudy);
    const draft = initialDraft ?? (virtualStudy ? validationDraftFromStudy(virtualStudy) : undefined);
    if (!draft) {
      const workcellScene = initialStudy?.sourceKind === "workcell-audit"
        ? scenes.find((candidate) => candidate.id === initialStudy.sceneId)
        : undefined;
      if (workcellScene) {
        setSceneId(workcellScene.id);
        setBindings(defaultVirtualDebugBindings(workcellScene));
      }
      if (initialStudy) setAppliedDraft(undefined);
      return;
    }
    if (appliedDraft?.sourceAssessmentId === draft.sourceAssessmentId) return;
    const targetScene = scenes.find((item) => item.id === draft.sceneId) ?? scenes[0];
    const targetObjects = virtualDebugObjectOptions(targetScene);
    const targetObject = targetObjects.find((item) => item.id === draft.objectId) ?? targetObjects[0];
    if (!targetScene || !targetObject) {
      setError("AI 已生成验证目标，但关联场景中没有可映射设备");
      return;
    }
    const controlSignals = draft.signals.filter(isVirtualDebugControlSignal);
    const signals = controlSignals.length ? [...new Set(controlSignals)] : ["motorRunning", "alarm"];
    setSceneId(targetScene.id);
    setBindings(
      signals.map((signal, index) =>
        createVirtualDebugBinding(index + 1, signal, targetScene.id, targetObject.id, targetObject.kind),
      ),
    );
    setAcceptanceSignal(signals.includes("alarm") ? "alarm" : (signals[0] ?? "alarm"));
    setAcceptanceText(signals.includes("alarm") ? "false" : "true");
    setInvocation(undefined);
    setPlayheadMs(0);
    setAppliedDraft(draft);
  }, [appliedDraft?.sourceAssessmentId, initialDraft, initialStudy, scenes]);

  useEffect(() => {
    setActiveStudy((current) => !current || current.id !== initialStudy?.id || current.revision < (initialStudy?.revision ?? 0)
      ? initialStudy
      : current);
  }, [initialStudy]);

  function changeScene(nextSceneId: string) {
    const nextScene = scenes.find((item) => item.id === nextSceneId);
    setSceneId(nextSceneId);
    setBindings(defaultVirtualDebugBindings(nextScene));
    setInvocation(undefined);
    setSuiteInvocation(undefined);
    setPlayheadMs(0);
  }

  async function runScenario() {
    setBusy(true);
    setError("");
    try {
      if (!scene) throw new Error("请先创建或选择一个三维场景");
      if (!bindings.length) throw new Error("至少配置一条控制信号映射");
      const scenario = buildVirtualDebugScenario({
        scenarioId: `${scene.id}-acceptance`,
        durationMs,
        tickMs,
        faultEnabled,
        faultAtMs,
        resetEnabled,
        resetAtMs,
        speedSetpoint,
        acceptanceAtMs,
        acceptanceSignal,
        acceptanceValue: parseSignalValue(acceptanceText),
        bindings,
      });
      const response = await api.runVirtualDebug<VirtualDebugResult>(projectId, scenario);
      if (!response.output) throw new Error(response.error?.message ?? "虚拟调试没有返回可回放证据");
      setInvocation(response);
      setSuiteInvocation(undefined);
      setPlayheadMs(response.output.failures[0]?.atMs ?? response.output.durationMs);
      await persistResult({
        status: response.output.status,
        scenarioId: response.output.scenarioId,
        evidenceFingerprint: response.output.evidenceFingerprint,
        failureCount: response.output.failures.length,
      }, scenario, "simulation.virtual-debug.run");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function runGoldenSuite() {
    setBusy(true);
    setError("");
    try {
      if (!scene) throw new Error("请先创建或选择一个三维场景");
      if (!bindings.length) throw new Error("至少配置一条控制信号映射");
      const suite = buildVirtualDebugGoldenSuite({
        suiteId: `${scene.id}-golden-suite`,
        durationMs,
        tickMs,
        speedSetpoint,
        bindings,
      });
      const response = await api.runVirtualDebugSuite<VirtualDebugSuiteResult>(projectId, suite);
      if (!response.output) throw new Error(response.error?.message ?? "黄金测试矩阵没有返回验收证据");
      setSuiteInvocation(response);
      const firstCase = response.output.cases.find((item) => !item.expectationMatched) ?? response.output.cases[0];
      if (firstCase) inspectSuiteCase(firstCase, response);
      await persistResult({
        status: response.output.status,
        scenarioId: response.output.suiteId,
        evidenceFingerprint: response.output.evidenceFingerprint,
        failureCount: response.output.totalCases - response.output.matchedCases,
      }, suite, "simulation.virtual-debug.run-suite");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function persistResult(latest: {
    status: "passed" | "failed";
    scenarioId: string;
    evidenceFingerprint: string;
    failureCount: number;
  }, scenarioInput: Parameters<typeof buildVirtualCommissioningStudyInput>[0]["scenarioInput"], engineId: Parameters<typeof buildVirtualCommissioningStudyInput>[0]["engineId"]) {
    if (!scene) return;
    const study = await api.saveValidationStudy(projectId, buildVirtualCommissioningStudyInput({
      scene,
      bindings,
      latest,
      scenarioInput,
      engineId,
      ...(currentVirtualStudy ? { baseline: currentVirtualStudy } : {}),
    }));
    setActiveStudy(study);
    onStudyChange?.(study);
  }

  async function runRobotWorkcellAudit(input: WorkcellAuditInput): Promise<WorkcellAuditResult> {
    const response = await api.invokeCapability<WorkcellAuditResult>(projectId, "manufacturing.workcell.audit", input);
    if (!response.output) throw new Error(response.error?.message ?? "机器人工位体检没有返回结果");
    return response.output;
  }

  async function saveRobotTaskDraft(draft: RobotTaskDraft) {
    if (!scene) return;
    const saved = await api.saveValidationStudy(projectId, {
      title: `机器人任务复核：${draft.name}`,
      sourceKind: "workcell-audit",
      studyType: "workcell-audit",
      sourceRefs: [draft.id],
      sceneId: scene.id,
      objectIds: [...new Set(draft.steps.map((step) => step.targetId))],
      objective: "完成机器人任务、可达性、碰撞、节拍与安全复核后再生成控制器程序",
      acceptanceCriteria: draft.steps.map((step) => `${step.label}：通过正式仿真与人工确认`),
      scenarioInput: structuredClone(draft) as unknown as NonNullable<IndustrialValidationStudyRecord["scenarioInput"]>,
      context: buildIndustrialStudyContext(scene, "manufacturing.robot-task-draft", "1.0.0"),
    });
    setActiveStudy(saved);
    onStudyChange?.(saved);
  }

  function inspectSuiteCase(
    testCase: VirtualDebugSuiteCaseResult,
    source = suiteInvocation,
  ) {
    if (!source) return;
    setInvocation({
      ...source,
      capabilityId: "simulation.virtual-debug.run",
      output: testCase.result,
      warnings: testCase.result.failures.map((failure) => failure.message),
    });
    setPlayheadMs(testCase.result.failures[0]?.atMs ?? testCase.result.durationMs);
  }

  function addBinding() {
    const target = objects[0];
    if (!scene || !target) {
      setError("当前场景没有可绑定的模型或参数化设备");
      return;
    }
    const signal = VIRTUAL_DEBUG_SIGNALS.find((candidate) => !bindings.some((item) => item.signal === candidate)) ?? "speedSetpoint";
    setBindings((current) => [
      ...current,
      createVirtualDebugBinding(current.length + 1, signal, scene.id, target.id, target.kind),
    ]);
  }

  function updateBinding(id: string, patch: Partial<VirtualDebugSignalBinding>) {
    setBindings((current) =>
      current.map((item) =>
        item.id === id
          ? {
              ...item,
              ...patch,
              target: patch.target ? { ...patch.target } : item.target,
            }
          : item,
      ),
    );
  }

  function exportEvidence() {
    if (!result || !invocation) return;
    downloadVirtualDebugEvidence(`${result.scenarioId}-evidence.json`, {
      exportedAt: new Date().toISOString(),
      projectId,
      traceId: invocation.traceId,
      decisionStatus: invocation.decisionStatus,
      evidence: invocation.evidence,
      ...(initialStudy ? { validationStudy: { id: initialStudy.id, revision: initialStudy.revision } } : {}),
      result,
    });
  }

  function exportSuiteEvidence() {
    if (!suiteInvocation?.output) return;
    downloadVirtualDebugEvidence(`${suiteInvocation.output.suiteId}-evidence.json`, {
      exportedAt: new Date().toISOString(),
      projectId,
      traceId: suiteInvocation.traceId,
      decisionStatus: suiteInvocation.decisionStatus,
      evidence: suiteInvocation.evidence,
      ...(currentVirtualStudy ? { validationStudy: { id: currentVirtualStudy.id, revision: currentVirtualStudy.revision } } : {}),
      result: suiteInvocation.output,
    });
  }

  return (
    <section className="commissioning-workbench">
      <header className="commissioning-titlebar">
        <div>
          <span>VIRTUAL ACCEPTANCE</span>
          <h2>控制逻辑虚拟验收</h2>
          <p>映射现有三维设备，注入故障并回放 I/O；不复制场景、不连接真实控制器。</p>
        </div>
        <div className="commissioning-title-actions">
          <button
            className="commissioning-suite-run"
            disabled={busy || !scene || objects.length === 0}
            onClick={() => void runGoldenSuite()}
          >
            <ListChecks size={16} />
            运行黄金矩阵
          </button>
          <button
            className="commissioning-run"
            disabled={busy || !scene || objects.length === 0}
            onClick={() => void runScenario()}
          >
            {busy ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />}
            运行当前场景
          </button>
        </div>
      </header>

      <div className="commissioning-steps" aria-label="虚拟调试流程">
        <span className="active">
          <b>1</b>
          <i>映射 I/O</i>
          <small>控制信号关联场景设备</small>
        </span>
        <span className={result ? "active" : ""}>
          <b>2</b>
          <i>故障回放</i>
          <small>确定性命令、联锁与复位</small>
        </span>
        <span className={result ? "active" : ""}>
          <b>3</b>
          <i>验收留证</i>
          <small>断言、定位与证据指纹</small>
        </span>
      </div>

      {appliedDraft && (
        <aside className="commissioning-ai-draft">
          <div>
            <strong>
              {initialStudy ? `验证任务已保存 · v${initialStudy.revision}` : "AI 已配置验证场景"}
            </strong>
            <span>{appliedDraft.objective}</span>
          </div>
          <ul>
            {appliedDraft.acceptanceCriteria.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </aside>
      )}

      {error && (
        <div className="commissioning-error">
          <AlertTriangle size={15} />
          {error}
          <button onClick={() => setError("")}>×</button>
        </div>
      )}
      {scene && (
        <VirtualCommissioningTestDesignPanel
          sceneId={scene.id}
          bindings={bindings}
          durationMs={durationMs}
          tickMs={tickMs}
          speedSetpoint={speedSetpoint}
        />
      )}
      <VirtualCommissioningSuiteEvidence
        result={suiteInvocation?.output}
        previousResult={currentVirtualStudy?.latestResult}
        onInspect={inspectSuiteCase}
        onExport={exportSuiteEvidence}
      />
      {scene && <WorkcellAuditPanel
        projectId={projectId}
        scene={scene}
        {...(currentWorkcellStudy ? { study: currentWorkcellStudy } : {})}
        {...(onStudyChange ? { onStudyChange } : {})}
        onOpenTarget={onOpenTarget}
      />}
      {scene?.models.some((model) => model.rig?.robot?.enabled) && (
        <RobotWorkcellAssistantPanel
          projectId={projectId}
          scene={scene}
          runWorkcellAudit={(_panelProjectId, input) => runRobotWorkcellAudit(input)}
          onSaveDraft={saveRobotTaskDraft}
          onOpenFormalSimulation={() => document.getElementById("commissioning-formal-simulation")?.scrollIntoView({ behavior: "smooth", block: "start" })}
        />
      )}
      {!scenes.length ? (
        <div className="commissioning-empty">
          <strong>没有可调试场景</strong>
          <span>先在三维工作区创建场景和设备，再回来配置控制信号。</span>
        </div>
      ) : (
        <div id="commissioning-formal-simulation" className="commissioning-layout">
          <section className="commissioning-config">
            <fieldset>
              <legend>验收对象</legend>
              <label>
                <span>三维场景</span>
                <select value={scene?.id ?? ""} onChange={(event) => changeScene(event.target.value)}>
                  {scenes.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="commissioning-field-grid">
                <NumberField label="仿真时长 ms" value={durationMs} min={100} step={50} onChange={setDurationMs} />
                <NumberField label="采样周期 ms" value={tickMs} min={10} step={10} onChange={setTickMs} />
                <NumberField label="速度设定" value={speedSetpoint} min={0} step={100} onChange={setSpeedSetpoint} />
              </div>
            </fieldset>

            <fieldset>
              <legend>故障与复位</legend>
              <div className="commissioning-switch-row">
                <label>
                  <input
                    type="checkbox"
                    checked={faultEnabled}
                    onChange={(event) => setFaultEnabled(event.target.checked)}
                  />
                  注入设备联锁故障
                </label>
                {faultEnabled && (
                  <NumberField label="故障时间 ms" value={faultAtMs} min={0} step={tickMs} onChange={setFaultAtMs} />
                )}
              </div>
              <div className="commissioning-switch-row">
                <label>
                  <input
                    type="checkbox"
                    checked={resetEnabled}
                    onChange={(event) => setResetEnabled(event.target.checked)}
                  />
                  执行人工复位
                </label>
                {resetEnabled && (
                  <NumberField label="复位时间 ms" value={resetAtMs} min={0} step={tickMs} onChange={setResetAtMs} />
                )}
              </div>
            </fieldset>

            <fieldset>
              <legend className="commissioning-legend-row">
                <span>控制信号映射</span>
                <button type="button" onClick={addBinding}>
                  <Plus size={13} />
                  添加信号
                </button>
              </legend>
              <div className="commissioning-bindings">
                {bindings.map((binding) => (
                  <BindingRow
                    key={binding.id}
                    binding={binding}
                    objects={objects}
                    onChange={(patch) => updateBinding(binding.id, patch)}
                    onRemove={() => setBindings((current) => current.filter((item) => item.id !== binding.id))}
                  />
                ))}
              </div>
              {!bindings.length && (
                <div className="commissioning-inline-empty">尚未配置映射，验收失败时将无法定位三维设备。</div>
              )}
            </fieldset>

            <fieldset>
              <legend>验收断言</legend>
              <div className="commissioning-assertion">
                <span>在</span>
                <input
                  type="number"
                  min="0"
                  step={tickMs}
                  value={acceptanceAtMs}
                  onChange={(event) => setAcceptanceAtMs(Number(event.target.value))}
                />
                <span>ms，信号</span>
                <select value={acceptanceSignal} onChange={(event) => setAcceptanceSignal(event.target.value)}>
                  {VIRTUAL_DEBUG_SIGNALS.map((item) => (
                    <option key={item}>{item}</option>
                  ))}
                </select>
                <span>应等于</span>
                <input value={acceptanceText} onChange={(event) => setAcceptanceText(event.target.value)} />
              </div>
            </fieldset>
          </section>

          <VirtualCommissioningEvidence
            invocation={invocation}
            playheadMs={playheadMs}
            onPlayheadChange={setPlayheadMs}
            onExport={exportEvidence}
            onOpenTarget={onOpenTarget}
          />
        </div>
      )}
    </section>
  );
}
