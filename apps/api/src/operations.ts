import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import * as ort from "onnxruntime-node";
import type {
  DataSourceEvidence,
  EnergyInsightRecord,
  EnergyObservation,
  IndustrialStudyRecord,
  IndustrialValidationStudyRecord,
  LogisticsExperimentRequest,
  LogisticsExperimentResult,
  MaintenanceAssessmentRecord,
  MaintenanceDeploymentRecord,
  MaintenanceModelPackage,
  MaintenanceShadowEvaluation,
  OperationalCaseRecord,
  PlantLiteStudyRecord,
  PlantLiteStudyRequest,
  SaveIndustrialValidationStudyInput
} from "@bim-studio/contracts";
import type { WhatIfStudyRecord, WhatIfStudyRequest } from "@bim-studio/studio-core";
import { DEFAULT_MAINTENANCE_GATES } from "./maintenanceModelDefaults.js";
import { archiveLegacyOperationsImports } from "./operationsLegacyImportMigration.js";
import {
  analyzeEnergy,
  buildMaintenanceAssessment,
  evaluateMaintenanceShadow,
  evidenceFingerprint,
  prepareMaintenanceWindow,
  runLogisticsExperiment,
  scoreNativeArtifact
} from "./operationsEngine.js";
import { buildValidationStudyRecord } from "./validationStudy.js";
import { reproduceWhatIfStudy, runWhatIfStudy } from "./whatIfStudy.js";
import { plantLiteRequestFromRecord } from "./plantLiteStudy.js";
import { PlantLiteWorkerExecutionError, PlantLiteWorkerExecutor, type PlantLiteStudyExecutor } from "./plantLiteWorkerExecutor.js";
import { buildOperationsStudyIndex } from "./operationsStudyIndex.js";
import { plantLiteStudiesForOperationsSnapshot } from "./operationsSnapshot.js";
import {
  compactError,
  compactRecords,
  finiteInteger,
  inferredValidationStudyType,
  logisticsRequestFromResult,
  plantLiteStudyRecordIssue,
  requiredText,
} from "./operationsRecordUtilities.js";

interface OperationsProjectState {
  models: MaintenanceModelPackage[];
  deployments: MaintenanceDeploymentRecord[];
  assessments: MaintenanceAssessmentRecord[];
  shadowEvaluations: MaintenanceShadowEvaluation[];
  cases: OperationalCaseRecord[];
  logisticsExperiments: LogisticsExperimentResult[];
  plantLiteStudies: PlantLiteStudyRecord[];
  energyInsights: EnergyInsightRecord[];
  validationStudies: IndustrialValidationStudyRecord[];
  whatIfStudies: WhatIfStudyRecord[];
}

export interface OperationsDocument {
  schemaVersion: 1;
  projects: Record<string, OperationsProjectState>;
}

export class OperationsService {
  private readonly filePath: string;
  private document: OperationsDocument = { schemaVersion: 1, projects: {} };
  private writeChain = Promise.resolve();
  private readonly onnxSessions = new Map<string, Promise<ort.InferenceSession>>();

  private readonly plantLiteExecutor: PlantLiteStudyExecutor;

  constructor(private readonly dataDir: string, options: { plantLiteExecutor?: PlantLiteStudyExecutor } = {}) {
    this.filePath = path.join(dataDir, "operations.json");
    this.plantLiteExecutor = options.plantLiteExecutor ?? new PlantLiteWorkerExecutor();
  }

