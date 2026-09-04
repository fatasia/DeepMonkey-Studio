import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
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
import {
  createVirtualDebugBinding,
  defaultVirtualDebugBindings,
  downloadVirtualDebugEvidence,
  isVirtualDebugControlSignal,
  validationDraftFromStudy,
  VIRTUAL_DEBUG_SIGNALS,
} from "./virtualCommissioningDraft";
import { WorkcellAuditPanel } from "./WorkcellAuditPanel";
import { RobotWorkcellAssistantPanel } from "./RobotWorkcellAssistantPanel";
import type { RobotWorkcellAssistantInput, RobotWorkcellAssistantResult } from "./robotWorkcellAssistantTypes";
import { buildRobotWorkcellStudyInput, matchingRobotWorkcellStudy } from "./robotWorkcellStudy";
import { preferredUsableScene } from "./sceneOptionPresentation";
import { VirtualCommissioningControlStage } from "./VirtualCommissioningControlStage";
import { VirtualCommissioningResultStage } from "./VirtualCommissioningResultStage";
import { VirtualCommissioningWorkflowHeader, type CommissioningWorkflowStage } from "./VirtualCommissioningWorkflowHeader";
import { buildVirtualCommissioningStudyInput, matchingVirtualCommissioningStudy } from "./virtualCommissioningStudy";
import { matchingWorkcellStudy } from "./workcellAuditStudy";
import "./VirtualCommissioningWorkbench.css";

interface Props {
  projectId: string;
  scenes: SceneSnapshot[];
  initialDraft?: IndustrialDiagnosisValidationDraft;
  initialStudy?: IndustrialValidationStudyRecord;
  studies?: IndustrialValidationStudyRecord[];
  initialSceneId?: string;
  initialObjectId?: string;
  initialStage?: CommissioningWorkflowStage;
  onStudyChange?: (study: IndustrialValidationStudyRecord) => void;
  onOpenTarget: (sceneId: string, objectId: string) => void;
}

