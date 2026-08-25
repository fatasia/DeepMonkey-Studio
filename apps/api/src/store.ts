import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertApplicationDocument, assertPathSafeResourceId } from "@bim-studio/contracts";
import type { AiProviderSettings, ApplicationDocument, ApplicationPublicationPointer, AuditLogRecord, DataConnectionRecord, DataDatasetRecord, DatabaseDocument, ModelRecord, ProjectAssetRecord, ProjectRecord, PublishedApplicationRecord, PublishedSceneRecord, SceneSnapshot, StoredSystemUserRecord, SystemBrandingSettings, VisionEventRecord, VisionModelRecord, VisionSourceRecord, VisionTaskRecord } from "@bim-studio/contracts";
import type { AppConfig } from "./config.js";

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

export type DeleteApplicationDraftResult = {
  status: "deleted" | "project-not-found" | "application-not-found" | "active-publication";
};

export type PublishApplicationResult =
  | { status: "published"; publication: PublishedApplicationRecord }
  | { status: "project-not-found" }
  | { status: "application-not-found" };

export type UnpublishApplicationResult = {
  status: "unpublished" | "project-not-found" | "application-not-found" | "not-published";
};

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
  listDataConnections(projectId: string): DataConnectionRecord[];
  saveDataConnection(projectId: string, connection: DataConnectionRecord): Promise<DataConnectionRecord>;
  removeDataConnection(projectId: string, connectionId: string): Promise<boolean>;
  listDatasets(projectId: string): DataDatasetRecord[];
  saveDataset(projectId: string, dataset: DataDatasetRecord): Promise<DataDatasetRecord>;
  removeDataset(projectId: string, datasetId: string): Promise<boolean>;
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
  savePublication(publication: PublishedSceneRecord): Promise<PublishedSceneRecord>;
  removePublication(sceneId: string): Promise<boolean>;
  listApplications(projectId: string): ApplicationDocument[];
  getApplication(projectId: string, applicationId: string): ApplicationDocument | undefined;
  getApplicationById(applicationId: string): ApplicationDocument | undefined;
  getApplicationIdReservation(applicationId: string): ApplicationIdReservation | undefined;
  createApplicationDraft(projectId: string, application: ApplicationDocument, now: string): Promise<CreateApplicationDraftResult>;
  updateApplicationDraft(projectId: string, applicationId: string, application: ApplicationDocument, now: string): Promise<UpdateApplicationDraftResult>;
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

export class JsonStore implements MetadataStore {
  protected readonly databasePath: string;
  protected document: DatabaseDocument = {
    projects: [],
    scenes: [],
    applications: [],
    publishedApplications: [],
    applicationPublicationPointers: []
  };
  private writeChain = Promise.resolve();
  private applicationLifecycleChain = Promise.resolve();

  constructor(private readonly dataDir: string) {
    this.databasePath = path.join(dataDir, "database.json");
  }

  async init(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    try {
      this.document = JSON.parse(await readFile(this.databasePath, "utf8")) as DatabaseDocument;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.document = defaultDocument();
      await this.persist();
    }
    this.document.publishedScenes ??= [];
    this.document.applications ??= [];
    this.document.publishedApplications ??= [];
    this.document.applicationPublicationPointers ??= [];
    this.document.users ??= [];
    this.document.auditLogs ??= [];
    if (this.ensureExampleDataCatalog() || this.sanitizeLegacyBranding()) await this.persist();
  }

  listProjects(): ProjectRecord[] {
    return structuredClone(this.document.projects);
  }

  getProject(projectId: string): ProjectRecord | undefined {
    const project = this.document.projects.find((item) => item.id === projectId);
    return project ? structuredClone(project) : undefined;
  }

  async createProject(name: string, description = ""): Promise<ProjectRecord> {
    const now = new Date().toISOString();
    const project: ProjectRecord = {
      id: randomUUID(),
      name,
      description,
      models: [],
      assets: [],
      createdAt: now,
      updatedAt: now
    };
    this.document.projects.push(project);
    await this.persist();
    return structuredClone(project);
  }

