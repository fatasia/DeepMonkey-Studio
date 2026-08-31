import type {
  AiDataBinding,
  AiDataBindingRunRecord,
  AiDataBindingRunStatus,
  AiProviderSettings,
  ApplicationDocument,
  ApplicationPublicationPointer,
  AuditLogRecord,
  DataConnectionRecord,
  DataDatasetRecord,
  DataEndpointDefinition,
  DataPipelineDefinition,
  DatabaseDocument,
  ModelRecord,
  ProjectAssetRecord,
  ProjectRecord,
  PublishedApplicationRecord,
  PublishedSceneRecord,
  SceneSnapshot,
  StoredSystemUserRecord,
  SystemBrandingSettings,
  UnityResourceRecord,
  VisionEventRecord,
  VisionModelRecord,
  VisionSourceRecord,
  VisionTaskRecord,
} from "@bim-studio/contracts";

export interface ApplicationIdReservation {
  projectId: string;
  currentRevision: number;
}

export type CreateApplicationDraftResult =
  | { status: "created"; application: ApplicationDocument }
  | { status: "project-not-found" }
  | { status: "conflict"; reservation: ApplicationIdReservation };

export type UpdateApplicationDraftResult =
  | { status: "updated"; application: ApplicationDocument }
  | { status: "project-not-found" }
  | { status: "application-not-found" }
  | { status: "revision-conflict"; currentRevision: number };

export type SaveApplicationWorkspaceResult =
  | { status: "updated"; application: ApplicationDocument; scene: SceneSnapshot }
  | { status: "project-not-found" }
  | { status: "application-not-found" }
  | { status: "revision-conflict"; currentRevision: number };

export type DeleteApplicationDraftResult = {
  status: "deleted" | "project-not-found" | "application-not-found" | "active-publication";
};

export type PublishApplicationResult = { status: "published"; publication: PublishedApplicationRecord } | { status: "project-not-found" } | { status: "application-not-found" };

export type UnpublishApplicationResult = {
  status: "unpublished" | "project-not-found" | "application-not-found" | "not-published";
};

export interface AiDataBindingRunQuery {
  bindingId?: string;
  status?: AiDataBindingRunStatus;
  limit?: number;
}