export function VirtualCommissioningWorkbench({
  projectId,
  scenes,
  initialDraft,
  initialStudy,
  studies = [],
  initialSceneId,
  initialObjectId,
  initialStage = "screening",
  onStudyChange,
  onOpenTarget,
}: Props) {
  const initialScene = scenes.find((candidate) => candidate.id === initialStudy?.sceneId)
    ?? scenes.find((candidate) => candidate.id === initialSceneId)
    ?? preferredUsableScene(scenes);
  const [sceneId, setSceneId] = useState(initialScene?.id ?? "");
  const scene = useMemo(() => scenes.find((item) => item.id === sceneId) ?? preferredUsableScene(scenes), [sceneId, scenes]);
  const robotOptions = useMemo(() => scene?.models.filter((model) => model.rig?.robot?.enabled) ?? [], [scene]);
  const [robotModelId, setRobotModelId] = useState(() => initialRobotId(initialScene, initialStudy, initialObjectId));
  const [selectionConfirmed, setSelectionConfirmed] = useState(Boolean(initialDraft || initialStudy || initialSceneId));
  const [workflowStage, setWorkflowStage] = useState<CommissioningWorkflowStage>(initialStage);
  const objects = useMemo(() => virtualDebugObjectOptions(scene), [scene]);
  const [bindings, setBindings] = useState<VirtualDebugSignalBinding[]>(() => defaultVirtualDebugBindings(initialScene, initialObjectId));
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
  const [robotScreening, setRobotScreening] = useState<RobotWorkcellAssistantResult>();
  const appliedEditorContext = useRef(`${initialSceneId ?? ""}:${initialObjectId ?? ""}:${initialStage}`);
  const activeVirtualStudy = matchingVirtualCommissioningStudy(activeStudy);
  const currentVirtualStudy = activeVirtualStudy?.sceneId === scene?.id
    ? activeVirtualStudy
    : studies.find((study) => matchingVirtualCommissioningStudy(study)?.sceneId === scene?.id);
  const currentRobotStudy = scene && robotModelId
    ? matchingRobotWorkcellStudy(activeStudy, scene.id, robotModelId)
      ?? studies.find((study) => matchingRobotWorkcellStudy(study, scene.id, robotModelId))
    : undefined;
  const currentWorkcellStudy = scene
    ? genericWorkcellStudy(activeStudy, scene.id)
      ?? studies.find((study) => genericWorkcellStudy(study, scene.id))
    : undefined;
  const result = invocation?.output;
  useEffect(() => {
    const fallback = preferredUsableScene(scenes);
    if (scenes.some((item) => item.id === sceneId) || !fallback) return;
    setSceneId(fallback.id);
    setBindings(defaultVirtualDebugBindings(fallback));
    setSelectionConfirmed(false);
    setWorkflowStage("screening");
    setInvocation(undefined);
    setSuiteInvocation(undefined);
    setRobotScreening(undefined);
    setPlayheadMs(0);
  }, [sceneId, scenes]);

  useEffect(() => {
    if (!initialSceneId || initialDraft || initialStudy) return;
    const contextKey = `${initialSceneId}:${initialObjectId ?? ""}:${initialStage}`;
    if (appliedEditorContext.current === contextKey || busy) return;
    const targetScene = scenes.find((candidate) => candidate.id === initialSceneId);
    if (!targetScene) return;
    appliedEditorContext.current = contextKey;
    setSceneId(targetScene.id);
    setRobotModelId(initialRobotId(targetScene, undefined, initialObjectId));
    setBindings(defaultVirtualDebugBindings(targetScene, initialObjectId));
    setSelectionConfirmed(true);
    setWorkflowStage(initialStage);
    setInvocation(undefined);
    setSuiteInvocation(undefined);
    setRobotScreening(undefined);
    setPlayheadMs(0);
  }, [busy, initialDraft, initialObjectId, initialSceneId, initialStage, initialStudy, scenes]);

  useEffect(() => {
    if (!robotModelId || robotOptions.some((robot) => robot.modelId === robotModelId)) return;
    setRobotModelId(robotOptions[0]?.modelId ?? "");
  }, [robotModelId, robotOptions]);

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
        const robotStudy = matchingRobotWorkcellStudy(initialStudy, workcellScene.id);
        const studiedRobot = robotStudy
          ? workcellScene.models.find((model) => model.rig?.robot?.enabled && robotStudy.objectIds.includes(model.modelId))
          : undefined;
        setRobotModelId(studiedRobot?.modelId ?? "");
        setSelectionConfirmed(true);
      }
      if (initialStudy) setAppliedDraft(undefined);
      return;
    }
    if (appliedDraft?.sourceAssessmentId === draft.sourceAssessmentId) return;
    const targetScene = scenes.find((item) => item.id === draft.sceneId) ?? preferredUsableScene(scenes);
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
    setSelectionConfirmed(true);
  }, [appliedDraft?.sourceAssessmentId, initialDraft, initialStudy, scenes]);

  useEffect(() => {
    setActiveStudy((current) => !current || current.id !== initialStudy?.id || current.revision < (initialStudy?.revision ?? 0)
      ? initialStudy
      : current);
  }, [initialStudy]);
  function changeScene(nextSceneId: string) {
    const nextScene = scenes.find((item) => item.id === nextSceneId);
    setSceneId(nextSceneId);
    setRobotModelId(nextScene?.models.find((model) => model.rig?.robot?.enabled)?.modelId ?? "");
    setSelectionConfirmed(false);
    setWorkflowStage("screening");
    setBindings(defaultVirtualDebugBindings(nextScene));
    setInvocation(undefined);
    setSuiteInvocation(undefined);
    setRobotScreening(undefined);
    setPlayheadMs(0);
  }
  function changeRobot(nextRobotId: string) {
    setRobotModelId(nextRobotId);
    setSelectionConfirmed(false);
    const target = objects.find((item) => item.id === nextRobotId) ?? objects[0];
    if (scene && target) {
      setBindings([
        createVirtualDebugBinding(1, "motorRunning", scene.id, target.id, target.kind),
        createVirtualDebugBinding(2, "alarm", scene.id, target.id, target.kind),
      ]);
    }
    setWorkflowStage("screening");
    setRobotScreening(undefined);
    setInvocation(undefined);
    setSuiteInvocation(undefined);
    setPlayheadMs(0);
  }
  function confirmSelection() {
    setWorkflowStage("screening");
    setSelectionConfirmed(true);
  }
  function acceptStudy(study: IndustrialValidationStudyRecord) {
    setActiveStudy(study);
    onStudyChange?.(study);
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
      setWorkflowStage("result");
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
      setWorkflowStage("result");
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

  async function saveRobotScreening(input: RobotWorkcellAssistantInput, result: RobotWorkcellAssistantResult) {
    if (!scene) return;
    const saved = await api.saveValidationStudy(projectId, buildRobotWorkcellStudyInput({
      scene,
      input,
      result,
      ...(currentRobotStudy ? { existing: currentRobotStudy } : {}),
    }));
    setRobotScreening(result);
    acceptStudy(saved);
  }

  function continueRobotValidation(result: RobotWorkcellAssistantResult) {
    setRobotScreening(result);
    const robot = objects.find((item) => item.id === result.taskDraft.robotId);
    if (scene && robot && bindings.length === 0) {
      setBindings([
        createVirtualDebugBinding(1, "motorRunning", scene.id, robot.id, robot.kind),
        createVirtualDebugBinding(2, "alarm", scene.id, robot.id, robot.kind),
      ]);
    }
    setWorkflowStage("control");
    requestAnimationFrame(() => {
      const stage = document.getElementById("commissioning-control-validation");
      stage?.scrollIntoView({ behavior: "smooth", block: "start" });
      stage?.focus({ preventScroll: true });
    });
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
      ...(currentVirtualStudy ? { validationStudy: { id: currentVirtualStudy.id, revision: currentVirtualStudy.revision } } : {}),
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

  const quickScreenDone = robotModelId ? Boolean(robotScreening || currentRobotStudy?.latestResult) : Boolean(currentWorkcellStudy?.latestResult);
  const quickScreenHasIssues = robotModelId
    ? robotScreening ? robotScreening.status !== "ready-for-control-validation" : currentRobotStudy?.latestResult?.status === "failed"
    : currentWorkcellStudy?.latestResult?.status === "failed";
  const controlRunDone = Boolean(result || suiteInvocation?.output);
  const controlStudySaved = Boolean(currentVirtualStudy?.latestResult || controlRunDone);
  const controlHasIssues = (suiteInvocation?.output?.status ?? result?.status ?? currentVirtualStudy?.latestResult?.status) === "failed";

  return (
    <section className="commissioning-workbench">
      <VirtualCommissioningWorkflowHeader
        scenes={scenes} sceneId={scene?.id ?? ""} robotOptions={robotOptions} robotModelId={robotModelId}
        selectionConfirmed={selectionConfirmed} stage={workflowStage}
        quickScreenDone={quickScreenDone} quickScreenHasIssues={quickScreenHasIssues}
        controlRunDone={controlRunDone} controlHasIssues={controlHasIssues} controlStudySaved={controlStudySaved}
        onSceneChange={changeScene} onRobotChange={changeRobot} onConfirm={confirmSelection} onStageChange={setWorkflowStage}
      />

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
          <button type="button" onClick={() => setError("")}>×</button>
        </div>
      )}
      {selectionConfirmed && scene && workflowStage === "screening" && (robotModelId ? (
        <RobotWorkcellAssistantPanel
          projectId={projectId}
          scene={scene}
          robotModelId={robotModelId}
          runWorkcellAudit={(_panelProjectId, input) => runRobotWorkcellAudit(input)}
          onSaveStudy={saveRobotScreening}
          onContinueValidation={continueRobotValidation}
          onOpenTarget={onOpenTarget}
        />
      ) : <WorkcellAuditPanel
        projectId={projectId}
        scene={scene}
        {...(currentWorkcellStudy ? { study: currentWorkcellStudy } : {})}
        onStudyChange={acceptStudy}
        onAuditComplete={(auditResult) => { if (auditResult.status === "passed") setWorkflowStage("control"); }}
        onContinueValidation={() => setWorkflowStage("control")}
        onOpenTarget={onOpenTarget}
      />)}
      {!scenes.length ? (
        <div className="commissioning-empty">
          <strong>没有可调试场景</strong>
          <span>先在三维工作区创建场景和设备，再回来配置控制信号。</span>
        </div>
      ) : selectionConfirmed && scene && workflowStage === "control" ? (
        <VirtualCommissioningControlStage
          scene={scene} objects={objects} bindings={bindings}
          durationMs={durationMs} tickMs={tickMs} speedSetpoint={speedSetpoint}
          faultEnabled={faultEnabled} faultAtMs={faultAtMs} resetEnabled={resetEnabled} resetAtMs={resetAtMs}
          acceptanceAtMs={acceptanceAtMs} acceptanceSignal={acceptanceSignal} acceptanceText={acceptanceText}
          busy={busy} onRunScenario={() => void runScenario()} onRunSuite={() => void runGoldenSuite()}
          onDurationChange={setDurationMs} onTickChange={setTickMs} onSpeedChange={setSpeedSetpoint}
          onFaultEnabledChange={setFaultEnabled} onFaultAtChange={setFaultAtMs}
          onResetEnabledChange={setResetEnabled} onResetAtChange={setResetAtMs}
          onAcceptanceAtChange={setAcceptanceAtMs} onAcceptanceSignalChange={setAcceptanceSignal} onAcceptanceTextChange={setAcceptanceText}
          onAddBinding={addBinding} onBindingChange={updateBinding}
          onBindingRemove={(id) => setBindings((current) => current.filter((item) => item.id !== id))}
        />
      ) : selectionConfirmed && workflowStage === "result" ? <VirtualCommissioningResultStage
        invocation={invocation} suiteResult={suiteInvocation?.output} previousResult={currentVirtualStudy?.latestResult}
        playheadMs={playheadMs} onInspectSuiteCase={inspectSuiteCase} onExportSuite={exportSuiteEvidence}
        onPlayheadChange={setPlayheadMs} onExportEvidence={exportEvidence} onOpenTarget={onOpenTarget}
        onEditCase={() => setWorkflowStage("control")} onCheckTask={() => setWorkflowStage("screening")}
      /> : null}
    </section>
  );
}

function genericWorkcellStudy(study: IndustrialValidationStudyRecord | undefined, sceneId: string) {
  const matching = matchingWorkcellStudy(study, sceneId);
  return matching && !matchingRobotWorkcellStudy(matching, sceneId) ? matching : undefined;
}

function initialRobotId(
  scene: SceneSnapshot | undefined,
  study: IndustrialValidationStudyRecord | undefined,
  preferredObjectId?: string,
) {
  if (!scene) return "";
  const robotStudy = matchingRobotWorkcellStudy(study, scene.id);
  if (study?.sourceKind === "workcell-audit" && !robotStudy) return "";
  const preferredRobot = scene.models.find(
    (model) => model.modelId === preferredObjectId && model.rig?.robot?.enabled,
  );
  if (!robotStudy && preferredRobot) return preferredRobot.modelId;
  return scene.models.find((model) => model.rig?.robot?.enabled && (!robotStudy || robotStudy.objectIds.includes(model.modelId)))?.modelId ?? "";
}