  async updateProject(projectId: string, updates: Pick<Partial<ProjectRecord>, "name" | "description">): Promise<ProjectRecord> {
    const project = this.requireProject(projectId);
    if (updates.name !== undefined) project.name = updates.name;
    if (updates.description !== undefined) project.description = updates.description;
    project.updatedAt = new Date().toISOString();
    await this.persist();
    return structuredClone(project);
  }

  async removeProject(projectId: string): Promise<boolean> {
    assertPathSafeResourceId(projectId, "projectId");
    return this.runApplicationLifecycleMutation<boolean>((candidate) => {
      const originalLength = candidate.projects.length;
      candidate.projects = candidate.projects.filter((item) => item.id !== projectId);
      if (candidate.projects.length === originalLength) return unchanged(false);
      candidate.scenes = candidate.scenes.filter((scene) => scene.projectId !== projectId);
      candidate.publishedScenes = (candidate.publishedScenes ?? []).filter((scene) => scene.projectId !== projectId);
      candidate.applications = (candidate.applications ?? []).filter((application) => application.metadata.projectId !== projectId);
      candidate.applicationPublicationPointers = (candidate.applicationPublicationPointers ?? [])
        .filter((pointer) => pointer.projectId !== projectId);
      return changed(true);
    });
  }

  async addModel(projectId: string, model: ModelRecord): Promise<void> {
    const project = this.requireProject(projectId);
    project.models.push(model);
    project.updatedAt = new Date().toISOString();
    await this.persist();
  }

  async updateModel(projectId: string, modelId: string, updates: Partial<ModelRecord>): Promise<ModelRecord> {
    const project = this.requireProject(projectId);
    const model = project.models.find((item) => item.id === modelId);
    if (!model) throw new Error(`Model not found: ${modelId}`);
    Object.assign(model, updates, { updatedAt: new Date().toISOString() });
    project.updatedAt = model.updatedAt;
    await this.persist();
    return structuredClone(model);
  }

  async removeModel(projectId: string, modelId: string): Promise<boolean> {
    const project = this.requireProject(projectId);
    const originalLength = project.models.length;
    project.models = project.models.filter((item) => item.id !== modelId);
    if (project.models.length === originalLength) return false;
    project.updatedAt = new Date().toISOString();
    await this.persist();
    return true;
  }

  listAssets(projectId: string): ProjectAssetRecord[] {
    return structuredClone(this.requireProject(projectId).assets ?? []);
  }

  async saveAsset(projectId: string, asset: ProjectAssetRecord): Promise<ProjectAssetRecord> {
    const project = this.requireProject(projectId);
    project.assets ??= [];
    const index = project.assets.findIndex((item) => item.id === asset.id);
    if (index >= 0) project.assets[index] = structuredClone(asset);
    else project.assets.push(structuredClone(asset));
    project.updatedAt = new Date().toISOString();
    await this.persist();
    return structuredClone(asset);
  }

  async removeAsset(projectId: string, assetId: string): Promise<boolean> {
    const project = this.requireProject(projectId);
    const originalLength = project.assets?.length ?? 0;
    project.assets = (project.assets ?? []).filter((item) => item.id !== assetId);
    if (project.assets.length === originalLength) return false;
    project.updatedAt = new Date().toISOString();
    await this.persist();
    return true;
  }

  listDataConnections(projectId: string): DataConnectionRecord[] {
    return structuredClone(this.requireProject(projectId).dataConnections ?? []);
  }

  async saveDataConnection(projectId: string, connection: DataConnectionRecord): Promise<DataConnectionRecord> {
    const project = this.requireProject(projectId);
    project.dataConnections ??= [];
    const index = project.dataConnections.findIndex((item) => item.id === connection.id);
    if (index >= 0) project.dataConnections[index] = structuredClone(connection);
    else project.dataConnections.push(structuredClone(connection));
    project.updatedAt = new Date().toISOString();
    await this.persist();
    return structuredClone(connection);
  }

