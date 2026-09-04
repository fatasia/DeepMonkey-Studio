import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, AlertTriangle, CheckCircle2, Database, FileUp, LoaderCircle, RefreshCw } from "lucide-react";
import type {
  AiDataBinding,
  IndustrialDiagnosisResult,
  IndustrialStudyRecord,
  IndustrialValidationStudyRecord,
  DataDatasetRecord,
  MaintenanceAssessmentRecord,
  MaintenanceModelPackage,
  PlantLiteStudyRequest,
  ProjectRecord,
  SceneSnapshot,
} from "@bim-studio/contracts";
import { api, type IotNbAssessmentResult, type OperationsSnapshot } from "../api";
import { plantLiteRequestFromStudy, readPlantLiteDraft, writePlantLiteDraft } from "./plantLiteDraftPersistence";
import { VirtualCommissioningWorkbench } from "./VirtualCommissioningWorkbench";
import { MaintenanceDiagnosisCard } from "./MaintenanceDiagnosisCard";
import { BatteryIntelligencePanel } from "./BatteryIntelligencePanel";
import {
  AssessmentCard,
  defaultLogistics,
  defaultPlantLite,
  MaintenanceModelOnboarding,
  ModelEvidence,
  OperationsEmpty,
  OperationsHeader,
  OperationsTabs,
  parseEnergy,
  type OperationsTab,
} from "./operationsPresentation";
import {
  EnergyOperationsPanel,
  LogisticsOperationsPanel,
  MaintenanceCasesPanel,
  type LogisticsStudyMode,
} from "./OperationsScenarioPanels";
import type { CapabilityInvocationResult } from "../api";
import {
  resolveDiagnosisValidationScene,
  saveDiagnosisValidationStudy,
} from "./validationStudyClient";
import { WhatIfOperatingEnvelopePanel } from "./WhatIfOperatingEnvelopePanel";
import { AiDataRunPolicyFields, type AiDataRunPolicyDraft } from "./AiDataRunPolicyFields";
import { AiDataRunHistory } from "./AiDataRunHistory";
import type { WhatIfStudyRequest } from "@bim-studio/studio-core";
import { OperationsStudyHistory } from "./OperationsStudyHistory";
import { resolveOperationsStudyAction } from "./operationsStudyAction";
import { EMPTY_ENERGY_FIELD_MAP, energyObservationsFromPreview, inferEnergyFieldMap, type EnergyFieldMap } from "./energyDatasetMapping";
import { usePlantLiteRunController } from "./plantLiteRunController";

const DEFAULT_MAINTENANCE_POLICY: AiDataRunPolicyDraft = {
  mode: "interval",
  intervalSeconds: 60,
  windowRows: 60,
  minimumSamples: 30,
  maxAgeSeconds: 300,
  maximumMissingRate: 0.2,
  entityField: "",
  timeField: "",
};

