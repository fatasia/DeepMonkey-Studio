import type {
  BatteryModelCatalogEntry,
  BatteryReleaseAssessment,
  EnergyInsightRecord,
  EnergyObservation,
  IndustrialStudyRecord,
  LogisticsExperimentRequest,
  LogisticsExperimentResult,
  PlantLiteStudyRecord,
  PlantLiteStudyRequest,
  MaintenanceAssessmentRecord,
  MaintenanceDeploymentRecord,
  MaintenanceModelPackage,
  OperationalCaseRecord,
} from "@bim-studio/contracts";
import type { WhatIfStudyRecord, WhatIfStudyRequest } from "@bim-studio/studio-core";
import type {
  IndustrialValidationStudyRecord,
  SaveIndustrialValidationStudyInput,
} from "@bim-studio/contracts";

type ApiRequest = <T>(url: string, init?: RequestInit) => Promise<T>;

export interface OperationsSnapshot {
  models: MaintenanceModelPackage[];
  deployments: MaintenanceDeploymentRecord[];
  assessments: MaintenanceAssessmentRecord[];
  shadowEvaluations: Array<{ id: string }>;
  cases: OperationalCaseRecord[];
  logisticsExperiments: LogisticsExperimentResult[];
  plantLiteStudies: PlantLiteStudyRecord[];
  energyInsights: EnergyInsightRecord[];
  validationStudies: IndustrialValidationStudyRecord[];
  whatIfStudies: WhatIfStudyRecord[];
  /** 由服务端从各权威结果派生，不单独持久化。 */
  studies: IndustrialStudyRecord[];
}

export interface IotNbSyncResult {
  sourceProjectId: string;
  sourceProjectName: string;
  sourceUpdatedAt?: string;
  imported: number;
  updated: number;
  removedSamples: number;
  models: MaintenanceModelPackage[];
}

export interface IotNbAssessmentResult {
  deployment: MaintenanceDeploymentRecord;
  assessment: MaintenanceAssessmentRecord;
  source: {
    projectName: string;
    datasetId: string;
    datasetName: string;
    rowCount: number;
    benchmarkOnly: boolean;
  };
}

