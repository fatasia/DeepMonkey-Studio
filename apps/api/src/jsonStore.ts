import { randomUUID } from "node:crypto";
import { assertApplicationDocument, assertPathSafeResourceId } from "@bim-studio/contracts";
import type {
  AiDataBinding,
  AiDataBindingRunRecord,
  ApplicationDocument,
  ApplicationPublicationPointer,
  DataConnectionRecord,
  DataDatasetRecord,
  DataEndpointDefinition,
  DataPipelineDefinition,
  ModelRecord,
  ProjectAssetRecord,
  ProjectRecord,
  PublishedApplicationRecord,
  PublishedSceneRecord,
  SceneSnapshot,
  UnityResourceRecord,
  VisionEventRecord,
  VisionModelRecord,
  VisionSourceRecord,
  VisionTaskRecord,
} from "@bim-studio/contracts";
import type {
  MetadataStore,
  ApplicationIdReservation,
  CreateApplicationDraftResult,
  UpdateApplicationDraftResult,
  SaveApplicationWorkspaceResult,
  DeleteApplicationDraftResult,
  PublishApplicationResult,
  UnpublishApplicationResult,
  AiDataBindingRunQuery,
} from "./metadataStore.js";
import { MAX_AI_DATA_BINDING_RUNS_PER_PROJECT, newestAiDataBindingRuns, retainRecentAiDataBindingRuns } from "./aiDataBindingRunStore.js";
import { applicationIdReservation, changed, requireProject, unchanged, upsert } from "./storeUtils.js";
import { JsonStoreFoundation } from "./jsonStoreFoundation.js";

export class JsonStore extends JsonStoreFoundation implements MetadataStore {
  listProjects(): ProjectRecord[] {
    return structuredClone(this.document.projects);
  }

  getProject(projectId: string): ProjectRecord | undefined {
    const project = this.document.projects.find((item) => item.id === projectId);
    return project ? structuredClone(project) : undefined;
  }

  async createProject(name: string, description = ""): Promise<ProjectRecord> {
    return this.runDocumentMutation((candidate) => {
      const now = new Date().toISOString();
      const project: ProjectRecord = {
        id: randomUUID(),
        name,
        description,
        models: [],
        assets: [],
        aiDataBindings: [],
        aiDataBindingRuns: [],
        createdAt: now,
        updatedAt: now,
      };
      candidate.projects.push(project);
      return changed(structuredClone(project));
    });
  }

  async updateProject(projectId: string, updates: Pick<Partial<ProjectRecord>, "name" | "description">): Promise<ProjectRecord> {
    return this.runDocumentMutation((candidate) => {
      const project = requireProject(candidate, projectId);
      if (updates.name !== undefined) project.name = updates.name;
      if (updates.description !== undefined) project.description = updates.description;
      project.updatedAt = new Date().toISOString();
      return changed(structuredClone(project));
    });
  }

  async removeProject(projectId: string): Promise<boolean> {
    assertPathSafeResourceId(projectId, "projectId");
    return this.runDocumentMutation<boolean>((candidate) => {
      const originalLength = candidate.projects.length;
      const endpointIds = new Set((candidate.projects.find((project) => project.id === projectId)?.dataEndpoints ?? []).map((endpoint) => endpoint.id));
      candidate.projects = candidate.projects.filter((item) => item.id !== projectId);
      if (candidate.projects.length === originalLength) return unchanged(false);
      candidate.scenes = candidate.scenes.filter((scene) => scene.projectId !== projectId);
      candidate.publishedScenes = (candidate.publishedScenes ?? []).filter((scene) => scene.projectId !== projectId);
      candidate.scenePublicationHistory = (candidate.scenePublicationHistory ?? []).filter((scene) => scene.projectId !== projectId);
      candidate.applications = (candidate.applications ?? []).filter((application) => application.metadata.projectId !== projectId);
      candidate.applicationPublicationPointers = (candidate.applicationPublicationPointers ?? []).filter((pointer) => pointer.projectId !== projectId);
      for (const endpointId of endpointIds) delete candidate.dataEndpointSecrets?.[endpointId];
      return changed(true);
    });
  }

  async addModel(projectId: string, model: ModelRecord): Promise<void> {
    return this.runDocumentMutation((candidate) => {
      const project = requireProject(candidate, projectId);
      project.models.push(structuredClone(model));
      project.updatedAt = new Date().toISOString();
      return changed(undefined);
    });
  }