export function OperationsCenter({
  project,
  scenes,
  onOpenSceneTarget,
  onBack,
  initialTab = "maintenance",
  onTabChange,
  onOpenDataCenter,
  embedded = false,
  initialSceneId,
  initialObjectId,
  initialCommissioningStage,
  previewSnapshot,
}: {
  project: ProjectRecord;
  scenes: SceneSnapshot[];
  onOpenSceneTarget: (sceneId: string, objectId: string) => void;
  onBack: () => void;
  initialTab?: OperationsTab;
  onTabChange?: (tab: OperationsTab) => void;
  onOpenDataCenter: () => void;
  embedded?: boolean;
  initialSceneId?: string;
  initialObjectId?: string;
  initialCommissioningStage?: "screening" | "control";
  previewSnapshot?: OperationsSnapshot;
}) {
  const [tab, setTab] = useState<OperationsTab>(initialTab);
  const [mountedTabs, setMountedTabs] = useState<Set<OperationsTab>>(() => new Set([initialTab]));
  const [snapshot, setSnapshot] = useState<OperationsSnapshot | undefined>(previewSnapshot);
  const [selectedModelId, setSelectedModelId] = useState("");
  const [logistics, setLogistics] = useState(defaultLogistics);
  const [plantLite, setPlantLite] = useState(() => readPlantLiteDraft(project.id) ?? structuredClone(defaultPlantLite));
  const [logisticsMode, setLogisticsMode] = useState<LogisticsStudyMode>("analytic");
  const [energyText, setEnergyText] = useState("");
  const [energySourceMode, setEnergySourceMode] = useState<"dataset" | "paste">("dataset");
  const [energyDatasetId, setEnergyDatasetId] = useState("");
  const [energyFieldMap, setEnergyFieldMap] = useState<EnergyFieldMap>(EMPTY_ENERGY_FIELD_MAP);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [syncMessage, setSyncMessage] = useState("");
  const [assessmentSource, setAssessmentSource] = useState<IotNbAssessmentResult["source"]>();
  const [datasets, setDatasets] = useState<DataDatasetRecord[]>([]);
  const [dataBindings, setDataBindings] = useState<AiDataBinding[]>([]);
  const [maintenanceDatasetId, setMaintenanceDatasetId] = useState("");
  const [maintenancePolicy, setMaintenancePolicy] = useState(DEFAULT_MAINTENANCE_POLICY);
  const [diagnosis, setDiagnosis] = useState<CapabilityInvocationResult<IndustrialDiagnosisResult>>();
  const [commissioningDraft, setCommissioningDraft] = useState<IndustrialDiagnosisResult["validationDraft"]>();
  const [commissioningStudy, setCommissioningStudy] = useState<IndustrialValidationStudyRecord>();
  const modelImport = useRef<HTMLInputElement>(null);
  const artifactImport = useRef<HTMLInputElement>(null);
  const activeProjectId = useRef(project.id);
  const hydratedPlantLiteProjectId = useRef("");
  activeProjectId.current = project.id;

  const models = snapshot?.models ?? [];
  const selectedModel = useMemo(
    () => models.find((item) => item.id === selectedModelId) ?? models[0],
    [models, selectedModelId],
  );
  const latestAssessment = snapshot?.assessments.find((item) => item.modelId === selectedModel?.id);
  const latestDeployment = snapshot?.deployments.find((item) => item.id === latestAssessment?.deploymentId);
  const configuredDeployment = snapshot?.deployments.find(
    (item) => item.modelId === selectedModel?.id && item.sourceId === maintenanceDatasetId,
  );
  const latestValidationStudy = commissioningStudy ?? (embedded ? undefined : snapshot?.validationStudies[0]);

  useEffect(() => {
    setTab(initialTab);
    setMountedTabs((current) => current.has(initialTab) ? current : new Set([...current, initialTab]));
  }, [initialTab]);

  function selectTab(nextTab: OperationsTab) {
    setMountedTabs((current) => current.has(nextTab) ? current : new Set([...current, nextTab]));
    setTab(nextTab);
    onTabChange?.(nextTab);
  }

  async function load(preferredModelId?: string) {
    const requestedProjectId = project.id;
    const next = await api.getOperations(requestedProjectId);
    if (activeProjectId.current !== requestedProjectId) return;
    setSnapshot(next);
    if (hydratedPlantLiteProjectId.current !== requestedProjectId) {
      hydratedPlantLiteProjectId.current = requestedProjectId;
      const recovered = next.plantLiteStudies.map(plantLiteRequestFromStudy).find((value) => value !== undefined);
      if (recovered) {
        setPlantLite(recovered);
        writePlantLiteDraft(requestedProjectId, recovered);
      }
    }
    setSelectedModelId((current) =>
      next.models.some((item) => item.id === preferredModelId)
        ? preferredModelId!
        : next.models.some((item) => item.id === current)
          ? current
          : (next.models[0]?.id ?? ""),
    );
  }
  useEffect(() => {
    const requestedProjectId = project.id;
    if (previewSnapshot) {
      setSnapshot(previewSnapshot);
      return;
    }
    setSnapshot(undefined);
    const draft = readPlantLiteDraft(requestedProjectId);
    hydratedPlantLiteProjectId.current = draft ? requestedProjectId : "";
    setPlantLite(draft ?? structuredClone(defaultPlantLite));
    void (async () => {
      const [syncResult, datasetResult, bindingResult] = await Promise.allSettled([
        api.syncIotNbMaintenanceModels(requestedProjectId),
        api.listDatasets(requestedProjectId),
        api.listAiDataBindings(requestedProjectId),
      ]);
      if (activeProjectId.current !== requestedProjectId) return;
      if (syncResult.status === "fulfilled") {
        setSyncMessage(`已连接 ${syncResult.value.sourceProjectName} · ${syncResult.value.models.length} 个真实训练模型`);
      }
      if (datasetResult.status === "fulfilled") setDatasets(datasetResult.value);
      else showError(datasetResult.reason);
      if (bindingResult.status === "fulfilled") setDataBindings(bindingResult.value);
      await load().catch(showError);
    })();
  }, [previewSnapshot, project.id]);

  function changePlantLite(next: PlantLiteStudyRequest) {
    hydratedPlantLiteProjectId.current = project.id;
    setPlantLite(next);
    writePlantLiteDraft(project.id, next);
  }

  useEffect(() => {
    const dataset = datasets.find((item) => item.id === energyDatasetId) ?? datasets[0];
    if (!dataset) {
      setEnergyDatasetId("");
      setEnergyFieldMap(EMPTY_ENERGY_FIELD_MAP);
      return;
    }
    if (dataset.id !== energyDatasetId) setEnergyDatasetId(dataset.id);
    setEnergyFieldMap(inferEnergyFieldMap(dataset.fields));
  }, [datasets, energyDatasetId]);

  useEffect(() => {
    const deployment = snapshot?.deployments.find(
      (item) => item.modelId === selectedModel?.id && item.sourceId === maintenanceDatasetId,
    );
    const binding = deployment?.bindingId
      ? dataBindings.find((item) => item.id === deployment.bindingId)
      : undefined;
    if (!binding) {
      const dataset = datasets.find((item) => item.id === maintenanceDatasetId);
      setMaintenancePolicy({
        ...DEFAULT_MAINTENANCE_POLICY,
        intervalSeconds: Math.max(1, dataset?.refreshSeconds || 60),
        windowRows: Math.max(selectedModel?.gates.minimumSamples ?? 30, Number(selectedModel?.artifact.window ?? 60)),
        minimumSamples: selectedModel?.gates.minimumSamples ?? 30,
      });
      return;
    }
    setMaintenancePolicy({
      mode: binding.trigger.type === "interval" ? "interval" : "manual",
      intervalSeconds: binding.trigger.type === "interval" ? binding.trigger.seconds : 60,
      windowRows: binding.window.rows ?? 60,
      minimumSamples: binding.quality.minimumSamples,
      maxAgeSeconds: binding.quality.maxAgeSeconds,
      maximumMissingRate: binding.quality.maximumMissingRate,
      entityField: binding.entity?.keyField ?? "",
      timeField: binding.time?.field ?? "",
    });
  }, [dataBindings, datasets, maintenanceDatasetId, selectedModel, snapshot?.deployments]);
  function showError(reason: unknown) {
    setError(reason instanceof Error ? reason.message : String(reason));
  }
  const plantLiteRun = usePlantLiteRunController({
    projectId: project.id,
    reload: load,
    setBusy,
    setError,
  });
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (reason) {
      showError(reason);
    } finally {
      setBusy(false);
    }
  }

  async function runMaintenance() {
    await run(async () => {
      if (!selectedModel) throw new Error("没有可运行模型，请先同步 Iot-nb 或导入训练模型");
      if (maintenanceDatasetId) {
        const existing = snapshot?.deployments.find(
          (item) => item.modelId === selectedModel.id && item.sourceId === maintenanceDatasetId,
        );
        const dataset = datasets.find((item) => item.id === maintenanceDatasetId);
        if (!dataset) throw new Error("选择的数据集已删除，请重新选择");
        const existingBinding = existing?.bindingId
          ? dataBindings.find((item) => item.id === existing.bindingId)
          : undefined;
        const binding = await api.saveAiDataBinding(project.id, {
          ...(existingBinding ? { id: existingBinding.id } : {}),
          name: `${selectedModel.name} · ${dataset.name}`,
          datasetId: dataset.id,
          capabilityId: "operations.maintenance.assess",
          status: "active",
          ...(maintenancePolicy.entityField ? { entity: { keyField: maintenancePolicy.entityField } } : {}),
          ...(maintenancePolicy.timeField ? { time: { field: maintenancePolicy.timeField, order: "asc" } } : {}),
          features: selectedModel.artifact.features.map((feature) => ({ modelField: feature, sourceField: feature, required: true })),
          window: { rows: maintenancePolicy.windowRows },
          trigger: maintenancePolicy.mode === "interval"
            ? { type: "interval", seconds: maintenancePolicy.intervalSeconds }
            : { type: "manual" },
          quality: {
            minimumSamples: maintenancePolicy.minimumSamples,
            maxAgeSeconds: maintenancePolicy.maxAgeSeconds,
            maximumMissingRate: maintenancePolicy.maximumMissingRate,
          },
          retry: { maxAttempts: 3, backoffSeconds: 5 },
          output: { type: "case", caseType: "predictive-maintenance" },
        });
        const deployment = await api.saveMaintenanceDeployment(project.id, {
          ...(existing ? { id: existing.id } : {}),
          name: `${selectedModel.name} · ${dataset.name}`,
          modelId: selectedModel.id,
          equipmentId: dataset.name,
          maintainableUnitId: dataset.id,
          objectIds: [],
          sourceId: dataset.id,
          bindingId: binding.id,
          featureMappings: Object.fromEntries(selectedModel.artifact.features.map((feature) => [feature, feature])),
          sampleIntervalSec: maintenancePolicy.intervalSeconds,
          windowSize: maintenancePolicy.windowRows,
          enabled: true,
          status: selectedModel.productionEligible ? "running" : "shadow",
        });
        await api.assessMaintenanceDataset(project.id, deployment.id, dataset.id);
        setDataBindings(await api.listAiDataBindings(project.id));
        setAssessmentSource(undefined);
        setDiagnosis(undefined);
        await load(selectedModel.id);
        return;
      }
      if (selectedModel.source !== "iot-nb")
        throw new Error("请选择数据中心的现场数据集后运行该模型");
      const result = await api.assessIotNbMaintenanceModel(project.id, selectedModel.id);
      setAssessmentSource(result.source);
      setDiagnosis(undefined);
      setCommissioningDraft(undefined);
      setCommissioningStudy(undefined);
      await load(selectedModel.id);
    });
  }

  async function syncIotNb() {
    await run(async () => {
      const result = await api.syncIotNbMaintenanceModels(project.id);
      setSyncMessage(`同步完成：新增 ${result.imported}，更新 ${result.updated} · ${result.sourceProjectName}`);
      await load(result.models[0]?.id);
    });
  }

  async function importModel(file: File | undefined) {
    if (!file) return;
    await run(async () => {
      const value = JSON.parse(await file.text()) as Partial<MaintenanceModelPackage>;
      const model = await api.importMaintenanceModel(project.id, value);
      await load(model.id);
    });
    if (modelImport.current) modelImport.current.value = "";
  }

  async function uploadArtifact(file: File | undefined) {
    if (!file || !selectedModel) return;
    await run(async () => {
      await api.uploadMaintenanceArtifact(project.id, selectedModel.id, file);
      await load(selectedModel.id);
    });
    if (artifactImport.current) artifactImport.current.value = "";
  }

  async function createMaintenanceCase(assessment: MaintenanceAssessmentRecord) {
    await run(async () => {
      await api.saveOperationalCase(project.id, {
        type: "maintenance",
        title: `维护评估：${assessment.riskLevel === "critical" ? "高风险" : "重点关注"}`,
        severity: assessment.riskLevel === "critical" ? "critical" : "warning",
        status: "triage",
        owner: "设备工程师",
        sourceRefs: [assessment.id],
        hypothesis: assessment.topContributors.map((item) => `${item.feature} 偏离贡献 ${item.value}`),
        suggestedActions: ["现场点检关键部件", "核对传感器与工况", "确认后安排维护窗口"],
      });
      await load();
    });
  }

  async function createDiagnosisCase(assessment: MaintenanceAssessmentRecord, result: IndustrialDiagnosisResult) {
    await run(async () => {
      await api.saveOperationalCase(project.id, {
        type: "maintenance",
        title: result.headline,
        severity: result.severity === "critical" ? "critical" : "warning",
        status: "triage",
        owner: "设备工程师",
        objectRefs: latestDeployment?.objectIds ?? [],
        sourceRefs: [assessment.id, result.evidenceFingerprint],
        hypothesis: result.hypotheses.map((item) => `${item.rank}. ${item.title}：${item.rationale}`),
        suggestedActions: result.actions.map((item) => `${item.label}：${item.reason}`),
      });
      await load();
    });
  }

  async function diagnoseMaintenance(assessment: MaintenanceAssessmentRecord) {
    if (!selectedModel) return;
    await run(async () => {
      const deployment = snapshot?.deployments.find((item) => item.id === assessment.deploymentId);
      const result = await api.invokeCapability<IndustrialDiagnosisResult>(
        project.id,
        "industrial.ai.diagnosis.compose",
        {
          assessment,
          model: {
            id: selectedModel.id,
            name: selectedModel.name,
            version: selectedModel.version,
            algorithm: selectedModel.algorithm,
            modelKind: selectedModel.artifact.modelKind,
            benchmarkOnly: selectedModel.benchmarkOnly,
            productionEligible: selectedModel.productionEligible,
          },
          ...(deployment
            ? {
                asset: {
                  id: deployment.equipmentId,
                  name: deployment.name,
                  ...(deployment.sceneId ? { sceneId: deployment.sceneId } : {}),
                  objectIds: deployment.objectIds,
                },
              }
            : {}),
        },
      );
      if (!result.output) throw new Error(result.error?.message ?? "AI 诊断没有返回结构化结论");
      setDiagnosis(result);
    });
  }

  async function openDiagnosisValidation(
    assessment: MaintenanceAssessmentRecord,
    result: IndustrialDiagnosisResult,
  ) {
    await run(async () => {
      const existing = snapshot?.validationStudies.find((item) =>
        item.sourceRefs.includes(result.evidenceFingerprint),
      );
      const draft = result.validationDraft;
      const fallbackSceneId = resolveDiagnosisValidationScene(
        latestDeployment?.sceneId,
        scenes.map((scene) => scene.id),
      );
      const study = await saveDiagnosisValidationStudy({
        projectId: project.id,
        assessment,
        diagnosis: result,
        ...(existing ? { existing } : {}),
        ...(fallbackSceneId ? { fallbackSceneId } : {}),
        fallbackObjectIds: latestDeployment?.objectIds ?? [],
      });
      setCommissioningDraft(draft);
      setCommissioningStudy(study);
      await load();
      selectTab("commissioning");
    });
  }

  async function runLogistics() {
    await run(async () => {
      await api.runLogisticsExperiment(project.id, logistics);
      await load();
    });
  }
  async function reproduceLogistics(experimentId: string) {
    await run(async () => {
      await api.reproduceLogisticsExperiment(project.id, experimentId);
      await load();
    });
  }
  async function runWhatIfStudy(request: WhatIfStudyRequest) {
    await run(async () => {
      await api.runWhatIfStudy(project.id, request);
      await load();
    });
  }
  async function reproduceWhatIfStudy(studyId: string) {
    await run(async () => {
      await api.reproduceWhatIfStudy(project.id, studyId);
      await load();
    });
  }
  async function runEnergy() {
    await run(async () => {
      const observations = energySourceMode === "dataset"
        ? energyObservationsFromPreview(await api.previewDataset(project.id, energyDatasetId), energyFieldMap)
        : parseEnergy(energyText);
      await api.analyzeEnergy(project.id, observations);
      await load();
    });
  }

  function reproduceOrOpenStudy(study: IndustrialStudyRecord) {
    const action = resolveOperationsStudyAction(study);
    if (action.kind === "reproduce-plant-lite") {
      void plantLiteRun.reproduce(action.sourceRecordId);
      return;
    }
    if (action.kind === "reproduce-what-if") {
      void reproduceWhatIfStudy(action.sourceRecordId);
      return;
    }
    const validationStudy = snapshot?.validationStudies.find((item) => item.id === action.sourceRecordId);
    if (!validationStudy) {
      showError("源运行记录已不存在，请刷新后重试");
      return;
    }
    setCommissioningDraft(undefined);
    setCommissioningStudy(validationStudy);
    selectTab("commissioning");
  }

  return (
    <main className={`operations-page${embedded ? " operations-page-embedded" : ""}`}>
      {!embedded && <OperationsHeader project={project} snapshot={snapshot} onBack={onBack} />}
      {!embedded && <OperationsTabs tab={tab} onChange={selectTab} />}
      {error && (
        <div className="vision-error">
          <AlertTriangle size={15} />
          <span>{error}</span>
          <button onClick={() => setError("")}>×</button>
        </div>
      )}
      <section className="operations-content">
        {mountedTabs.has("maintenance") && (
          <div hidden={tab !== "maintenance"}>
            <div className="operations-grid">
            <section className="operations-panel">
              <header>
                <div>
                  <strong>模型与生产数据</strong>
                  <small>模型只读取所选数据集快照；接口、数据库、Kafka 与现场协议共用同一条可追溯链路。</small>
                </div>
                <button
                  className="button primary"
                  disabled={busy || !selectedModel || selectedModel.status === "awaiting-artifact"}
                  onClick={() => void runMaintenance()}
                >
                  {busy ? <LoaderCircle className="spin" size={15} /> : <Activity size={15} />}
                  {maintenanceDatasetId ? "运行现场评估" : "运行源数据验证"}
                </button>
              </header>
              {!models.length ? (
                <>
                  <MaintenanceModelOnboarding
                    busy={busy}
                    onSync={() => void syncIotNb()}
                    onImport={() => modelImport.current?.click()}
                    onOpenDataCenter={onOpenDataCenter}
                  />
                  <input
                    ref={modelImport}
                    hidden
                    type="file"
                    accept=".json"
                    onChange={(event) => void importModel(event.target.files?.[0])}
                  />
                </>
              ) : <>
              <label>
                <span>维护模型</span>
                <select
                  value={selectedModel?.id ?? ""}
                  onChange={(event) => {
                    setSelectedModelId(event.target.value);
                    setAssessmentSource(undefined);
                    setDiagnosis(undefined);
                    setCommissioningDraft(undefined);
                    setCommissioningStudy(undefined);
                  }}
                >
                  <option value="">没有可执行模型</option>
                  {models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name} · {model.artifact.engine === "onnx" ? "ONNX" : "训练权重"} ·{" "}
                      {model.productionEligible ? "现场可用" : "影子验证"}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>运行数据源</span>
                <select value={maintenanceDatasetId} onChange={(event) => {
                  setMaintenanceDatasetId(event.target.value);
                  setAssessmentSource(undefined);
                  setDiagnosis(undefined);
                }}>
                  <option value="">{selectedModel?.source === "iot-nb" ? "Iot-nb 模型关联源数据" : "请选择现场数据集"}</option>
                  {datasets.map((dataset) => <option key={dataset.id} value={dataset.id}>{dataset.name}</option>)}
                </select>
                <small>数据源连接与字段在数据中心统一管理，模型部署只保存字段映射，不保存密码。</small>
              </label>
              {maintenanceDatasetId && (
                <>
                  <AiDataRunPolicyFields
                    value={maintenancePolicy}
                    fields={datasets.find((item) => item.id === maintenanceDatasetId)?.fields ?? []}
                    onChange={setMaintenancePolicy}
                  />
                  <AiDataRunHistory
                    projectId={project.id}
                    {...(configuredDeployment?.bindingId ? { bindingId: configuredDeployment.bindingId } : {})}
                  />
                </>
              )}
              <div className="operations-inline-actions">
                <button onClick={() => void syncIotNb()} disabled={busy}>
                  <RefreshCw size={14} />
                  同步 Iot-nb 当前工程
                </button>
                <button onClick={() => modelImport.current?.click()}>
                  <FileUp size={14} />
                  导入训练模型 JSON
                </button>
                <input
                  ref={modelImport}
                  hidden
                  type="file"
                  accept=".json"
                  onChange={(event) => void importModel(event.target.files?.[0])}
                />
                {selectedModel?.artifact.engine === "onnx" && selectedModel.status === "awaiting-artifact" && (
                  <>
                    <button onClick={() => artifactImport.current?.click()}>
                      <FileUp size={14} />
                      上传 ONNX 制品
                    </button>
                    <input
                      ref={artifactImport}
                      hidden
                      type="file"
                      accept=".onnx"
                      onChange={(event) => void uploadArtifact(event.target.files?.[0])}
                    />
                  </>
                )}
              </div>
              {syncMessage && (
                <p className="operations-sync-ok">
                  <CheckCircle2 size={14} />
                  {syncMessage}
                </p>
              )}
              {selectedModel && <ModelEvidence model={selectedModel} />}
              {selectedModel?.benchmarkOnly && (
                <p className="operations-notice">
                  <AlertTriangle size={14} />
                  这是已训练、可执行的真实模型，但训练数据是公开/合成基准，只允许影子验证，不能冒充现场生产模型。
                </p>
              )}
              {selectedModel?.status === "awaiting-artifact" && (
                <p className="operations-notice">
                  <AlertTriangle size={14} />
                  模型定义已导入，请上传对应 ONNX 文件并通过运行时校验。
                </p>
              )}
              {latestAssessment ? (
                <>
                  <AssessmentCard
                    assessment={latestAssessment}
                    onDiagnose={() => void diagnoseMaintenance(latestAssessment)}
                    onCase={() => void createMaintenanceCase(latestAssessment)}
                    busy={busy}
                  />
                  {diagnosis?.output && (
                    <MaintenanceDiagnosisCard
                      diagnosis={diagnosis.output}
                      busy={busy}
                      canFocus={Boolean(latestDeployment?.sceneId && latestDeployment.objectIds[0])}
                      onCreateCase={() => void createDiagnosisCase(latestAssessment, diagnosis.output!)}
                      onOpenValidation={() => {
                        void openDiagnosisValidation(latestAssessment, diagnosis.output!);
                      }}
                      onFocus={() => {
                        const objectId = latestDeployment?.objectIds[0];
                        if (latestDeployment?.sceneId && objectId)
                          onOpenSceneTarget(latestDeployment.sceneId, objectId);
                      }}
                    />
                  )}
                  {assessmentSource && (
                    <p className="operations-source-proof">
                      <Database size={14} />
                      本次实际读取：{assessmentSource.projectName} / {assessmentSource.datasetName} /{" "}
                      {assessmentSource.rowCount} 行
                    </p>
                  )}
                  {latestAssessment.sourceEvidence && (
                    <p className="operations-source-proof">
                      <Database size={14} />
                      本次实际读取：{latestAssessment.sourceEvidence.datasetName} · {latestAssessment.sourceEvidence.connectionType} · {latestAssessment.sourceEvidence.rowCount} 行
                    </p>
                  )}
                </>
              ) : (
                <div className="operations-ready-empty">
                  <OperationsEmpty text={maintenanceDatasetId ? "数据与模型已就绪，运行评估后将在这里显示风险、依据和下一步动作。" : "选择已连接的生产数据集后运行；系统只读取真实快照，不会补演示数据。"} />
                  {!maintenanceDatasetId && (
                    <button onClick={onOpenDataCenter}><Database size={14} />前往数据中心连接数据库</button>
                  )}
                </div>
              )}
              </>}
            </section>
            <MaintenanceCasesPanel snapshot={snapshot} />
            </div>
          </div>
        )}
        {mountedTabs.has("commissioning") && (
          <div hidden={tab !== "commissioning"}>
            <VirtualCommissioningWorkbench
              projectId={project.id}
              scenes={scenes}
              studies={snapshot?.validationStudies ?? []}
              {...(initialSceneId ? { initialSceneId } : {})}
              {...(initialObjectId ? { initialObjectId } : {})}
              {...(initialCommissioningStage ? { initialStage: initialCommissioningStage } : {})}
              {...(commissioningDraft ? { initialDraft: commissioningDraft } : {})}
              {...(latestValidationStudy ? { initialStudy: latestValidationStudy } : {})}
              onStudyChange={(study) => {
                setCommissioningStudy(study);
                void load().catch(showError);
              }}
              onOpenTarget={onOpenSceneTarget}
            />
          </div>
        )}
        {mountedTabs.has("battery") && (
          <div hidden={tab !== "battery"}><BatteryIntelligencePanel projectId={project.id} /></div>
        )}
        {mountedTabs.has("logistics") && (
          <div hidden={tab !== "logistics"}>
            <LogisticsOperationsPanel
              busy={busy}
              logistics={logistics}
              plantLite={plantLite}
              mode={logisticsMode}
              snapshot={snapshot}
              onChange={setLogistics}
              onPlantLiteChange={changePlantLite}
              onModeChange={setLogisticsMode}
              onRun={() => void runLogistics()}
              onRunPlantLite={() => void plantLiteRun.run(plantLite)}
              onRunPlantLiteSweep={(requests) => void plantLiteRun.runBatch(requests)}
              {...(plantLiteRun.progress ? { plantRunProgress: plantLiteRun.progress } : {})}
              {...(plantLiteRun.notice ? { plantRunNotice: plantLiteRun.notice } : {})}
              onCancelPlantLite={plantLiteRun.cancel}
              onReproduce={(experimentId) => void reproduceLogistics(experimentId)}
              onReproducePlantLite={(studyId) => void plantLiteRun.reproduce(studyId)}
              project={project}
              scenes={scenes}
              datasets={datasets}
              loadDatasetPreview={(datasetId) => api.previewDataset(project.id, datasetId)}
            />
          </div>
        )}
        {mountedTabs.has("energy") && (
          <div hidden={tab !== "energy"}>
            <EnergyOperationsPanel
              busy={busy}
              datasets={datasets}
              sourceMode={energySourceMode}
              datasetId={energyDatasetId}
              fieldMap={energyFieldMap}
              energyText={energyText}
              snapshot={snapshot}
              onSourceModeChange={setEnergySourceMode}
              onDatasetChange={setEnergyDatasetId}
              onFieldMapChange={setEnergyFieldMap}
              onChange={setEnergyText}
              onRun={() => void runEnergy()}
            />
          </div>
        )}
        {mountedTabs.has("whatif") && (
          <div hidden={tab !== "whatif"}>
            <WhatIfOperatingEnvelopePanel
              results={snapshot?.whatIfStudies ?? []}
              busy={busy}
              onRun={(request) => void runWhatIfStudy(request)}
              onReproduce={(studyId) => void reproduceWhatIfStudy(studyId)}
            />
          </div>
        )}
        {!embedded && <OperationsStudyHistory
          records={snapshot?.studies ?? []}
          busy={busy}
          onReproduce={reproduceOrOpenStudy}
          onOpenTarget={onOpenSceneTarget}
        />}
      </section>
    </main>
  );
}
