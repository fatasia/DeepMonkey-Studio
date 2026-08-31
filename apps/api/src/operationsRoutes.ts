import type { FastifyInstance, FastifyReply } from "fastify";
import type {
  AiDataBindingRunRecord,
  DataSourceEvidence,
  EnergyObservation,
  LogisticsExperimentRequest,
  PlantLiteStudyRequest,
  MaintenanceDeploymentRecord,
  MaintenanceModelPackage,
  OperationalCaseRecord,
  SaveIndustrialValidationStudyInput,
} from "@bim-studio/contracts";
import type { DataQuerySource } from "@bim-studio/data-query-plugin";
import type { WhatIfStudyRequest } from "@bim-studio/studio-core";
import type { MetadataStore } from "./store.js";
import type { OperationsService } from "./operations.js";
import { OperationsRevisionConflictError } from "./validationStudy.js";
import { PlantLiteWorkerCancelledError, PlantLiteWorkerTimeoutError } from "./plantLiteWorkerExecutor.js";
import { readAiDataset } from "./aiDatasetSource.js";
import { failAiDataBindingRun, startAiDataBindingRun, succeedAiDataBindingRun } from "./aiDataBindingRunRecorder.js";

export async function registerOperationsRoutes(
  app: FastifyInstance,
  dependencies: { store: MetadataStore; service: OperationsService; dataQuerySource?: DataQuerySource },
): Promise<void> {
  const requireProject = (projectId: string) => {
    if (!dependencies.store.getProject(projectId)) throw new Error("项目不存在");
  };
  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/operations", async (request) => {
    requireProject(request.params.projectId);
    return dependencies.service.snapshot(request.params.projectId);
  });
  app.post<{ Params: { projectId: string } }>("/api/projects/:projectId/operations/maintenance/sync-iot-nb", async (request, reply) => {
    requireProject(request.params.projectId);
    try { return await dependencies.service.syncIotNbModels(request.params.projectId); }
    catch (error) { return reply.code(400).send({ message: compactError(error) }); }
  });
  app.post<{ Params: { projectId: string; modelId: string } }>("/api/projects/:projectId/operations/maintenance/models/:modelId/assess-iot-nb", async (request, reply) => {
    requireProject(request.params.projectId);
    try { return await dependencies.service.assessIotNbModel(request.params.projectId, request.params.modelId); }
    catch (error) { return reply.code(400).send({ message: compactError(error) }); }
  });
  app.post<{ Params: { projectId: string }; Body: Partial<MaintenanceModelPackage> }>("/api/projects/:projectId/operations/maintenance/models", async (request, reply) => {
    requireProject(request.params.projectId);
    try { return await dependencies.service.importModel(request.params.projectId, request.body ?? {}); }
    catch (error) { return reply.code(400).send({ message: compactError(error) }); }
  });
  app.post<{ Params: { projectId: string; modelId: string } }>("/api/projects/:projectId/operations/maintenance/models/:modelId/artifact", async (request, reply) => {
    requireProject(request.params.projectId);
    const file = await request.file();
    if (!file || !file.filename.toLowerCase().endsWith(".onnx")) return reply.code(415).send({ message: "请上传 .onnx 模型制品" });
    try { return await dependencies.service.uploadArtifact(request.params.projectId, request.params.modelId, await file.toBuffer()); }
    catch (error) { return reply.code(400).send({ message: compactError(error) }); }
  });
  app.post<{ Params: { projectId: string }; Body: Partial<MaintenanceDeploymentRecord> }>("/api/projects/:projectId/operations/maintenance/deployments", async (request, reply) => {
    requireProject(request.params.projectId);
    try { return await dependencies.service.saveDeployment(request.params.projectId, request.body ?? {}); }
    catch (error) { return reply.code(400).send({ message: compactError(error) }); }
  });
  app.post<{
    Params: { projectId: string; deploymentId: string };
    Body: { rows?: Array<Record<string, number>>; datasetId?: string };
  }>("/api/projects/:projectId/operations/maintenance/deployments/:deploymentId/assess", async (request, reply) => {
    requireProject(request.params.projectId);
    let bindingRun: AiDataBindingRunRecord | undefined;
    let sourceEvidence: DataSourceEvidence | undefined;
    try {
      const datasetId = request.body?.datasetId?.trim();
      if (!datasetId) return await dependencies.service.assess(request.params.projectId, request.params.deploymentId, request.body?.rows ?? []);
      if (request.body?.rows?.length) return reply.code(400).send({ message: "rows 与 datasetId 只能选择一种输入方式" });
      if (!dependencies.dataQuerySource) return reply.code(503).send({ message: "统一数据集运行时尚未启用" });
      const deployment = dependencies.service.snapshot(request.params.projectId).deployments.find((item) => item.id === request.params.deploymentId);
      const binding = deployment?.bindingId
        ? dependencies.store.getAiDataBinding(request.params.projectId, deployment.bindingId)
        : undefined;
      if (binding && binding.datasetId !== datasetId) return reply.code(400).send({ message: "部署绑定的数据集与本次运行不一致" });
      if (binding) bindingRun = await startAiDataBindingRun(dependencies.store, binding);
      const controller = new AbortController();
      const abortFromClient = () => controller.abort("客户端已取消维护评估");
      request.raw.once("aborted", abortFromClient);
      try {
        const snapshot = await readAiDataset(
          dependencies.dataQuerySource,
          dependencies.store,
          request.params.projectId,
          datasetId,
          controller.signal,
        );
        sourceEvidence = snapshot.evidence;
        const assessment = await dependencies.service.assess(
          request.params.projectId,
          request.params.deploymentId,
          snapshot.numericRows,
          snapshot.evidence,
        );
        if (bindingRun && binding) {
          await succeedAiDataBindingRun(dependencies.store, bindingRun, binding, snapshot.evidence, assessment);
        }
        return assessment;
      } finally {
        request.raw.removeListener("aborted", abortFromClient);
      }
    }
    catch (error) {
      if (bindingRun) await failAiDataBindingRun(dependencies.store, bindingRun, error, sourceEvidence);
      return reply.code(400).send({ message: compactError(error) });
    }
  });
  app.post<{ Params: { projectId: string; modelId: string }; Body: { rows?: Array<Record<string, number>>; labelColumn?: string; threshold?: number; timeColumn?: string } }>("/api/projects/:projectId/operations/maintenance/models/:modelId/shadow-evaluate", async (request, reply) => {
    requireProject(request.params.projectId);
    try {
      return await dependencies.service.shadowEvaluate(request.params.projectId, request.params.modelId, request.body?.rows ?? [], requiredText(request.body?.labelColumn, "标签列"), request.body?.threshold, request.body?.timeColumn);
    } catch (error) { return reply.code(400).send({ message: compactError(error) }); }
  });
  app.post<{ Params: { projectId: string }; Body: Partial<OperationalCaseRecord> }>("/api/projects/:projectId/operations/cases", async (request, reply) => {
    requireProject(request.params.projectId);
    try { return await dependencies.service.saveCase(request.params.projectId, request.body ?? {}); }
    catch (error) { return reply.code(400).send({ message: compactError(error) }); }
  });
  app.patch<{ Params: { projectId: string; caseId: string }; Body: Partial<OperationalCaseRecord> }>("/api/projects/:projectId/operations/cases/:caseId", async (request, reply) => {
    requireProject(request.params.projectId);
    try { return await dependencies.service.saveCase(request.params.projectId, { ...request.body, id: request.params.caseId }); }
    catch (error) { return reply.code(400).send({ message: compactError(error) }); }
  });
  app.post<{ Params: { projectId: string }; Body: SaveIndustrialValidationStudyInput }>("/api/projects/:projectId/operations/validation-studies", async (request, reply) => {
    requireProject(request.params.projectId);
    try {
      const record = await dependencies.service.saveValidationStudy(request.params.projectId, request.body ?? {});
      return reply.code(201).send(record);
    } catch (error) {
      return sendStudyError(reply, error);
    }
  });
  app.patch<{ Params: { projectId: string; studyId: string }; Body: SaveIndustrialValidationStudyInput }>("/api/projects/:projectId/operations/validation-studies/:studyId", async (request, reply) => {
    requireProject(request.params.projectId);
    try {
      return await dependencies.service.saveValidationStudy(request.params.projectId, {
        ...request.body,
        id: request.params.studyId,
      });
    } catch (error) {
      return sendStudyError(reply, error);
    }
  });
  app.post<{ Params: { projectId: string }; Body: LogisticsExperimentRequest }>("/api/projects/:projectId/operations/logistics/experiments", async (request, reply) => {
    requireProject(request.params.projectId);
    try { return await dependencies.service.runLogistics(request.params.projectId, request.body); }
    catch (error) { return reply.code(400).send({ message: compactError(error) }); }
  });
  app.post<{ Params: { projectId: string; experimentId: string } }>("/api/projects/:projectId/operations/logistics/experiments/:experimentId/reproduce", async (request, reply) => {
    requireProject(request.params.projectId);
    try { return await dependencies.service.reproduceLogistics(request.params.projectId, request.params.experimentId); }
    catch (error) { return reply.code(400).send({ message: compactError(error) }); }
  });
  // DES 采用同步、事件受限执行；连接中断会通过内核的协作取消回调终止后续事件处理。
  app.post<{ Params: { projectId: string }; Body: PlantLiteStudyRequest }>("/api/projects/:projectId/operations/logistics/des-studies", async (request, reply) => {
    requireProject(request.params.projectId);
    const controller = new AbortController();
    const abort = () => controller.abort("客户端取消 Plant Lite Study");
    request.raw.once("aborted", abort);
    try { return await dependencies.service.runPlantLite(request.params.projectId, request.body ?? {}, controller.signal); }
    catch (error) { return sendPlantLiteError(reply, error); }
    finally { request.raw.removeListener("aborted", abort); }
  });
  app.post<{ Params: { projectId: string; studyId: string } }>("/api/projects/:projectId/operations/logistics/des-studies/:studyId/reproduce", async (request, reply) => {
    requireProject(request.params.projectId);
    const controller = new AbortController();
    const abort = () => controller.abort("客户端取消 Plant Lite Study");
    request.raw.once("aborted", abort);
    try { return await dependencies.service.reproducePlantLite(request.params.projectId, request.params.studyId, controller.signal); }
    catch (error) { return sendPlantLiteError(reply, error); }
    finally { request.raw.removeListener("aborted", abort); }
  });
  app.post<{ Params: { projectId: string }; Body: WhatIfStudyRequest }>("/api/projects/:projectId/operations/what-if/studies", async (request, reply) => {
    requireProject(request.params.projectId);
    try { return await dependencies.service.runWhatIf(request.params.projectId, request.body); }
    catch (error) { return reply.code(400).send({ message: compactError(error) }); }
  });
  app.post<{ Params: { projectId: string; studyId: string } }>("/api/projects/:projectId/operations/what-if/studies/:studyId/reproduce", async (request, reply) => {
    requireProject(request.params.projectId);
    try { return await dependencies.service.reproduceWhatIf(request.params.projectId, request.params.studyId); }
    catch (error) { return reply.code(400).send({ message: compactError(error) }); }
  });
  app.post<{ Params: { projectId: string }; Body: { observations?: EnergyObservation[] } }>("/api/projects/:projectId/operations/energy/analyze", async (request, reply) => {
    requireProject(request.params.projectId);
    try { return await dependencies.service.analyzeEnergy(request.params.projectId, request.body?.observations ?? []); }
    catch (error) { return reply.code(400).send({ message: compactError(error) }); }
  });
}

function requiredText(value: string | undefined, label: string): string {
  const text = value?.trim();
  if (!text) throw new Error(`${label}不能为空`);
  return text;
}

function compactError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll(/\s+/g, " ").slice(0, 500);
}

function sendStudyError(reply: FastifyReply, error: unknown) {
  if (error instanceof OperationsRevisionConflictError) {
    return reply.code(409).send({ message: error.message, current: error.current });
  }
  return reply.code(400).send({ message: compactError(error) });
}

function sendPlantLiteError(reply: FastifyReply, error: unknown) {
  if (error instanceof PlantLiteWorkerCancelledError) return reply.code(499).send({ message: error.message, code: "plant_lite_cancelled" });
  if (error instanceof PlantLiteWorkerTimeoutError) return reply.code(503).send({ message: error.message, code: "plant_lite_timeout" });
  return reply.code(400).send({ message: compactError(error) });
}