  async updateModel(projectId: string, modelId: string, updates: Partial<ModelRecord>): Promise<ModelRecord> {
    return this.runDocumentMutation((candidate) => {
      const project = requireProject(candidate, projectId);
      const model = project.models.find((item) => item.id === modelId);
      if (!model) throw new Error(`Model not found: ${modelId}`);
      Object.assign(model, structuredClone(updates), { updatedAt: new Date().toISOString() });
      project.updatedAt = model.updatedAt;
      return changed(structuredClone(model));
    });
  }

  async removeModel(projectId: string, modelId: string): Promise<boolean> {
    return this.runDocumentMutation((candidate) => {
      const project = requireProject(candidate, projectId);
      const originalLength = project.models.length;
      project.models = project.models.filter((item) => item.id !== modelId);
      if (project.models.length === originalLength) return unchanged(false);
      project.updatedAt = new Date().toISOString();
      return changed(true);
    });
  }

  listAssets(projectId: string): ProjectAssetRecord[] {
    return structuredClone(this.requireProject(projectId).assets ?? []);
  }

  async saveAsset(projectId: string, asset: ProjectAssetRecord): Promise<ProjectAssetRecord> {
    return this.runDocumentMutation((candidate) => {
      const project = requireProject(candidate, projectId);
      project.assets ??= [];
      const index = project.assets.findIndex((item) => item.id === asset.id);
      if (index >= 0) project.assets[index] = structuredClone(asset);
      else project.assets.push(structuredClone(asset));
      project.updatedAt = new Date().toISOString();
      return changed(structuredClone(asset));
    });
  }

  async removeAsset(projectId: string, assetId: string): Promise<boolean> {
    return this.runDocumentMutation((candidate) => {
      const project = requireProject(candidate, projectId);
      const originalLength = project.assets?.length ?? 0;
      project.assets = (project.assets ?? []).filter((item) => item.id !== assetId);
      if (project.assets.length === originalLength) return unchanged(false);
      project.updatedAt = new Date().toISOString();
      return changed(true);
    });
  }

  listDataConnections(projectId: string): DataConnectionRecord[] {
    return structuredClone(this.requireProject(projectId).dataConnections ?? []);
  }

  async saveDataConnection(projectId: string, connection: DataConnectionRecord): Promise<DataConnectionRecord> {
    return this.runDocumentMutation((candidate) => {
      const project = requireProject(candidate, projectId);
      project.dataConnections ??= [];
      const index = project.dataConnections.findIndex((item) => item.id === connection.id);
      if (index >= 0) project.dataConnections[index] = structuredClone(connection);
      else project.dataConnections.push(structuredClone(connection));
      project.updatedAt = new Date().toISOString();
      return changed(structuredClone(connection));
    });
  }

  listUnityResources(projectId: string): UnityResourceRecord[] {
    return structuredClone(this.requireProject(projectId).unityResources ?? []);
  }

  getUnityResource(projectId: string, resourceId: string): UnityResourceRecord | undefined {
    const resource = this.requireProject(projectId).unityResources?.find((item) => item.id === resourceId);
    return resource ? structuredClone(resource) : undefined;
  }

  async saveUnityResource(projectId: string, resource: UnityResourceRecord): Promise<UnityResourceRecord> {
    return this.runDocumentMutation((candidate) => {
      const project = requireProject(candidate, projectId);
      project.unityResources ??= [];
      const index = project.unityResources.findIndex((item) => item.id === resource.id);
      if (index >= 0) project.unityResources[index] = structuredClone(resource);
      else project.unityResources.push(structuredClone(resource));
      project.updatedAt = new Date().toISOString();
      return changed(structuredClone(resource));
    });
  }

  async activateUnityResourceVersion(projectId: string, resourceId: string, versionId: string): Promise<UnityResourceRecord | undefined> {
    return this.runDocumentMutation((candidate) => {
      const project = requireProject(candidate, projectId);
      const resource = project.unityResources?.find((item) => item.id === resourceId);
      if (!resource || !resource.versions.some((version) => version.id === versionId)) return unchanged(undefined);
      resource.activeVersionId = versionId;
      resource.updatedAt = new Date().toISOString();
      project.updatedAt = resource.updatedAt;
      return changed(structuredClone(resource));
    });
  }

  async removeUnityResource(projectId: string, resourceId: string): Promise<boolean> {
    return this.runDocumentMutation((candidate) => {
      const project = requireProject(candidate, projectId);
      const resources = project.unityResources ?? [];
      const next = resources.filter((item) => item.id !== resourceId);
      if (next.length === resources.length) return unchanged(false);
      project.unityResources = next;
      project.updatedAt = new Date().toISOString();
      return changed(true);
    });
  }