  async init(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<OperationsDocument>;
      this.document = { schemaVersion: 1, projects: parsed.projects ?? {} };
      if (await archiveLegacyOperationsImports(this.dataDir, this.document)) await this.persist();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.persist();
    }
  }

  snapshot(projectId: string): OperationsProjectState & { studies: IndustrialStudyRecord[] } {
    const state = this.project(projectId);
    return structuredClone({ ...state, studies: buildOperationsStudyIndex(state) });
  }

  snapshotForApi(projectId: string): OperationsProjectState & { studies: IndustrialStudyRecord[] } {
    const state = this.project(projectId);
    return structuredClone({
      ...state,
      plantLiteStudies: plantLiteStudiesForOperationsSnapshot(state.plantLiteStudies),
      studies: buildOperationsStudyIndex(state),
    });
  }

  async importModel(projectId: string, source: Partial<MaintenanceModelPackage>): Promise<MaintenanceModelPackage> {
    return this.mutate(projectId, (state) => {
      const now = new Date().toISOString();
      const artifact = source.artifact;
      if (!artifact?.features?.length) throw new Error("模型包必须包含 artifact.features");
      if (artifact.engine === "native-json" && (!artifact.weights?.length || artifact.weights.length !== artifact.features.length)) {
        throw new Error("native-json 模型必须提供与 features 对齐的 weights");
      }
      const model: MaintenanceModelPackage = {
        id: source.id ?? randomUUID(), projectId,
        name: requiredText(source.name, "模型名称"), version: requiredText(source.version, "模型版本"),
        algorithm: source.algorithm?.trim() || "Imported model", source: source.source ?? "imported",
        status: artifact.engine === "onnx" ? "awaiting-artifact" : source.status === "validated" ? "validated" : "candidate",
        benchmarkOnly: source.benchmarkOnly === true, productionEligible: source.productionEligible === true,
        evaluationProtocol: source.evaluationProtocol?.trim() || "待完成固定数据集回放与影子评测",
        dataFingerprint: source.dataFingerprint?.trim() || "unverified",
        trainRows: finiteInteger(source.trainRows, 0), validationRows: finiteInteger(source.validationRows, 0), metrics: source.metrics ?? {},
        artifact: structuredClone(artifact), gates: { ...DEFAULT_MAINTENANCE_GATES, ...source.gates },
        ...(source.approvedBy?.trim() ? { approvedBy: source.approvedBy.trim() } : {}), createdAt: now, updatedAt: now
      };
      const duplicate = state.models.find((item) => item.version === model.version);
      if (duplicate) throw new Error(`模型版本 ${model.version} 已存在`);
      state.models.push(model);
      return model;
    });
  }

  async uploadArtifact(projectId: string, modelId: string, payload: Buffer): Promise<MaintenanceModelPackage> {
    const model = this.requireModel(projectId, modelId);
    if (model.artifact.engine !== "onnx") throw new Error("只有 ONNX 模型包可以上传 ONNX 制品");
    const directory = path.join(this.dataDir, "projects", projectId, "operations", "models", modelId);
    await mkdir(directory, { recursive: true });
    const artifactPath = path.join(directory, "model.onnx");
    await writeFile(artifactPath, payload);
    try {
      await ort.InferenceSession.create(artifactPath, { executionProviders: ["cpu"] });
    } catch (error) {
      throw new Error(`ONNX 制品校验失败：${compactError(error)}`);
    }
    this.onnxSessions.delete(artifactPath);
    return this.mutate(projectId, (state) => {
      const current = state.models.find((item) => item.id === modelId);
      if (!current) throw new Error("维护模型不存在");
      current.artifactPath = artifactPath;
      current.status = current.productionEligible ? "validated" : "candidate";
      current.updatedAt = new Date().toISOString();
      return current;
    });
  }

  async saveDeployment(projectId: string, input: Partial<MaintenanceDeploymentRecord>): Promise<MaintenanceDeploymentRecord> {
    return this.mutate(projectId, (state) => {
      const now = new Date().toISOString();
      const modelId = requiredText(input.modelId, "模型");
      if (!state.models.some((item) => item.id === modelId)) throw new Error("部署引用的维护模型不存在");
      const existing = input.id ? state.deployments.find((item) => item.id === input.id) : undefined;
      const sceneId = input.sceneId ?? existing?.sceneId;
      const bindingId = input.bindingId?.trim() || existing?.bindingId;
      const deployment: MaintenanceDeploymentRecord = {
        id: existing?.id ?? randomUUID(), projectId,
        name: input.name?.trim() || existing?.name || "未命名维护部署", modelId,
        equipmentId: requiredText(input.equipmentId ?? existing?.equipmentId, "设备"),
        maintainableUnitId: requiredText(input.maintainableUnitId ?? existing?.maintainableUnitId, "可维护单元"),
        ...(sceneId ? { sceneId } : {}),
        objectIds: input.objectIds ?? existing?.objectIds ?? [], sourceId: input.sourceId?.trim() || existing?.sourceId || "manual-window",
        ...(bindingId ? { bindingId } : {}),
        featureMappings: input.featureMappings ?? existing?.featureMappings ?? {},
        sampleIntervalSec: finiteInteger(input.sampleIntervalSec ?? existing?.sampleIntervalSec, 60),
        windowSize: finiteInteger(input.windowSize ?? existing?.windowSize, 60), enabled: input.enabled ?? existing?.enabled ?? true,
        status: input.status ?? existing?.status ?? "shadow", ...(existing?.lastAssessmentId ? { lastAssessmentId: existing.lastAssessmentId } : {}),
        ...(existing?.lastRunAt ? { lastRunAt: existing.lastRunAt } : {}),
        ...(existing?.lastError ? { lastError: existing.lastError } : {}),
        ...(existing?.consecutiveFailures ? { consecutiveFailures: existing.consecutiveFailures } : {}),
        createdAt: existing?.createdAt ?? now, updatedAt: now
      };
      if (existing) Object.assign(existing, deployment); else state.deployments.push(deployment);
      return deployment;
    });
  }

  async assess(
    projectId: string,
    deploymentId: string,
    sourceRows: Array<Record<string, number>>,
    sourceEvidence?: DataSourceEvidence,
  ): Promise<MaintenanceAssessmentRecord> {
    const state = this.project(projectId);
    const deployment = state.deployments.find((item) => item.id === deploymentId);
    if (!deployment) throw new Error("维护部署不存在");
    const model = state.models.find((item) => item.id === deployment.modelId);
    if (!model) throw new Error("维护模型不存在");
    if (model.status === "awaiting-artifact") throw new Error("ONNX 模型尚未上传制品");
    const window = prepareMaintenanceWindow(model, deployment, sourceRows);
    let score: number | undefined;
    if (window.rows.length >= model.gates.minimumSamples && window.dataQuality >= model.gates.minimumDataQuality && window.driftScore <= model.gates.maximumDriftSigma) {
      score = model.artifact.engine === "onnx" ? await this.scoreOnnx(model, window.rows) : scoreNativeArtifact(model.artifact, window.rows.at(-1)!);
    }
    const assessment = buildMaintenanceAssessment({ projectId, model, deployment, window, ...(score !== undefined ? { score } : {}) });
    if (sourceEvidence) assessment.sourceEvidence = structuredClone(sourceEvidence);
    await this.mutate(projectId, (candidate) => {
      candidate.assessments.unshift(assessment);
      candidate.assessments = candidate.assessments.slice(0, 500);
      const current = candidate.deployments.find((item) => item.id === deploymentId);
      if (current) {
        current.lastAssessmentId = assessment.id;
        current.lastRunAt = assessment.generatedAt;
        current.consecutiveFailures = 0;
        delete current.lastError;
        current.status = assessment.decisionStatus === "drift-blocked" || assessment.decisionStatus === "insufficient-data" ? "degraded" : assessment.decisionStatus === "shadow" ? "shadow" : "running";
        current.updatedAt = new Date().toISOString();
      }
      return assessment;
    });
    return assessment;
  }

  async recordDeploymentFailure(projectId: string, deploymentId: string, error: unknown): Promise<void> {
    await this.mutate(projectId, (state) => {
      const deployment = state.deployments.find((item) => item.id === deploymentId);
      if (!deployment) return;
      deployment.status = "error";
      deployment.lastRunAt = new Date().toISOString();
      deployment.lastError = compactError(error);
      deployment.consecutiveFailures = (deployment.consecutiveFailures ?? 0) + 1;
      deployment.updatedAt = deployment.lastRunAt;
    });
  }

  async shadowEvaluate(projectId: string, modelId: string, rows: Array<Record<string, number>>, labelColumn: string, threshold?: number, timeColumn?: string): Promise<MaintenanceShadowEvaluation> {
    const model = this.requireModel(projectId, modelId);
    if (model.artifact.engine !== "native-json") throw new Error("ONNX 时序模型需在训练侧完成回测；首期 API 支持 native-json 模型影子评测");
    const scores = rows.map((row) => scoreNativeArtifact(model.artifact, row));
    const result = evaluateMaintenanceShadow({ projectId, modelId, rows, scores, labelColumn, threshold: threshold ?? model.artifact.decisionThreshold ?? model.gates.warningThreshold, ...(timeColumn ? { timeColumn } : {}) });
    await this.mutate(projectId, (state) => {
      state.shadowEvaluations.unshift(result);
      state.shadowEvaluations = state.shadowEvaluations.slice(0, 100);
      return result;
    });
    return result;
  }

  async saveCase(projectId: string, input: Partial<OperationalCaseRecord>): Promise<OperationalCaseRecord> {
    return this.mutate(projectId, (state) => {
      const now = new Date().toISOString();
      // 同一 AI 证据的重试/重复点击只更新已有草稿；普通外部编号仍沿用原合同。
      const existing = input.id ? state.cases.find((item) => item.id === input.id)
        : input.externalRef?.startsWith("ai-draft:") ? state.cases.find(item => item.externalRef === input.externalRef) : undefined;
      const externalRef = input.externalRef ?? existing?.externalRef;
      const outcome = input.outcome ?? existing?.outcome;
      const record: OperationalCaseRecord = {
        id: existing?.id ?? randomUUID(), projectId, type: input.type ?? existing?.type ?? "maintenance",
        title: requiredText(input.title ?? existing?.title, "Case 标题"), severity: input.severity ?? existing?.severity ?? "warning",
        status: input.status ?? existing?.status ?? "triage", owner: input.owner?.trim() || existing?.owner || "待分配",
        objectRefs: input.objectRefs ?? existing?.objectRefs ?? [], sourceRefs: input.sourceRefs ?? existing?.sourceRefs ?? [],
        hypothesis: input.hypothesis ?? existing?.hypothesis ?? [], suggestedActions: input.suggestedActions ?? existing?.suggestedActions ?? [],
        ...(externalRef ? { externalRef } : {}),
        ...(outcome ? { outcome } : {}),
        createdAt: existing?.createdAt ?? now, updatedAt: now
      };
      if (existing) Object.assign(existing, record); else state.cases.unshift(record);
      return record;
    });
  }

  async saveValidationStudy(
    projectId: string,
    input: SaveIndustrialValidationStudyInput,
  ): Promise<IndustrialValidationStudyRecord> {
    return this.mutate(projectId, (state) => {
      const existing = input.id ? state.validationStudies.find((item) => item.id === input.id) : undefined;
      const nextType = input.studyType ?? existing?.studyType ?? inferredValidationStudyType(input.sourceKind ?? existing?.sourceKind);
      for (const referenceId of [input.baselineStudyId, input.reproductionOf]) {
        if (!referenceId) continue;
        const referenced = state.validationStudies.find((item) => item.id === referenceId);
        if (!referenced) throw new Error("验证 Study 基线不存在");
        if (referenced.id === existing?.id) throw new Error("验证 Study 不能引用自身为基线");
        const referencedType = referenced.studyType ?? inferredValidationStudyType(referenced.sourceKind);
        if (referencedType !== nextType) throw new Error("验证 Study 只能对比同类型基线");
      }
      const record = buildValidationStudyRecord(projectId, input, existing);
      if (existing) Object.assign(existing, record);
      else state.validationStudies.unshift(record);
      state.validationStudies = state.validationStudies.slice(0, 200);
      return record;
    });
  }

  async runLogistics(projectId: string, request: LogisticsExperimentRequest): Promise<LogisticsExperimentResult> {
    return this.persistLogisticsResult(projectId, runLogisticsExperiment(projectId, request));
  }

  async reproduceLogistics(projectId: string, experimentId: string): Promise<LogisticsExperimentResult> {
    const source = this.project(projectId).logisticsExperiments.find((item) => item.id === experimentId);
    if (!source) throw new Error("待复现的物流仿真记录不存在");
    const result = runLogisticsExperiment(projectId, logisticsRequestFromResult(source));
    result.reproductionOf = source.id;
    return this.persistLogisticsResult(projectId, result);
  }

  async runPlantLite(projectId: string, request: PlantLiteStudyRequest, signal?: AbortSignal): Promise<PlantLiteStudyRecord> {
    return this.persistPlantLiteStudy(projectId, await this.plantLiteExecutor.run(projectId, request, signal));
  }

  async reproducePlantLite(projectId: string, studyId: string, signal?: AbortSignal): Promise<PlantLiteStudyRecord> {
    const source = this.project(projectId).plantLiteStudies.find((item) => item.id === studyId);
    if (!source) throw new Error("待复现的 Plant Lite Study 不存在");
    const result = await this.plantLiteExecutor.run(projectId, plantLiteRequestFromRecord(source), signal);
    result.reproductionOf = source.id;
    return this.persistPlantLiteStudy(projectId, result);
  }

  async runWhatIf(projectId: string, request: WhatIfStudyRequest): Promise<WhatIfStudyRecord> {
    return this.persistWhatIfResult(projectId, runWhatIfStudy(projectId, request));
  }

  async reproduceWhatIf(projectId: string, studyId: string): Promise<WhatIfStudyRecord> {
    const source = this.project(projectId).whatIfStudies.find((item) => item.id === studyId);
    if (!source) throw new Error("待复现的 What-if 记录不存在");
    return this.persistWhatIfResult(projectId, reproduceWhatIfStudy(projectId, source));
  }

  private async persistWhatIfResult(
    projectId: string,
    result: WhatIfStudyRecord,
  ): Promise<WhatIfStudyRecord> {
    await this.mutate(projectId, (state) => {
      state.whatIfStudies.unshift(result);
      state.whatIfStudies = state.whatIfStudies.slice(0, 100);
      return result;
    });
    return result;
  }

  private async persistLogisticsResult(
    projectId: string,
    result: LogisticsExperimentResult,
  ): Promise<LogisticsExperimentResult> {
    await this.mutate(projectId, (state) => {
      state.logisticsExperiments.unshift(result);
      state.logisticsExperiments = state.logisticsExperiments.slice(0, 100);
      return result;
    });
    return result;
  }

  private async persistPlantLiteStudy(projectId: string, record: PlantLiteStudyRecord): Promise<PlantLiteStudyRecord> {
    const recordIssue = plantLiteStudyRecordIssue(record);
    if (recordIssue) throw new PlantLiteWorkerExecutionError(`离散仿真没有返回有效结果（${recordIssue}），未保存本次运行`);
    await this.mutate(projectId, (state) => {
      state.plantLiteStudies.unshift(record);
      state.plantLiteStudies = state.plantLiteStudies.slice(0, 100);
      return record;
    });
    return record;
  }

  async analyzeEnergy(projectId: string, observations: EnergyObservation[]): Promise<EnergyInsightRecord> {
    const result = analyzeEnergy(projectId, observations);
    await this.mutate(projectId, (state) => {
      state.energyInsights.unshift(result);
      state.energyInsights = state.energyInsights.slice(0, 100);
      return result;
    });
    return result;
  }

  private requireModel(projectId: string, modelId: string): MaintenanceModelPackage {
    const model = this.project(projectId).models.find((item) => item.id === modelId);
    if (!model) throw new Error("维护模型不存在");
    return structuredClone(model);
  }

  private async scoreOnnx(model: MaintenanceModelPackage, rows: Array<Record<string, number>>): Promise<number> {
    if (!model.artifactPath) throw new Error("ONNX 模型制品路径缺失");
    const window = Math.max(1, Number(model.artifact.window ?? 1));
    const selected = rows.slice(-window);
    if (selected.length < window) throw new Error(`模型需要连续 ${window} 条数据`);
    const means = model.artifact.means ?? model.artifact.featureMeans ?? model.artifact.features.map(() => 0);
    const stds = model.artifact.stds ?? model.artifact.featureStds ?? model.artifact.features.map(() => 1);
    const values = selected.flatMap((row) => model.artifact.features.map((feature, index) => {
      const raw = Number(row[feature]);
      return model.artifact.inputNormalization ? (raw - Number(means[index] ?? 0)) / (Number(stds[index] ?? 1) || 1) : raw;
    }));
    const shape = window > 1 ? [1, window, model.artifact.features.length] : [selected.length, model.artifact.features.length];
    const session = await this.onnxSession(model.artifactPath);
    const inputName = model.artifact.inputName ?? session.inputNames[0];
    if (!inputName) throw new Error("ONNX 模型没有输入节点");
    const outputs = await session.run({ [inputName]: new ort.Tensor("float32", Float32Array.from(values), shape) });
    const outputName = model.artifact.outputName ?? session.outputNames[model.artifact.outputIndex ?? 0];
    if (!outputName) throw new Error("ONNX 模型没有输出节点");
    const tensor = outputs[outputName];
    if (!tensor) throw new Error("ONNX 输出节点不存在");
    const valuesOut = Array.from(tensor.data as Float32Array | Float64Array, Number);
    const outputIndex = model.artifact.outputTransform === "class1" ? 1 : 0;
    const raw = valuesOut[outputIndex] ?? valuesOut[0];
    if (raw === undefined || !Number.isFinite(raw)) throw new Error("ONNX 输出无效");
    if (model.artifact.outputTransform === "sigmoid") return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, raw))));
    return raw;
  }

  private onnxSession(artifactPath: string): Promise<ort.InferenceSession> {
    let session = this.onnxSessions.get(artifactPath);
    if (!session) {
      session = ort.InferenceSession.create(artifactPath, { executionProviders: ["cpu"], graphOptimizationLevel: "all" });
      this.onnxSessions.set(artifactPath, session);
    }
    return session;
  }

  private project(projectId: string): OperationsProjectState {
    const state = this.document.projects[projectId] ??= {
      models: [], deployments: [], assessments: [], shadowEvaluations: [], cases: [],
      logisticsExperiments: [], plantLiteStudies: [], energyInsights: [], validationStudies: [], whatIfStudies: []
    };
    // schemaVersion 1 允许增量字段；旧项目在首次读取时补齐。空记录属于中断写入遗留，
    // 必须在服务边界隔离，不能让一条坏记录拖垮整个运营工作区。
    state.models = compactRecords(state.models);
    state.deployments = compactRecords(state.deployments);
    state.assessments = compactRecords(state.assessments);
    state.shadowEvaluations = compactRecords(state.shadowEvaluations);
    state.cases = compactRecords(state.cases);
    state.logisticsExperiments = compactRecords(state.logisticsExperiments);
    state.plantLiteStudies = compactRecords(state.plantLiteStudies);
    state.energyInsights = compactRecords(state.energyInsights);
    state.validationStudies = compactRecords(state.validationStudies);
    state.whatIfStudies = compactRecords(state.whatIfStudies);
    return state;
  }

  private async mutate<T>(projectId: string, action: (state: OperationsProjectState) => T): Promise<T> {
    let result!: T;
    const operation = this.writeChain.then(async () => {
      const previous = structuredClone(this.document);
      try {
        result = action(this.project(projectId));
        await this.persist();
      } catch (error) {
        this.document = previous;
        throw error;
      }
    });
    // 单次校验或持久化失败必须返回给当前调用者，但不能毒化后续串行写入。
    this.writeChain = operation.then(() => undefined, () => undefined);
    await operation;
    return structuredClone(result);
  }

  private async persist(): Promise<void> {
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, JSON.stringify(this.document, null, 2));
    await rename(temporary, this.filePath);
  }
}
