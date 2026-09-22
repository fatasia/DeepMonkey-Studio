import { mkdir } from "node:fs/promises";
import path from "node:path";
import type {
  AiModelProviderSettings,
  AiProviderSettings,
  AuditLogRecord,
  DatabaseDocument,
  ConversionTaskRecord,
  ModelRecord,
  ProjectRecord,
  StoredSystemUserRecord,
  SystemBrandingSettings,
} from "@bim-studio/contracts";
import { JsonFilePersistence } from "./jsonFilePersistence.js";
import { emptyDatabaseDocument, ensureExampleDataCatalog, normalizeAiDataBindingRuns, normalizeAiDataBindings, sanitizeLegacyBranding } from "./storeNormalization.js";
import { changed, defaultDocument, unchanged, type DocumentMutation } from "./storeUtils.js";
import { saveConversionTaskMutation } from "./conversionTaskStore.js";

/** JSON 元数据存储的持久化、串行事务和系统级数据基础。 */
export abstract class JsonStoreFoundation {
  listConversionTasks(): ConversionTaskRecord[] {
    return structuredClone(this.document.conversionTasks ?? []);
  }

  async saveConversionTask(task: ConversionTaskRecord, modelUpdates?: Partial<ModelRecord>): Promise<void> {
    return this.runDocumentMutation(candidate => {
      return saveConversionTaskMutation(candidate, task, modelUpdates) ? changed(undefined) : unchanged(undefined);
    });
  }
  protected readonly databasePath: string;
  protected document: DatabaseDocument = emptyDatabaseDocument();
  private documentMutationChain = Promise.resolve();
  private readonly filePersistence: JsonFilePersistence;

  constructor(protected readonly dataDir: string) {
    this.databasePath = path.join(dataDir, "database.json");
    this.filePersistence = new JsonFilePersistence(this.databasePath);
  }

  async init(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    const stored = await this.filePersistence.load();
    this.document = stored ?? defaultDocument();
    if (!stored) await this.persist();
    this.document.publishedScenes ??= [];
    this.document.scenePublicationHistory ??= [];
    this.document.applications ??= [];
    this.document.publishedApplications ??= [];
    this.document.applicationPublicationPointers ??= [];
    this.document.users ??= [];
    this.document.auditLogs ??= [];
    this.document.dataEndpointSecrets ??= {};
    const normalizedAiDataBindings = this.normalizeAiDataBindings();
    const normalizedAiDataBindingRuns = this.normalizeAiDataBindingRuns();
    if (this.ensureExampleDataCatalog() || this.sanitizeLegacyBranding() || normalizedAiDataBindings || normalizedAiDataBindingRuns) await this.persist();
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
    const user = (this.document.users ?? []).find(
      (item) => item.username.toLocaleLowerCase("en-US") === normalized,
    );
    return user ? structuredClone(user) : undefined;
  }

  async saveUser(user: StoredSystemUserRecord): Promise<StoredSystemUserRecord> {
    return this.runDocumentMutation((candidate) => {
      candidate.users ??= [];
      const index = candidate.users.findIndex((item) => item.id === user.id);
      if (index >= 0) candidate.users[index] = structuredClone(user);
      else candidate.users.push(structuredClone(user));
      return changed(structuredClone(user));
    });
  }

  async removeUser(userId: string): Promise<boolean> {
    return this.runDocumentMutation((candidate) => {
      const original = candidate.users?.length ?? 0;
      candidate.users = (candidate.users ?? []).filter((item) => item.id !== userId);
      return candidate.users.length === original ? unchanged(false) : changed(true);
    });
  }

  listAuditLogs(limit = 200): AuditLogRecord[] {
    return structuredClone((this.document.auditLogs ?? []).slice(-Math.max(1, limit)).reverse());
  }

  async addAuditLog(record: AuditLogRecord): Promise<void> {
    return this.runDocumentMutation((candidate) => {
      candidate.auditLogs ??= [];
      candidate.auditLogs.push(structuredClone(record));
      if (candidate.auditLogs.length > 2_000) {
        candidate.auditLogs.splice(0, candidate.auditLogs.length - 2_000);
      }
      return changed(undefined);
    });
  }

  getAiSettings(): DatabaseDocument["aiSettings"] {
    return this.document.aiSettings ? structuredClone(this.document.aiSettings) : undefined;
  }

  async saveAiSettings(settings: NonNullable<DatabaseDocument["aiSettings"]>): Promise<AiProviderSettings> {
    const { apiKey: _apiKey, modeling3d, ...safe } = structuredClone(settings);
    const safeModeling3d = modeling3d
      ? {
          tripo3d: publicModeling3dSettings(modeling3d.tripo3d),
          tencentHunyuan: publicModeling3dSettings(modeling3d.tencentHunyuan),
        }
      : undefined;
    return this.runDocumentMutation((candidate) => {
      candidate.aiSettings = structuredClone(settings);
      return changed({
        ...safe,
        apiKeyConfigured: Boolean(settings.apiKey),
        ...(safeModeling3d ? { modeling3d: safeModeling3d } : {}),
      });
    });
  }

  getBrandingSettings(): SystemBrandingSettings | undefined {
    return this.document.branding ? structuredClone(this.document.branding) : undefined;
  }

  async saveBrandingSettings(settings: SystemBrandingSettings): Promise<SystemBrandingSettings> {
    return this.runDocumentMutation((candidate) => {
      candidate.branding = structuredClone(settings);
      return changed(structuredClone(settings));
    });
  }

  protected requireProject(projectId: string): ProjectRecord {
    const project = this.document.projects.find((item) => item.id === projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    return project;
  }

  protected ensureExampleDataCatalog(document = this.document): boolean {
    return ensureExampleDataCatalog(document);
  }

  protected normalizeAiDataBindings(document = this.document): boolean {
    return normalizeAiDataBindings(document);
  }

  protected normalizeAiDataBindingRuns(document = this.document): boolean {
    return normalizeAiDataBindingRuns(document);
  }

  protected sanitizeLegacyBranding(document = this.document): boolean {
    return sanitizeLegacyBranding(document);
  }

  /**
   * 同一实例内串行执行整文档事务。先持久化隔离副本再切换内存状态，写入失败时不会暴露半成品。
   * PostgreSQL 子类另做持久化版本比较；本队列本身不提供跨进程任务租约。
   */
  protected runDocumentMutation<T>(mutation: (candidate: DatabaseDocument) => DocumentMutation<T>): Promise<T> {
    const execute = async () => {
      const candidate = structuredClone(this.document);
      const result = mutation(candidate);
      if (!result.changed) return result.value;
      await this.persistDocument(candidate);
      this.document = candidate;
      return result.value;
    };
    return this.runDocumentOperation(execute);
  }

  protected runDocumentOperation<T>(execute: () => Promise<T>): Promise<T> {
    const operation = this.documentMutationChain.then(execute, execute);
    this.documentMutationChain = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  protected async persist(): Promise<void> {
    await this.persistDocument(structuredClone(this.document));
  }

  protected async persistDocument(document: DatabaseDocument): Promise<void> {
    await this.filePersistence.write(document);
  }
}

function publicModeling3dSettings(settings: AiModelProviderSettings): AiModelProviderSettings {
  const { apiKey: _apiKey, ...safe } = settings;
  return { ...safe, apiKeyConfigured: Boolean(settings.apiKey) };
}