  async removeDataConnection(projectId: string, connectionId: string): Promise<boolean> {
    return this.runDocumentMutation((candidate) => {
      const project = requireProject(candidate, projectId);
      const originalLength = project.dataConnections?.length ?? 0;
      const removedDatasetIds = new Set(
        (project.datasets ?? [])
          .filter((item) => item.connectionId === connectionId)
          .map((item) => item.id),
      );
      project.dataConnections = (project.dataConnections ?? []).filter((item) => item.id !== connectionId);
      if (project.dataConnections.length === originalLength) return unchanged(false);
      project.datasets = (project.datasets ?? []).filter((item) => item.connectionId !== connectionId);
      project.aiDataBindings = (project.aiDataBindings ?? []).filter(
        (item) => !removedDatasetIds.has(item.datasetId),
      );
      project.updatedAt = new Date().toISOString();
      return changed(true);
    });
  }

  listDatasets(projectId: string): DataDatasetRecord[] {
    return structuredClone(this.requireProject(projectId).datasets ?? []);
  }

  async saveDataset(projectId: string, dataset: DataDatasetRecord): Promise<DataDatasetRecord> {
    return this.runDocumentMutation((candidate) => {
      const project = requireProject(candidate, projectId);
      if (!(project.dataConnections ?? []).some((item) => item.id === dataset.connectionId)) throw new Error(`Data connection not found: ${dataset.connectionId}`);
      project.datasets ??= [];
      const index = project.datasets.findIndex((item) => item.id === dataset.id);
      if (index >= 0) project.datasets[index] = structuredClone(dataset);
      else project.datasets.push(structuredClone(dataset));
      project.updatedAt = new Date().toISOString();
      return changed(structuredClone(dataset));
    });
  }

  async removeDataset(projectId: string, datasetId: string): Promise<boolean> {
    return this.runDocumentMutation((candidate) => {
      const project = requireProject(candidate, projectId);
      const originalLength = project.datasets?.length ?? 0;
      project.datasets = (project.datasets ?? []).filter((item) => item.id !== datasetId);
      if (project.datasets.length === originalLength) return unchanged(false);
      project.aiDataBindings = (project.aiDataBindings ?? []).filter((item) => item.datasetId !== datasetId);
      project.updatedAt = new Date().toISOString();
      return changed(true);
    });
  }

  listAiDataBindings(projectId: string): AiDataBinding[] {
    return structuredClone(this.requireProject(projectId).aiDataBindings ?? []);
  }

  getAiDataBinding(projectId: string, bindingId: string): AiDataBinding | undefined {
    const binding = this.requireProject(projectId).aiDataBindings?.find((item) => item.id === bindingId);
    return binding ? structuredClone(binding) : undefined;
  }

  async saveAiDataBinding(projectId: string, binding: AiDataBinding): Promise<AiDataBinding> {
    return this.runDocumentMutation((candidate) => {
      const project = requireProject(candidate, projectId);
      if (binding.projectId !== projectId) throw new Error(`AI data binding project mismatch: ${binding.projectId}`);
      if (!(project.datasets ?? []).some((item) => item.id === binding.datasetId)) {
        throw new Error(`Data dataset not found: ${binding.datasetId}`);
      }
      project.aiDataBindings ??= [];
      upsert(project.aiDataBindings, binding);
      project.updatedAt = new Date().toISOString();
      return changed(structuredClone(binding));
    });
  }

  async removeAiDataBinding(projectId: string, bindingId: string): Promise<boolean> {
    return this.runDocumentMutation((candidate) => {
      const project = requireProject(candidate, projectId);
      const originalLength = project.aiDataBindings?.length ?? 0;
      project.aiDataBindings = (project.aiDataBindings ?? []).filter((item) => item.id !== bindingId);
      if (project.aiDataBindings.length === originalLength) return unchanged(false);
      project.updatedAt = new Date().toISOString();
      return changed(true);
    });
  }

  listAiDataBindingRuns(projectId: string, query: AiDataBindingRunQuery = {}): AiDataBindingRunRecord[] {
    const limit = Math.min(MAX_AI_DATA_BINDING_RUNS_PER_PROJECT, Math.max(0, Math.trunc(query.limit ?? MAX_AI_DATA_BINDING_RUNS_PER_PROJECT)));
    const records = newestAiDataBindingRuns(this.requireProject(projectId).aiDataBindingRuns ?? [])
      .filter((item) => !query.bindingId || item.bindingId === query.bindingId)
      .filter((item) => !query.status || item.status === query.status)
      .slice(0, limit);
    return structuredClone(records);
  }