  async removeDataConnection(projectId: string, connectionId: string): Promise<boolean> {
    const project = this.requireProject(projectId);
    const originalLength = project.dataConnections?.length ?? 0;
    project.dataConnections = (project.dataConnections ?? []).filter((item) => item.id !== connectionId);
    if (project.dataConnections.length === originalLength) return false;
    project.datasets = (project.datasets ?? []).filter((item) => item.connectionId !== connectionId);
    project.updatedAt = new Date().toISOString();
    await this.persist();
    return true;
  }

  listDatasets(projectId: string): DataDatasetRecord[] {
    return structuredClone(this.requireProject(projectId).datasets ?? []);
  }

  async saveDataset(projectId: string, dataset: DataDatasetRecord): Promise<DataDatasetRecord> {
    const project = this.requireProject(projectId);
    if (!(project.dataConnections ?? []).some((item) => item.id === dataset.connectionId)) throw new Error(`Data connection not found: ${dataset.connectionId}`);
    project.datasets ??= [];
    const index = project.datasets.findIndex((item) => item.id === dataset.id);
    if (index >= 0) project.datasets[index] = structuredClone(dataset);
    else project.datasets.push(structuredClone(dataset));
    project.updatedAt = new Date().toISOString();
    await this.persist();
    return structuredClone(dataset);
  }

  async removeDataset(projectId: string, datasetId: string): Promise<boolean> {
    const project = this.requireProject(projectId);
    const originalLength = project.datasets?.length ?? 0;
    project.datasets = (project.datasets ?? []).filter((item) => item.id !== datasetId);
    if (project.datasets.length === originalLength) return false;
    project.updatedAt = new Date().toISOString();
    await this.persist();
    return true;
  }

  listVisionSources(projectId: string): VisionSourceRecord[] {
    return structuredClone(this.requireProject(projectId).visionSources ?? []);
  }

  async saveVisionSource(projectId: string, source: VisionSourceRecord): Promise<VisionSourceRecord> {
    const project = this.requireProject(projectId);
    project.visionSources ??= [];
    upsert(project.visionSources, source);
    project.updatedAt = new Date().toISOString();
    await this.persist();
    return structuredClone(source);
  }

  async removeVisionSource(projectId: string, sourceId: string): Promise<boolean> {
    const project = this.requireProject(projectId);
    const original = project.visionSources?.length ?? 0;
    project.visionSources = (project.visionSources ?? []).filter((item) => item.id !== sourceId);
    if (project.visionSources.length === original) return false;
    for (const task of project.visionTasks ?? []) if (task.sourceId === sourceId) Object.assign(task, { enabled: false, status: "stopped", message: "视觉源已删除" });
    project.updatedAt = new Date().toISOString();
    await this.persist();
    return true;
  }

  listVisionModels(projectId: string): VisionModelRecord[] {
    return structuredClone(this.requireProject(projectId).visionModels ?? []);
  }

  getVisionModel(projectId: string, modelId: string): VisionModelRecord | undefined {
    const model = (this.requireProject(projectId).visionModels ?? []).find((item) => item.id === modelId);
    return model ? structuredClone(model) : undefined;
  }

  async saveVisionModel(projectId: string, model: VisionModelRecord): Promise<VisionModelRecord> {
    const project = this.requireProject(projectId);
    project.visionModels ??= [];
    upsert(project.visionModels, model);
    project.updatedAt = new Date().toISOString();
    await this.persist();
    return structuredClone(model);
  }

  async removeVisionModel(projectId: string, modelId: string): Promise<boolean> {
    const project = this.requireProject(projectId);
    const original = project.visionModels?.length ?? 0;
    project.visionModels = (project.visionModels ?? []).filter((item) => item.id !== modelId);
    if (project.visionModels.length === original) return false;
    for (const task of project.visionTasks ?? []) if (task.modelId === modelId) Object.assign(task, { enabled: false, status: "stopped", message: "AI 模型已删除" });
    project.updatedAt = new Date().toISOString();
    await this.persist();
    return true;
  }