export interface CapabilityDescriptor {
  id: string;
  version: string;
  label: string;
  kind: string;
  execution: string;
  permissions: string[];
  timeoutMs: number;
  inputSchemaVersion: string;
  outputSchemaVersion: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

export interface AiProviderDescriptor {
  id: string;
  version: string;
  label: string;
  execution: string;
  permissions: string[];
  streaming: boolean;
  timeoutMs: number;
}

export interface CapabilityInvocationResult<T = unknown> {
  status: string;
  capabilityId: string;
  requestId: string;
  traceId: string;
  decisionStatus: string;
  output?: T;
  evidence: Array<{
    id: string;
    kind: string;
    label: string;
    source: string;
    fingerprint?: string;
  }>;
  warnings: string[];
  error?: { code: string; message: string; retryable: boolean };
}

export interface BatteryReleaseGateSnapshot extends BatteryReleaseAssessment {
  deployment: {
    enabled: boolean;
    requestedModels: string[];
    activeModels: string[];
    diagnostics: string[];
  };
}

/** 工业 AI、调试与运营能力共享统一插件调用合同。 */
export function createIndustrialApi(request: ApiRequest) {
  return {
    getOperations: (projectId: string) =>
      request<OperationsSnapshot>(`/api/projects/${projectId}/operations`),
    listCapabilities: (signal?: AbortSignal) =>
      request<{ capabilities: CapabilityDescriptor[] }>("/api/capabilities", signal ? { signal } : undefined),
    getCapability: (capabilityId: string) =>
      request<CapabilityDescriptor>(
        `/api/capabilities/${encodeURIComponent(capabilityId)}`,
      ),
    listAiProviders: () =>
      request<{ providers: AiProviderDescriptor[] }>("/api/ai/providers"),
    invokeCapability: <T = unknown>(
      projectId: string,
      capabilityId: string,
      input: unknown,
      principal = "web-user",
    ) =>
      request<CapabilityInvocationResult<T>>(
        `/api/projects/${projectId}/capabilities/invoke`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ capabilityId, principal, input }),
        },
      ),
    listBatteryModelCatalog: () =>
      request<{ models: BatteryModelCatalogEntry[] }>(
        "/api/battery/models/catalog",
      ),
    getBatteryReleaseGate: () =>
      request<BatteryReleaseGateSnapshot>("/api/battery/models/release-gate"),
    predictBatteryFromFile: <T = Record<string, unknown>>(
      projectId: string,
      input: {
        model: string;
        file: File;
        chemistry: string;
        routingMode?: "standard" | "physics" | "dynamic" | "both";
        nominalCapacityAh?: number;
        targetCapacityRetention?: number;
      },
      signal?: AbortSignal,
    ) => {
      const body = new FormData();
      body.append("model", input.model);
      body.append("chemistry", input.chemistry);
      if (input.routingMode) body.append("routingMode", input.routingMode);
      if (input.nominalCapacityAh !== undefined) {
        body.append("nominalCapacityAh", String(input.nominalCapacityAh));
      }
      if (input.targetCapacityRetention !== undefined) {
        body.append(
          "targetCapacityRetention",
          String(input.targetCapacityRetention),
        );
      }
      // 文件最后追加，兼容流式 multipart 解析器先读取控制字段再消费大文件。
      body.append("file", input.file);
      return request<CapabilityInvocationResult<T>>(
        `/api/projects/${projectId}/battery/predictions`,
        { method: "POST", body, ...(signal ? { signal } : {}) },
      );
    },
    predictBatteryFromDataset: <T = Record<string, unknown>>(
      projectId: string,
      input: {
        bindingId?: string;
        datasetId: string;
        model: string;
        chemistry: string;
        routingMode?: "standard" | "physics" | "dynamic" | "both";
        nominalCapacityAh?: number;
        targetCapacityRetention?: number;
      },
      signal?: AbortSignal,
    ) => request<CapabilityInvocationResult<T>>(
      `/api/projects/${projectId}/battery/predictions/from-dataset`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
        ...(signal ? { signal } : {}),
      },
    ),
    runVirtualDebug: <T = unknown>(projectId: string, scenario: unknown) =>
      request<CapabilityInvocationResult<T>>(
        `/api/projects/${projectId}/capabilities/invoke`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            capabilityId: "simulation.virtual-debug.run",
            input: scenario,
          }),
        },
      ),
    runVirtualDebugSuite: <T = unknown>(projectId: string, suite: unknown) =>
      request<CapabilityInvocationResult<T>>(
        `/api/projects/${projectId}/capabilities/invoke`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            capabilityId: "simulation.virtual-debug.run-suite",
            input: suite,
          }),
        },
      ),
    syncIotNbMaintenanceModels: (projectId: string) =>
      request<IotNbSyncResult>(
        `/api/projects/${projectId}/operations/maintenance/sync-iot-nb`,
        {
          method: "POST",
        },
      ),
    assessIotNbMaintenanceModel: (projectId: string, modelId: string) =>
      request<IotNbAssessmentResult>(
        `/api/projects/${projectId}/operations/maintenance/models/${modelId}/assess-iot-nb`,
        { method: "POST" },
      ),
    importMaintenanceModel: (
      projectId: string,
      model: Partial<MaintenanceModelPackage>,
    ) =>
      request<MaintenanceModelPackage>(
        `/api/projects/${projectId}/operations/maintenance/models`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(model),
        },
      ),
    uploadMaintenanceArtifact: (
      projectId: string,
      modelId: string,
      artifact: File,
    ) => {
      const body = new FormData();
      body.append("file", artifact);
      return request<MaintenanceModelPackage>(
        `/api/projects/${projectId}/operations/maintenance/models/${modelId}/artifact`,
        { method: "POST", body },
      );
    },
    saveMaintenanceDeployment: (
      projectId: string,
      deployment: Partial<MaintenanceDeploymentRecord>,
    ) =>
      request<MaintenanceDeploymentRecord>(
        `/api/projects/${projectId}/operations/maintenance/deployments`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(deployment),
        },
      ),
    assessMaintenance: (
      projectId: string,
      deploymentId: string,
      rows: Array<Record<string, number>>,
    ) =>
      request<MaintenanceAssessmentRecord>(
        `/api/projects/${projectId}/operations/maintenance/deployments/${deploymentId}/assess`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ rows }),
        },
      ),
    assessMaintenanceDataset: (
      projectId: string,
      deploymentId: string,
      datasetId: string,
    ) =>
      request<MaintenanceAssessmentRecord>(
        `/api/projects/${projectId}/operations/maintenance/deployments/${deploymentId}/assess`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ datasetId }),
        },
      ),
    saveOperationalCase: (
      projectId: string,
      record: Partial<OperationalCaseRecord>,
    ) =>
      request<OperationalCaseRecord>(
        `/api/projects/${projectId}/operations/cases`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(record),
        },
      ),
    saveValidationStudy: (
      projectId: string,
      record: SaveIndustrialValidationStudyInput,
    ) =>
      request<IndustrialValidationStudyRecord>(
        record.id
          ? `/api/projects/${projectId}/operations/validation-studies/${record.id}`
          : `/api/projects/${projectId}/operations/validation-studies`,
        {
          method: record.id ? "PATCH" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(record),
        },
      ),
    runLogisticsExperiment: (
      projectId: string,
      requestBody: LogisticsExperimentRequest,
    ) =>
      request<LogisticsExperimentResult>(
        `/api/projects/${projectId}/operations/logistics/experiments`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(requestBody),
        },
      ),
    reproduceLogisticsExperiment: (projectId: string, experimentId: string) =>
      request<LogisticsExperimentResult>(
        `/api/projects/${projectId}/operations/logistics/experiments/${encodeURIComponent(experimentId)}/reproduce`,
        { method: "POST" },
      ),
    runPlantLiteStudy: (projectId: string, requestBody: PlantLiteStudyRequest, signal?: AbortSignal) =>
      request<PlantLiteStudyRecord>(
        `/api/projects/${projectId}/operations/logistics/des-studies`,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(requestBody), ...(signal ? { signal } : {}) },
      ),
    reproducePlantLiteStudy: (projectId: string, studyId: string, signal?: AbortSignal) =>
      request<PlantLiteStudyRecord>(
        `/api/projects/${projectId}/operations/logistics/des-studies/${encodeURIComponent(studyId)}/reproduce`,
        { method: "POST", ...(signal ? { signal } : {}) },
      ),
    runWhatIfStudy: (projectId: string, requestBody: WhatIfStudyRequest) =>
      request<WhatIfStudyRecord>(
        `/api/projects/${projectId}/operations/what-if/studies`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(requestBody),
        },
      ),
    reproduceWhatIfStudy: (projectId: string, studyId: string) =>
      request<WhatIfStudyRecord>(
        `/api/projects/${projectId}/operations/what-if/studies/${encodeURIComponent(studyId)}/reproduce`,
        { method: "POST" },
      ),
    analyzeEnergy: (projectId: string, observations: EnergyObservation[]) =>
      request<EnergyInsightRecord>(
        `/api/projects/${projectId}/operations/energy/analyze`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ observations }),
        },
      ),
  };
}