  getAiDataBindingRun(projectId: string, runId: string): AiDataBindingRunRecord | undefined {
    const run = this.requireProject(projectId).aiDataBindingRuns?.find((item) => item.id === runId);
    return run ? structuredClone(run) : undefined;
  }

  async saveAiDataBindingRun(projectId: string, run: AiDataBindingRunRecord): Promise<AiDataBindingRunRecord> {
    return this.runDocumentMutation((candidate) => {
      const project = requireProject(candidate, projectId);
      if (run.projectId !== projectId) throw new Error(`AI data binding run project mismatch: ${run.projectId}`);
      project.aiDataBindingRuns ??= [];
      upsert(project.aiDataBindingRuns, run);
      project.aiDataBindingRuns = retainRecentAiDataBindingRuns(project.aiDataBindingRuns);
      project.updatedAt = new Date().toISOString();
      return changed(structuredClone(run));
    });
  }

  listDataPipelines(projectId: string): DataPipelineDefinition[] {
    return structuredClone(this.requireProject(projectId).dataPipelines ?? []);
  }

  async saveDataPipeline(projectId: string, pipeline: DataPipelineDefinition): Promise<DataPipelineDefinition> {
    return this.runDocumentMutation((candidate) => {
      const project = requireProject(candidate, projectId);
      const datasetIds = new Set((project.datasets ?? []).map((dataset) => dataset.id));
      for (const node of pipeline.nodes) {
        if (node.type === "source" && !datasetIds.has(node.datasetId)) throw new Error(`Data dataset not found: ${node.datasetId}`);
      }
      project.dataPipelines ??= [];
      const index = project.dataPipelines.findIndex((item) => item.id === pipeline.id);
      if (index >= 0) project.dataPipelines[index] = structuredClone(pipeline);
      else project.dataPipelines.push(structuredClone(pipeline));
      project.updatedAt = new Date().toISOString();
      return changed(structuredClone(pipeline));
    });
  }

  async removeDataPipeline(projectId: string, pipelineId: string): Promise<boolean> {
    return this.runDocumentMutation((candidate) => {
      const project = requireProject(candidate, projectId);
      const originalLength = project.dataPipelines?.length ?? 0;
      project.dataPipelines = (project.dataPipelines ?? []).filter((item) => item.id !== pipelineId);
      if (project.dataPipelines.length === originalLength) return unchanged(false);
      project.updatedAt = new Date().toISOString();
      return changed(true);
    });
  }

  listDataEndpoints(projectId: string): DataEndpointDefinition[] {
    return structuredClone(this.requireProject(projectId).dataEndpoints ?? []);
  }

  async saveDataEndpoint(projectId: string, endpoint: DataEndpointDefinition, secretHash?: string): Promise<DataEndpointDefinition> {
    return this.runDocumentMutation((candidate) => {
      const project = requireProject(candidate, projectId);
      if (!(project.dataPipelines ?? []).some((pipeline) => pipeline.id === endpoint.pipelineId)) throw new Error(`Data pipeline not found: ${endpoint.pipelineId}`);
      project.dataEndpoints ??= [];
      const index = project.dataEndpoints.findIndex((item) => item.id === endpoint.id);
      if (index >= 0) project.dataEndpoints[index] = structuredClone(endpoint);
      else project.dataEndpoints.push(structuredClone(endpoint));
      if (secretHash) {
        candidate.dataEndpointSecrets ??= {};
        candidate.dataEndpointSecrets[endpoint.id] = secretHash;
      }
      project.updatedAt = new Date().toISOString();
      return changed(structuredClone(endpoint));
    });
  }

  getDataEndpointSecretHash(endpointId: string): string | undefined {
    return this.document.dataEndpointSecrets?.[endpointId];
  }

  async removeDataEndpoint(projectId: string, endpointId: string): Promise<boolean> {
    return this.runDocumentMutation((candidate) => {
      const project = requireProject(candidate, projectId);
      const originalLength = project.dataEndpoints?.length ?? 0;
      project.dataEndpoints = (project.dataEndpoints ?? []).filter((item) => item.id !== endpointId);
      if (project.dataEndpoints.length === originalLength) return unchanged(false);
      delete candidate.dataEndpointSecrets?.[endpointId];
      project.updatedAt = new Date().toISOString();
      return changed(true);
    });
  }