  listVisionTasks(projectId: string): VisionTaskRecord[] {
    return structuredClone(this.requireProject(projectId).visionTasks ?? []);
  }

  getVisionTask(projectId: string, taskId: string): VisionTaskRecord | undefined {
    const task = (this.requireProject(projectId).visionTasks ?? []).find((item) => item.id === taskId);
    return task ? structuredClone(task) : undefined;
  }

  async saveVisionTask(projectId: string, task: VisionTaskRecord): Promise<VisionTaskRecord> {
    const project = this.requireProject(projectId);
    project.visionTasks ??= [];
    upsert(project.visionTasks, task);
    project.updatedAt = new Date().toISOString();
    await this.persist();
    return structuredClone(task);
  }

  async removeVisionTask(projectId: string, taskId: string): Promise<boolean> {
    const project = this.requireProject(projectId);
    const original = project.visionTasks?.length ?? 0;
    project.visionTasks = (project.visionTasks ?? []).filter((item) => item.id !== taskId);
    if (project.visionTasks.length === original) return false;
    project.updatedAt = new Date().toISOString();
    await this.persist();
    return true;
  }

  listVisionEvents(projectId: string, limit = 200): VisionEventRecord[] {
    return structuredClone((this.requireProject(projectId).visionEvents ?? []).slice(-Math.max(1, limit)).reverse());
  }

  getVisionEvent(projectId: string, eventId: string): VisionEventRecord | undefined {
    const event = (this.requireProject(projectId).visionEvents ?? []).find((item) => item.id === eventId);
    return event ? structuredClone(event) : undefined;
  }

  async saveVisionEvent(projectId: string, event: VisionEventRecord): Promise<VisionEventRecord> {
    const project = this.requireProject(projectId);
    project.visionEvents ??= [];
    upsert(project.visionEvents, event);
    if (project.visionEvents.length > 2_000) project.visionEvents.splice(0, project.visionEvents.length - 2_000);
    project.updatedAt = new Date().toISOString();
    await this.persist();
    return structuredClone(event);
  }