export interface MetadataStore {
  init(): Promise<void>;
  listProjects(): ProjectRecord[];
  getProject(projectId: string): ProjectRecord | undefined;
  createProject(name: string, description?: string): Promise<ProjectRecord>;
  updateProject(projectId: string, updates: Pick<Partial<ProjectRecord>, "name" | "description">): Promise<ProjectRecord>;
  removeProject(projectId: string): Promise<boolean>;
  addModel(projectId: string, model: ModelRecord): Promise<void>;
  updateModel(projectId: string, modelId: string, updates: Partial<ModelRecord>): Promise<ModelRecord>;
  removeModel(projectId: string, modelId: string): Promise<boolean>;
  listAssets(projectId: string): ProjectAssetRecord[];
  saveAsset(projectId: string, asset: ProjectAssetRecord): Promise<ProjectAssetRecord>;
  removeAsset(projectId: string, assetId: string): Promise<boolean>;
  listUnityResources(projectId: string): UnityResourceRecord[];
  getUnityResource(projectId: string, resourceId: string): UnityResourceRecord | undefined;
  saveUnityResource(projectId: string, resource: UnityResourceRecord): Promise<UnityResourceRecord>;
  activateUnityResourceVersion(projectId: string, resourceId: string, versionId: string): Promise<UnityResourceRecord | undefined>;
  removeUnityResource(projectId: string, resourceId: string): Promise<boolean>;
  listDataConnections(projectId: string): DataConnectionRecord[];
  saveDataConnection(projectId: string, connection: DataConnectionRecord): Promise<DataConnectionRecord>;
  removeDataConnection(projectId: string, connectionId: string): Promise<boolean>;
  listDatasets(projectId: string): DataDatasetRecord[];
  saveDataset(projectId: string, dataset: DataDatasetRecord): Promise<DataDatasetRecord>;
  removeDataset(projectId: string, datasetId: string): Promise<boolean>;
  listAiDataBindings(projectId: string): AiDataBinding[];
  getAiDataBinding(projectId: string, bindingId: string): AiDataBinding | undefined;
  saveAiDataBinding(projectId: string, binding: AiDataBinding): Promise<AiDataBinding>;
  removeAiDataBinding(projectId: string, bindingId: string): Promise<boolean>;
  listAiDataBindingRuns(projectId: string, query?: AiDataBindingRunQuery): AiDataBindingRunRecord[];
  getAiDataBindingRun(projectId: string, runId: string): AiDataBindingRunRecord | undefined;
  saveAiDataBindingRun(projectId: string, run: AiDataBindingRunRecord): Promise<AiDataBindingRunRecord>;
  listDataPipelines(projectId: string): DataPipelineDefinition[];
  saveDataPipeline(projectId: string, pipeline: DataPipelineDefinition): Promise<DataPipelineDefinition>;
  removeDataPipeline(projectId: string, pipelineId: string): Promise<boolean>;
  listDataEndpoints(projectId: string): DataEndpointDefinition[];
  saveDataEndpoint(projectId: string, endpoint: DataEndpointDefinition, secretHash?: string): Promise<DataEndpointDefinition>;
  getDataEndpointSecretHash(endpointId: string): string | undefined;
  removeDataEndpoint(projectId: string, endpointId: string): Promise<boolean>;
  listVisionSources(projectId: string): VisionSourceRecord[];
  saveVisionSource(projectId: string, source: VisionSourceRecord): Promise<VisionSourceRecord>;
  removeVisionSource(projectId: string, sourceId: string): Promise<boolean>;
  listVisionModels(projectId: string): VisionModelRecord[];
  getVisionModel(projectId: string, modelId: string): VisionModelRecord | undefined;
  saveVisionModel(projectId: string, model: VisionModelRecord): Promise<VisionModelRecord>;
  removeVisionModel(projectId: string, modelId: string): Promise<boolean>;
  listVisionTasks(projectId: string): VisionTaskRecord[];
  getVisionTask(projectId: string, taskId: string): VisionTaskRecord | undefined;
  saveVisionTask(projectId: string, task: VisionTaskRecord): Promise<VisionTaskRecord>;
  removeVisionTask(projectId: string, taskId: string): Promise<boolean>;
  listVisionEvents(projectId: string, limit?: number): VisionEventRecord[];
  getVisionEvent(projectId: string, eventId: string): VisionEventRecord | undefined;
  saveVisionEvent(projectId: string, event: VisionEventRecord): Promise<VisionEventRecord>;
  listScenes(projectId: string): SceneSnapshot[];
  getScene(projectId: string, sceneId: string): SceneSnapshot | undefined;
  getSceneById(sceneId: string): SceneSnapshot | undefined;
  saveScene(scene: SceneSnapshot): Promise<SceneSnapshot>;
  removeScene(projectId: string, sceneId: string): Promise<boolean>;
  getPublication(sceneId: string): PublishedSceneRecord | undefined;
  listScenePublications(sceneId: string): PublishedSceneRecord[];
  savePublication(publication: PublishedSceneRecord): Promise<PublishedSceneRecord>;
  removePublication(sceneId: string): Promise<boolean>;
  listApplications(projectId: string): ApplicationDocument[];
  getApplication(projectId: string, applicationId: string): ApplicationDocument | undefined;
  getApplicationById(applicationId: string): ApplicationDocument | undefined;
  getApplicationIdReservation(applicationId: string): ApplicationIdReservation | undefined;
  createApplicationDraft(projectId: string, application: ApplicationDocument, now: string): Promise<CreateApplicationDraftResult>;
  updateApplicationDraft(projectId: string, applicationId: string, application: ApplicationDocument, now: string): Promise<UpdateApplicationDraftResult>;
  saveApplicationWorkspace(projectId: string, applicationId: string, application: ApplicationDocument, scene: SceneSnapshot, now: string): Promise<SaveApplicationWorkspaceResult>;
  deleteApplicationDraft(projectId: string, applicationId: string): Promise<DeleteApplicationDraftResult>;
  publishApplication(projectId: string, applicationId: string, publicationId: string, publishedAt: string): Promise<PublishApplicationResult>;
  unpublishApplication(projectId: string, applicationId: string): Promise<UnpublishApplicationResult>;
  getPublishedApplication(publicationId: string): PublishedApplicationRecord | undefined;
  listApplicationPublications(applicationId: string): PublishedApplicationRecord[];
  getApplicationPublicationPointer(applicationId: string): ApplicationPublicationPointer | undefined;
  listUsers(): StoredSystemUserRecord[];
  getUser(userId: string): StoredSystemUserRecord | undefined;
  findUserByUsername(username: string): StoredSystemUserRecord | undefined;
  saveUser(user: StoredSystemUserRecord): Promise<StoredSystemUserRecord>;
  removeUser(userId: string): Promise<boolean>;
  listAuditLogs(limit?: number): AuditLogRecord[];
  addAuditLog(record: AuditLogRecord): Promise<void>;
  getAiSettings(): DatabaseDocument["aiSettings"];
  saveAiSettings(settings: NonNullable<DatabaseDocument["aiSettings"]>): Promise<AiProviderSettings>;
  getBrandingSettings(): SystemBrandingSettings | undefined;
  saveBrandingSettings(settings: SystemBrandingSettings): Promise<SystemBrandingSettings>;
}