  listVisionSources(projectId: string): VisionSourceRecord[] {
    return structuredClone(this.requireProject(projectId).visionSources ?? []);
  }

  async saveVisionSource(projectId: string, source: VisionSourceRecord): Promise<VisionSourceRecord> {
    return this.runDocumentMutation((candidate) => {
      const project = requireProject(candidate, projectId);
      project.visionSources ??= [];
      upsert(project.visionSources, source);
      project.updatedAt = new Date().toISOString();
      return changed(structuredClone(source));
    });
  }

  async removeVisionSource(projectId: string, sourceId: string): Promise<boolean> {
    return this.runDocumentMutation((candidate) => {
      const project = requireProject(candidate, projectId);
      const original = project.visionSources?.length ?? 0;
      project.visionSources = (project.visionSources ?? []).filter((item) => item.id !== sourceId);
      if (project.visionSources.length === original) return unchanged(false);
      for (const task of project.visionTasks ?? []) if (task.sourceId === sourceId) Object.assign(task, { enabled: false, status: "stopped", message: "视觉源已删除" });
      project.updatedAt = new Date().toISOString();
      return changed(true);
    });
  }

  listVisionModels(projectId: string): VisionModelRecord[] {
    return structuredClone(this.requireProject(projectId).visionModels ?? []);
  }

  getVisionModel(projectId: string, modelId: string): VisionModelRecord | undefined {
    const model = (this.requireProject(projectId).visionModels ?? []).find((item) => item.id === modelId);
    return model ? structuredClone(model) : undefined;
  }

  async saveVisionModel(projectId: string, model: VisionModelRecord): Promise<VisionModelRecord> {
    return this.runDocumentMutation((candidate) => {
      const project = requireProject(candidate, projectId);
      project.visionModels ??= [];
      upsert(project.visionModels, model);
      project.updatedAt = new Date().toISOString();
      return changed(structuredClone(model));
    });
  }

  async removeVisionModel(projectId: string, modelId: string): Promise<boolean> {
    return this.runDocumentMutation((candidate) => {
      const project = requireProject(candidate, projectId);
      const original = project.visionModels?.length ?? 0;
      project.visionModels = (project.visionModels ?? []).filter((item) => item.id !== modelId);
      if (project.visionModels.length === original) return unchanged(false);
      for (const task of project.visionTasks ?? []) if (task.modelId === modelId) Object.assign(task, { enabled: false, status: "stopped", message: "AI 模型已删除" });
      project.updatedAt = new Date().toISOString();
      return changed(true);
    });
  }

  listVisionTasks(projectId: string): VisionTaskRecord[] {
    return structuredClone(this.requireProject(projectId).visionTasks ?? []);
  }

  getVisionTask(projectId: string, taskId: string): VisionTaskRecord | undefined {
    const task = (this.requireProject(projectId).visionTasks ?? []).find((item) => item.id === taskId);
    return task ? structuredClone(task) : undefined;
  }

  async saveVisionTask(projectId: string, task: VisionTaskRecord): Promise<VisionTaskRecord> {
    return this.runDocumentMutation((candidate) => {
      const project = requireProject(candidate, projectId);
      project.visionTasks ??= [];
      upsert(project.visionTasks, task);
      project.updatedAt = new Date().toISOString();
      return changed(structuredClone(task));
    });
  }

  async removeVisionTask(projectId: string, taskId: string): Promise<boolean> {
    return this.runDocumentMutation((candidate) => {
      const project = requireProject(candidate, projectId);
      const original = project.visionTasks?.length ?? 0;
      project.visionTasks = (project.visionTasks ?? []).filter((item) => item.id !== taskId);
      if (project.visionTasks.length === original) return unchanged(false);
      project.updatedAt = new Date().toISOString();
      return changed(true);
    });
  }

  listVisionEvents(projectId: string, limit = 200): VisionEventRecord[] {
    return structuredClone((this.requireProject(projectId).visionEvents ?? []).slice(-Math.max(1, limit)).reverse());
  }

  getVisionEvent(projectId: string, eventId: string): VisionEventRecord | undefined {
    const event = (this.requireProject(projectId).visionEvents ?? []).find((item) => item.id === eventId);
    return event ? structuredClone(event) : undefined;
  }

  async saveVisionEvent(projectId: string, event: VisionEventRecord): Promise<VisionEventRecord> {
    return this.runDocumentMutation((candidate) => {
      const project = requireProject(candidate, projectId);
      project.visionEvents ??= [];
      upsert(project.visionEvents, event);
      if (project.visionEvents.length > 2_000) project.visionEvents.splice(0, project.visionEvents.length - 2_000);
      project.updatedAt = new Date().toISOString();
      return changed(structuredClone(event));
    });
  }