  listScenes(projectId: string): SceneSnapshot[] {
    return structuredClone(this.document.scenes
      .filter((scene) => scene.projectId === projectId)
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)));
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
    const index = this.document.scenes.findIndex((item) => item.projectId === scene.projectId && item.id === scene.id);
    if (index >= 0) this.document.scenes[index] = structuredClone(scene);
    else this.document.scenes.push(structuredClone(scene));
    await this.persist();
    return structuredClone(scene);
  }

  async removeScene(projectId: string, sceneId: string): Promise<boolean> {
    const originalLength = this.document.scenes.length;
    this.document.scenes = this.document.scenes.filter(
      (item) => item.projectId !== projectId || item.id !== sceneId
    );
    if (this.document.scenes.length === originalLength) return false;
    this.document.publishedScenes = (this.document.publishedScenes ?? []).filter((item) => item.sceneId !== sceneId);
    await this.persist();
    return true;
  }

  getPublication(sceneId: string): PublishedSceneRecord | undefined {
    const publication = (this.document.publishedScenes ?? []).find((item) => item.sceneId === sceneId);
    return publication ? structuredClone(publication) : undefined;
  }

  async savePublication(publication: PublishedSceneRecord): Promise<PublishedSceneRecord> {
    this.document.publishedScenes ??= [];
    const index = this.document.publishedScenes.findIndex((item) => item.sceneId === publication.sceneId);
    if (index >= 0) this.document.publishedScenes[index] = structuredClone(publication);
    else this.document.publishedScenes.push(structuredClone(publication));
    await this.persist();
    return structuredClone(publication);
  }

  async removePublication(sceneId: string): Promise<boolean> {
    const publications = this.document.publishedScenes ?? [];
    const originalLength = publications.length;
    this.document.publishedScenes = publications.filter((item) => item.sceneId !== sceneId);
    if (this.document.publishedScenes.length === originalLength) return false;
    const scene = this.document.scenes.find((item) => item.id === sceneId);
    if (scene) delete scene.publishedAt;
    await this.persist();
    return true;
  }

  listApplications(projectId: string): ApplicationDocument[] {
    return structuredClone((this.document.applications ?? [])
      .filter((item) => item.metadata.projectId === projectId)
      .sort((left, right) => Date.parse(right.metadata.updatedAt) - Date.parse(left.metadata.updatedAt)));
  }

  getApplication(projectId: string, applicationId: string): ApplicationDocument | undefined {
    const item = (this.document.applications ?? []).find((candidate) =>
      candidate.metadata.projectId === projectId && candidate.metadata.id === applicationId);
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
    return this.runApplicationLifecycleMutation<CreateApplicationDraftResult>((candidate) => {
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
          updatedAt: now
        }
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
    return this.runApplicationLifecycleMutation<UpdateApplicationDraftResult>((candidate) => {
      if (!candidate.projects.some((project) => project.id === projectId)) return unchanged({ status: "project-not-found" });
      const index = (candidate.applications ?? []).findIndex((item) =>
        item.metadata.projectId === projectId && item.metadata.id === applicationId);
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
          updatedAt: now
        }
      };
      candidate.applications![index] = saved;
      return changed({ status: "updated", application: structuredClone(saved) });
    });
  }

  async deleteApplicationDraft(projectId: string, applicationId: string): Promise<DeleteApplicationDraftResult> {
    assertPathSafeResourceId(projectId, "projectId");
    assertPathSafeResourceId(applicationId, "applicationId");
    return this.runApplicationLifecycleMutation<DeleteApplicationDraftResult>((candidate) => {
      if (!candidate.projects.some((project) => project.id === projectId)) return unchanged({ status: "project-not-found" });
      const index = (candidate.applications ?? []).findIndex((item) =>
        item.metadata.projectId === projectId && item.metadata.id === applicationId);
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
    return this.runApplicationLifecycleMutation<PublishApplicationResult>((candidate) => {
      if (!candidate.projects.some((project) => project.id === projectId)) return unchanged({ status: "project-not-found" });
      const application = (candidate.applications ?? []).find((item) =>
        item.metadata.projectId === projectId && item.metadata.id === applicationId);
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
        publishedAt
      };
      candidate.publishedApplications.push(publication);
      const pointer: ApplicationPublicationPointer = {
        applicationId,
        projectId,
        activePublicationId: publicationId,
        updatedAt: publishedAt
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
    return this.runApplicationLifecycleMutation<UnpublishApplicationResult>((candidate) => {
      if (!candidate.projects.some((project) => project.id === projectId)) return unchanged({ status: "project-not-found" });
      const application = (candidate.applications ?? []).find((item) =>
        item.metadata.projectId === projectId && item.metadata.id === applicationId);
      if (!application) return unchanged({ status: "application-not-found" });
      const pointerIndex = (candidate.applicationPublicationPointers ?? []).findIndex((pointer) =>
        pointer.applicationId === applicationId && pointer.projectId === projectId);
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

  listUsers(): StoredSystemUserRecord[] {
    return structuredClone(this.document.users ?? []);
  }

  getUser(userId: string): StoredSystemUserRecord | undefined {
    const user = (this.document.users ?? []).find((item) => item.id === userId);
    return user ? structuredClone(user) : undefined;
  }

  findUserByUsername(username: string): StoredSystemUserRecord | undefined {
    const normalized = username.trim().toLocaleLowerCase("en-US");
    const user = (this.document.users ?? []).find((item) => item.username.toLocaleLowerCase("en-US") === normalized);
    return user ? structuredClone(user) : undefined;
  }

  async saveUser(user: StoredSystemUserRecord): Promise<StoredSystemUserRecord> {
    this.document.users ??= [];
    const index = this.document.users.findIndex((item) => item.id === user.id);
    if (index >= 0) this.document.users[index] = structuredClone(user);
    else this.document.users.push(structuredClone(user));
    await this.persist();
    return structuredClone(user);
  }

  async removeUser(userId: string): Promise<boolean> {
    const original = this.document.users?.length ?? 0;
    this.document.users = (this.document.users ?? []).filter((item) => item.id !== userId);
    if (this.document.users.length === original) return false;
    await this.persist();
    return true;
  }

  listAuditLogs(limit = 200): AuditLogRecord[] {
    return structuredClone((this.document.auditLogs ?? []).slice(-Math.max(1, limit)).reverse());
  }

  async addAuditLog(record: AuditLogRecord): Promise<void> {
    this.document.auditLogs ??= [];
    this.document.auditLogs.push(structuredClone(record));
    if (this.document.auditLogs.length > 2_000) this.document.auditLogs.splice(0, this.document.auditLogs.length - 2_000);
    await this.persist();
  }

  getAiSettings(): DatabaseDocument["aiSettings"] {
    return this.document.aiSettings ? structuredClone(this.document.aiSettings) : undefined;
  }

  async saveAiSettings(settings: NonNullable<DatabaseDocument["aiSettings"]>): Promise<AiProviderSettings> {
    this.document.aiSettings = structuredClone(settings);
    await this.persist();
    const { apiKey: _apiKey, ...safe } = structuredClone(settings);
    return { ...safe, apiKeyConfigured: Boolean(settings.apiKey) };
  }

  getBrandingSettings(): SystemBrandingSettings | undefined {
    return this.document.branding ? structuredClone(this.document.branding) : undefined;
  }

  async saveBrandingSettings(settings: SystemBrandingSettings): Promise<SystemBrandingSettings> {
    this.document.branding = structuredClone(settings);
    await this.persist();
    return structuredClone(settings);
  }

  private requireProject(projectId: string): ProjectRecord {
    const project = this.document.projects.find((item) => item.id === projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    return project;
  }

  protected ensureExampleDataCatalog(): boolean {
    const project = this.document.projects.find((item) => item.id === "default") ?? this.document.projects[0];
    if (!project) return false;
    project.dataConnections ??= [];
    project.datasets ??= [];
    let changed = false;
    const now = new Date().toISOString();
    if (!project.dataConnections.some((item) => item.id === "example-postgresql")) {
      project.dataConnections.push({ id: "example-postgresql", projectId: project.id, name: "本机 PostgreSQL 示例", type: "postgresql", enabled: true, config: { host: "127.0.0.1", port: 5432, database: "bim_studio", user: "postgres", passwordEnv: "POSTGRES_PASSWORD" }, createdAt: now, updatedAt: now });
      changed = true;
    }
    if (!project.dataConnections.some((item) => item.id === "example-http")) {
      project.dataConnections.push({ id: "example-http", projectId: project.id, name: "HTTP 设备接口示例", type: "http", enabled: true, config: { method: "GET", url: "/api/demo/sensors" }, createdAt: now, updatedAt: now });
      changed = true;
    }
    if (!project.datasets.some((item) => item.id === "example-postgresql-metrics")) {
      project.datasets.push({ id: "example-postgresql-metrics", projectId: project.id, connectionId: "example-postgresql", name: "PostgreSQL · 设备运行趋势", query: "SELECT recorded_at, device_id, temperature, pressure, running FROM bim_studio_demo_metrics ORDER BY recorded_at DESC LIMIT 60", refreshSeconds: 5, fields: exampleMetricFields(), createdAt: now, updatedAt: now });
      changed = true;
    }
    if (!project.datasets.some((item) => item.id === "example-http-metrics")) {
      project.datasets.push({ id: "example-http-metrics", projectId: project.id, connectionId: "example-http", name: "HTTP · 实时设备状态", sourceKey: "items", refreshSeconds: 3, fields: exampleMetricFields(), createdAt: now, updatedAt: now });
      changed = true;
    }
    return changed;
  }

  protected sanitizeLegacyBranding(): boolean {
    let changed = false;
    const clean = (value: string) => {
      const legacyName = ["BIM", "FACE"].join("");
      const next = value.replace(new RegExp(legacyName, "gi"), "");
      if (next !== value) changed = true;
      return next;
    };
    for (const project of this.document.projects) {
      for (const model of project.models) { model.name = clean(model.name); model.sourceUrl = clean(model.sourceUrl); if (model.manifest) model.manifest.sourceName = clean(model.manifest.sourceName); }
      for (const asset of project.assets ?? []) { asset.name = clean(asset.name); asset.fileName = clean(asset.fileName); asset.url = clean(asset.url); }
    }
    for (const scene of this.document.scenes) for (const model of scene.models) if (model.sourceName) model.sourceName = clean(model.sourceName);
    for (const publication of this.document.publishedScenes ?? []) for (const model of publication.snapshot.models) if (model.sourceName) model.sourceName = clean(model.sourceName);
    return changed;
  }

  /**
   * Application and project lifecycle mutations are serialized within one store
   * instance. Deployments must currently use a single API writer; this is not a
   * cross-process compare-and-swap protocol.
   */
  private runApplicationLifecycleMutation<T>(mutation: (candidate: DatabaseDocument) => DocumentMutation<T>): Promise<T> {
    const execute = async () => {
      const candidate = structuredClone(this.document);
      const result = mutation(candidate);
      if (!result.changed) return result.value;
      await this.persistDocument(candidate);
      this.document = candidate;
      return result.value;
    };
    const operation = this.applicationLifecycleChain.then(execute, execute);
    this.applicationLifecycleChain = operation.then(() => undefined, () => undefined);
    return operation;
  }

  protected async persist(): Promise<void> {
    await this.persistDocument(structuredClone(this.document));
  }

  protected async persistDocument(document: DatabaseDocument): Promise<void> {
    const write = async () => {
      const temporaryPath = `${this.databasePath}.tmp`;
      await writeFile(temporaryPath, JSON.stringify(document, null, 2), "utf8");
      await rename(temporaryPath, this.databasePath);
    };
    this.writeChain = this.writeChain.then(write, write);
    await this.writeChain;
  }
}

export class PostgresStore extends JsonStore {
  private readonly postgres: AppConfig["metadata"]["postgres"];
  private postgresWriteChain: Promise<void> = Promise.resolve();

  constructor(dataDir: string, config: AppConfig["metadata"]["postgres"]) {
    super(dataDir);
    this.postgres = config;
  }

  override async init(): Promise<void> {
    await mkdir(path.dirname(this.databasePath), { recursive: true });
    await this.ensureDatabase();
    await this.sql(`CREATE TABLE IF NOT EXISTS bim_studio_state (
      id SMALLINT PRIMARY KEY CHECK (id = 1),
      document JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    const encoded = (await this.sql("SELECT encode(convert_to(document::text, 'UTF8'), 'base64') FROM bim_studio_state WHERE id = 1", true)).trim();
    if (encoded) {
      this.document = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as DatabaseDocument;
      this.document.publishedScenes ??= [];
      this.document.applications ??= [];
      this.document.publishedApplications ??= [];
      this.document.applicationPublicationPointers ??= [];
      this.document.users ??= [];
      this.document.auditLogs ??= [];
      if (this.ensureExampleDataCatalog() || this.sanitizeLegacyBranding()) await this.persist();
      return;
    }
    try {
      this.document = JSON.parse(await readFile(this.databasePath, "utf8")) as DatabaseDocument;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.document = defaultDocument();
    }
    this.document.publishedScenes ??= [];
    this.document.applications ??= [];
    this.document.publishedApplications ??= [];
    this.document.applicationPublicationPointers ??= [];
    this.document.users ??= [];
    this.document.auditLogs ??= [];
    this.ensureExampleDataCatalog();
    this.sanitizeLegacyBranding();
    await this.persist();
  }

  protected override async persistDocument(document: DatabaseDocument): Promise<void> {
    const encoded = Buffer.from(JSON.stringify(document), "utf8").toString("base64");
    const write = async () => {
      await this.sql(`INSERT INTO bim_studio_state (id, document, updated_at)
        VALUES (1, convert_from(decode('${encoded}', 'base64'), 'UTF8')::jsonb, NOW())
        ON CONFLICT (id) DO UPDATE SET document = EXCLUDED.document, updated_at = NOW()`);
    };
    this.postgresWriteChain = this.postgresWriteChain.then(write, write);
    await this.postgresWriteChain;
  }

  private async ensureDatabase(): Promise<void> {
    if (!/^[a-zA-Z0-9_]+$/.test(this.postgres.database)) throw new Error("PostgreSQL 数据库名称无效");
    const exists = (await this.sql(
      `SELECT 1 FROM pg_database WHERE datname = '${this.postgres.database}'`,
      true,
      "postgres"
    )).trim();
    if (exists !== "1") await this.sql(`CREATE DATABASE ${this.postgres.database} ENCODING 'UTF8'`, false, "postgres");
  }

  private sql(statement: string, tuplesOnly = false, database = this.postgres.database): Promise<string> {
    const args = [
      "-X", "-v", "ON_ERROR_STOP=1",
      "-h", this.postgres.host,
      "-p", String(this.postgres.port),
      "-U", this.postgres.user,
      "-d", database,
      ...(tuplesOnly ? ["-t", "-A"] : [])
    ];
    // Windows limits process command lines to roughly 32K characters. Scene state can
    // be much larger, so send SQL through stdin instead of passing it to `psql -c`.
    return runProcess(this.postgres.psqlPath, args, { PGPASSWORD: this.postgres.password }, statement);
  }
}

export function createMetadataStore(config: AppConfig): MetadataStore {
  return config.metadata.provider === "postgres"
    ? new PostgresStore(config.dataDir, config.metadata.postgres)
    : new JsonStore(config.dataDir);
}

function defaultDocument(): DatabaseDocument {
  const now = new Date().toISOString();
  return {
    projects: [{
      id: "default",
      name: "示例项目",
      description: "上传 IFC、GLTF、GLB、FBX、DXF，或配置 RVT 转换器",
      models: [],
      assets: [],
      createdAt: now,
      updatedAt: now
    }],
    scenes: [],
    publishedScenes: [],
    applications: [],
    publishedApplications: [],
    applicationPublicationPointers: []
  };
}

interface DocumentMutation<T> {
  changed: boolean;
  value: T;
}

function changed<T>(value: T): DocumentMutation<T> {
  return { changed: true, value };
}

function unchanged<T>(value: T): DocumentMutation<T> {
  return { changed: false, value };
}

function applicationIdReservation(document: DatabaseDocument, applicationId: string): ApplicationIdReservation | undefined {
  const application = (document.applications ?? []).find((candidate) => candidate.metadata.id === applicationId);
  if (application) {
    return {
      projectId: application.metadata.projectId,
      currentRevision: application.metadata.revision
    };
  }
  const publication = (document.publishedApplications ?? [])
    .filter((candidate) => candidate.applicationId === applicationId)
    .reduce<PublishedApplicationRecord | undefined>((latest, candidate) =>
      !latest || candidate.applicationRevision > latest.applicationRevision ? candidate : latest, undefined);
  return publication ? { projectId: publication.projectId, currentRevision: publication.applicationRevision } : undefined;
}

function exampleMetricFields() {
  return [
    { key: "recorded_at", label: "时间", type: "datetime" as const },
    { key: "device_id", label: "设备", type: "string" as const },
    { key: "temperature", label: "温度", type: "number" as const, unit: "℃" },
    { key: "pressure", label: "压力", type: "number" as const, unit: "kPa" },
    { key: "running", label: "运行状态", type: "boolean" as const }
  ];
}

function upsert<T extends { id: string }>(items: T[], value: T): void {
  const index = items.findIndex((item) => item.id === value.id);
  if (index >= 0) items[index] = structuredClone(value);
  else items.push(structuredClone(value));
}

export function runProcess(command: string, args: string[], extraEnvironment: NodeJS.ProcessEnv, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      shell: false,
      env: { ...process.env, ...extraEnvironment }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => stdout += chunk.toString());
    child.stderr.on("data", (chunk: Buffer) => stderr += chunk.toString());
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `进程退出码 ${String(code)}`)));
    child.stdin.end(input);
  });
}