  listScenes(projectId: string): SceneSnapshot[] {
    return structuredClone(this.document.scenes.filter((scene) => scene.projectId === projectId).sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)));
  }

  getScene(projectId: string, sceneId: string): SceneSnapshot | undefined {
    const scene = this.document.scenes.find((item) => item.projectId === projectId && item.id === sceneId);
    return scene ? structuredClone(scene) : undefined;
  }

  getSceneById(sceneId: string): SceneSnapshot | undefined {
    const scene = this.document.scenes.find((item) => item.id === sceneId);
    return scene ? structuredClone(scene) : undefined;
  }

  async saveScene(scene: SceneSnapshot): Promise<SceneSnapshot> {
    return this.runDocumentMutation((candidate) => {
      const index = candidate.scenes.findIndex((item) => item.projectId === scene.projectId && item.id === scene.id);
      if (index >= 0) candidate.scenes[index] = structuredClone(scene);
      else candidate.scenes.push(structuredClone(scene));
      return changed(structuredClone(scene));
    });
  }

  async removeScene(projectId: string, sceneId: string): Promise<boolean> {
    return this.runDocumentMutation((candidate) => {
      const originalLength = candidate.scenes.length;
      candidate.scenes = candidate.scenes.filter((item) => item.projectId !== projectId || item.id !== sceneId);
      if (candidate.scenes.length === originalLength) return unchanged(false);
      candidate.publishedScenes = (candidate.publishedScenes ?? []).filter((item) => item.sceneId !== sceneId);
      candidate.scenePublicationHistory = (candidate.scenePublicationHistory ?? []).filter((item) => item.sceneId !== sceneId);
      return changed(true);
    });
  }

  getPublication(sceneId: string): PublishedSceneRecord | undefined {
    const publication = (this.document.publishedScenes ?? []).find((item) => item.sceneId === sceneId);
    return publication ? structuredClone(publication) : undefined;
  }

  async savePublication(publication: PublishedSceneRecord): Promise<PublishedSceneRecord> {
    return this.runDocumentMutation((candidate) => {
      candidate.publishedScenes ??= [];
      candidate.scenePublicationHistory ??= [];
      const version = Math.max(0, ...candidate.scenePublicationHistory.filter((item) => item.sceneId === publication.sceneId).map((item) => item.version ?? 0)) + 1;
      const versioned: PublishedSceneRecord = { ...structuredClone(publication), version };
      const index = candidate.publishedScenes.findIndex((item) => item.sceneId === publication.sceneId);
      if (index >= 0) candidate.publishedScenes[index] = versioned;
      else candidate.publishedScenes.push(versioned);
      candidate.scenePublicationHistory.push(structuredClone(versioned));
      const recent = candidate.scenePublicationHistory
        .filter((item) => item.sceneId === publication.sceneId)
        .sort((left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt))
        .slice(0, 50);
      candidate.scenePublicationHistory = candidate.scenePublicationHistory.filter((item) => item.sceneId !== publication.sceneId).concat(recent);
      return changed(structuredClone(versioned));
    });
  }

  listScenePublications(sceneId: string): PublishedSceneRecord[] {
    return structuredClone(
      (this.document.scenePublicationHistory ?? []).filter((item) => item.sceneId === sceneId).sort((left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt)),
    );
  }

  async removePublication(sceneId: string): Promise<boolean> {
    return this.runDocumentMutation((candidate) => {
      const publications = candidate.publishedScenes ?? [];
      const originalLength = publications.length;
      candidate.publishedScenes = publications.filter((item) => item.sceneId !== sceneId);
      if (candidate.publishedScenes.length === originalLength) return unchanged(false);
      const scene = candidate.scenes.find((item) => item.id === sceneId);
      if (scene) delete scene.publishedAt;
      return changed(true);
    });
  }

  listApplications(projectId: string): ApplicationDocument[] {
    return structuredClone(
      (this.document.applications ?? [])
        .filter((item) => item.metadata.projectId === projectId)
        .sort((left, right) => Date.parse(right.metadata.updatedAt) - Date.parse(left.metadata.updatedAt)),
    );
  }

  getApplication(projectId: string, applicationId: string): ApplicationDocument | undefined {
    const item = (this.document.applications ?? []).find((candidate) => candidate.metadata.projectId === projectId && candidate.metadata.id === applicationId);
    return item ? structuredClone(item) : undefined;
  }

  getApplicationById(applicationId: string): ApplicationDocument | undefined {
    const item = (this.document.applications ?? []).find((candidate) => candidate.metadata.id === applicationId);
    return item ? structuredClone(item) : undefined;
  }

  getApplicationIdReservation(applicationId: string): ApplicationIdReservation | undefined {
    return applicationIdReservation(this.document, applicationId);
  }

  async createApplicationDraft(projectId: string, application: ApplicationDocument, now: string): Promise<CreateApplicationDraftResult> {
    assertPathSafeResourceId(projectId, "projectId");
    assertApplicationDocument(application);
    return this.runDocumentMutation<CreateApplicationDraftResult>((candidate) => {
      if (!candidate.projects.some((project) => project.id === projectId)) return unchanged({ status: "project-not-found" });
      const reservation = applicationIdReservation(candidate, application.metadata.id);
      if (reservation) return unchanged({ status: "conflict", reservation });
      const saved: ApplicationDocument = {
        ...structuredClone(application),
        metadata: {
          ...structuredClone(application.metadata),
          projectId,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        },
      };
      candidate.applications ??= [];
      candidate.applications.push(saved);
      return changed({ status: "created", application: structuredClone(saved) });
    });
  }

  async updateApplicationDraft(projectId: string, applicationId: string, application: ApplicationDocument, now: string): Promise<UpdateApplicationDraftResult> {
    assertPathSafeResourceId(projectId, "projectId");
    assertPathSafeResourceId(applicationId, "applicationId");
    assertApplicationDocument(application);
    return this.runDocumentMutation<UpdateApplicationDraftResult>((candidate) => {
      if (!candidate.projects.some((project) => project.id === projectId)) return unchanged({ status: "project-not-found" });
      const index = (candidate.applications ?? []).findIndex((item) => item.metadata.projectId === projectId && item.metadata.id === applicationId);
      if (index < 0) return unchanged({ status: "application-not-found" });
      const current = candidate.applications![index]!;
      if (application.metadata.revision !== current.metadata.revision) {
        return unchanged({ status: "revision-conflict", currentRevision: current.metadata.revision });
      }
      const saved: ApplicationDocument = {
        ...structuredClone(application),
        metadata: {
          ...structuredClone(application.metadata),
          id: applicationId,
          projectId,
          revision: current.metadata.revision + 1,
          createdAt: current.metadata.createdAt,
          updatedAt: now,
        },
      };
      candidate.applications![index] = saved;
      return changed({ status: "updated", application: structuredClone(saved) });
    });
  }

  async saveApplicationWorkspace(
    projectId: string,
    applicationId: string,
    application: ApplicationDocument,
    scene: SceneSnapshot,
    now: string,
  ): Promise<SaveApplicationWorkspaceResult> {
    assertPathSafeResourceId(projectId, "projectId");
    assertPathSafeResourceId(applicationId, "applicationId");
    assertApplicationDocument(application);
    if (scene.schemaVersion !== 1 || scene.projectId !== projectId) throw new Error("场景格式或项目归属无效");
    return this.runDocumentMutation<SaveApplicationWorkspaceResult>((candidate) => {
      if (!candidate.projects.some((project) => project.id === projectId)) return unchanged({ status: "project-not-found" });
      const applicationIndex = (candidate.applications ?? []).findIndex((item) => item.metadata.projectId === projectId && item.metadata.id === applicationId);
      if (applicationIndex < 0) return unchanged({ status: "application-not-found" });
      const current = candidate.applications![applicationIndex]!;
      if (application.metadata.revision !== current.metadata.revision) return unchanged({ status: "revision-conflict", currentRevision: current.metadata.revision });
      const savedApplication: ApplicationDocument = {
        ...structuredClone(application),
        metadata: {
          ...structuredClone(application.metadata),
          id: applicationId,
          projectId,
          revision: current.metadata.revision + 1,
          createdAt: current.metadata.createdAt,
          updatedAt: now,
        },
      };
      const existingScene = candidate.scenes.find((item) => item.projectId === projectId && item.id === scene.id);
      const savedScene: SceneSnapshot = { ...structuredClone(scene), projectId, createdAt: existingScene?.createdAt ?? scene.createdAt ?? now, updatedAt: now };
      candidate.applications![applicationIndex] = savedApplication;
      const sceneIndex = candidate.scenes.findIndex((item) => item.projectId === projectId && item.id === scene.id);
      if (sceneIndex >= 0) candidate.scenes[sceneIndex] = savedScene;
      else candidate.scenes.push(savedScene);
      return changed({ status: "updated", application: structuredClone(savedApplication), scene: structuredClone(savedScene) });
    });
  }

  async deleteApplicationDraft(projectId: string, applicationId: string): Promise<DeleteApplicationDraftResult> {
    assertPathSafeResourceId(projectId, "projectId");
    assertPathSafeResourceId(applicationId, "applicationId");
    return this.runDocumentMutation<DeleteApplicationDraftResult>((candidate) => {
      if (!candidate.projects.some((project) => project.id === projectId)) return unchanged({ status: "project-not-found" });
      const index = (candidate.applications ?? []).findIndex((item) => item.metadata.projectId === projectId && item.metadata.id === applicationId);
      if (index < 0) return unchanged({ status: "application-not-found" });
      if ((candidate.applicationPublicationPointers ?? []).some((pointer) => pointer.applicationId === applicationId)) {
        return unchanged({ status: "active-publication" });
      }
      candidate.applications!.splice(index, 1);
      return changed({ status: "deleted" });
    });
  }

  async publishApplication(projectId: string, applicationId: string, publicationId: string, publishedAt: string): Promise<PublishApplicationResult> {
    assertPathSafeResourceId(projectId, "projectId");
    assertPathSafeResourceId(applicationId, "applicationId");
    return this.runDocumentMutation<PublishApplicationResult>((candidate) => {
      if (!candidate.projects.some((project) => project.id === projectId)) return unchanged({ status: "project-not-found" });
      const application = (candidate.applications ?? []).find((item) => item.metadata.projectId === projectId && item.metadata.id === applicationId);
      if (!application) return unchanged({ status: "application-not-found" });
      candidate.publishedApplications ??= [];
      if (candidate.publishedApplications.some((publication) => publication.id === publicationId)) {
        throw new Error(`发布版本 ${publicationId} 已存在`);
      }
      const publication: PublishedApplicationRecord = {
        id: publicationId,
        applicationId,
        projectId,
        applicationRevision: application.metadata.revision,
        document: structuredClone(application),
        publishedAt,
      };
      candidate.publishedApplications.push(publication);
      const pointer: ApplicationPublicationPointer = {
        applicationId,
        projectId,
        activePublicationId: publicationId,
        updatedAt: publishedAt,
      };
      candidate.applicationPublicationPointers ??= [];
      const pointerIndex = candidate.applicationPublicationPointers.findIndex((item) => item.applicationId === applicationId);
      if (pointerIndex >= 0) candidate.applicationPublicationPointers[pointerIndex] = pointer;
      else candidate.applicationPublicationPointers.push(pointer);
      return changed({ status: "published", publication: structuredClone(publication) });
    });
  }

  async unpublishApplication(projectId: string, applicationId: string): Promise<UnpublishApplicationResult> {
    assertPathSafeResourceId(projectId, "projectId");
    assertPathSafeResourceId(applicationId, "applicationId");
    return this.runDocumentMutation<UnpublishApplicationResult>((candidate) => {
      if (!candidate.projects.some((project) => project.id === projectId)) return unchanged({ status: "project-not-found" });
      const application = (candidate.applications ?? []).find((item) => item.metadata.projectId === projectId && item.metadata.id === applicationId);
      if (!application) return unchanged({ status: "application-not-found" });
      const pointerIndex = (candidate.applicationPublicationPointers ?? []).findIndex((pointer) => pointer.applicationId === applicationId && pointer.projectId === projectId);
      if (pointerIndex < 0) return unchanged({ status: "not-published" });
      candidate.applicationPublicationPointers!.splice(pointerIndex, 1);
      return changed({ status: "unpublished" });
    });
  }

  getPublishedApplication(publicationId: string): PublishedApplicationRecord | undefined {
    const item = (this.document.publishedApplications ?? []).find((candidate) => candidate.id === publicationId);
    return item ? structuredClone(item) : undefined;
  }

  listApplicationPublications(applicationId: string): PublishedApplicationRecord[] {
    return structuredClone((this.document.publishedApplications ?? []).filter((item) => item.applicationId === applicationId));
  }

  getApplicationPublicationPointer(applicationId: string): ApplicationPublicationPointer | undefined {
    const item = (this.document.applicationPublicationPointers ?? []).find((candidate) => candidate.applicationId === applicationId);
    return item ? structuredClone(item) : undefined;
  }
}
