import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { ConversionTaskRecord, DatabaseDocument, ModelRecord } from "@bim-studio/contracts";
import type { AppConfig } from "./config.js";
import { JsonStore } from "./jsonStore.js";
import { runProcess } from "./processRunner.js";
import { defaultDocument } from "./storeUtils.js";
import { acceptedPostgresRevision, MetadataRevisionConflict, parsePostgresState, postgresStateWrite, READ_POSTGRES_STATE } from "./postgresStateRevision.js";
import { CONVERSION_LEASE_SCHEMA, leaseSql, leaseWriteFence, parseConversionLease, type ConversionTaskLease } from "./conversionTaskLease.js";
import { saveConversionTaskMutation } from "./conversionTaskStore.js";
import { requestCancellationSql } from "./conversionTaskLease.js";

export class PostgresStore extends JsonStore {
  private readonly postgres: AppConfig["metadata"]["postgres"];
  private postgresWriteChain: Promise<void> = Promise.resolve();
  private postgresRevision: string | undefined;

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
      revision BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await this.sql("ALTER TABLE bim_studio_state ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 0");
    await this.sql(CONVERSION_LEASE_SCHEMA);
    if (await this.refreshPostgresState()) {
      this.document.publishedScenes ??= [];
      this.document.applications ??= [];
      this.document.publishedApplications ??= [];
      this.document.applicationPublicationPointers ??= [];
      this.document.users ??= [];
      this.document.auditLogs ??= [];
      const normalizedAiDataBindings = this.normalizeAiDataBindings();
      const normalizedAiDataBindingRuns = this.normalizeAiDataBindingRuns();
      if (this.ensureExampleDataCatalog() || this.sanitizeLegacyBranding() || normalizedAiDataBindings || normalizedAiDataBindingRuns) await this.persist();
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
    this.normalizeAiDataBindings();
    this.normalizeAiDataBindingRuns();
    this.ensureExampleDataCatalog();
    this.sanitizeLegacyBranding();
    try { await this.persist(); }
    catch (error) {
      // 同时首次启动时，以已落库的初始文档为准，不能覆盖另一实例的初始化结果。
      if (!(error instanceof MetadataRevisionConflict) || this.postgresRevision === undefined) throw error;
    }
  }

  protected override async persistDocument(document: DatabaseDocument): Promise<void> {
    return this.persistPostgresDocument(document);
  }

  override async saveConversionTask(task: ConversionTaskRecord, updates?: Partial<ModelRecord>, lease?: ConversionTaskLease): Promise<void> {
    return this.runDocumentOperation(async () => {
      const candidate = structuredClone(this.document);
      if (!saveConversionTaskMutation(candidate, task, updates)) return;
      const fence = leaseWriteFence(task.id, lease, ["failed", "cancelled"].includes(task.status) && !updates, task.status === "succeeded");
      await this.persistPostgresDocument(candidate, fence);
      this.document = candidate;
    });
  }

  async refreshConversionTasks(): Promise<ConversionTaskRecord[]> {
    return this.runDocumentOperation(async () => {
      await this.refreshPostgresState();
      const requested = new Set<string>(JSON.parse(await this.sql("SELECT COALESCE(json_agg(task_id), '[]'::json)::text FROM bim_studio_conversion_leases WHERE cancel_requested", true)));
      return this.listConversionTasks().map(task => requested.has(task.id) && ["queued", "running"].includes(task.status)
        ? { ...task, status: "cancelling" as const, message: "取消请求已送达执行器，等待资源退出" } : task);
    });
  }

  async acquireConversionTaskLease(taskId: string, ownerId: string): Promise<ConversionTaskLease | undefined> {
    return this.runDocumentOperation(async () => parseConversionLease(await this.sql(leaseSql(taskId, ownerId, "acquire"), true)));
  }

  async renewConversionTaskLease(lease: ConversionTaskLease): Promise<ConversionTaskLease | undefined> {
    return this.runDocumentOperation(async () => parseConversionLease(await this.sql(leaseSql(lease.taskId, lease.ownerId, "renew", lease.epoch), true)));
  }

  async releaseConversionTaskLease(lease: ConversionTaskLease): Promise<void> {
    return this.runDocumentOperation(async () => { await this.sql(leaseSql(lease.taskId, lease.ownerId, "release", lease.epoch), true); });
  }

  async activeConversionTaskLease(taskId: string): Promise<boolean> {
    return (await this.sql(`SELECT NOT (${leaseWriteFence(taskId, undefined, true)})`, true)).trim() === "t";
  }

  async requestConversionCancellation(taskId: string): Promise<boolean> {
    return (await this.sql(requestCancellationSql(taskId), true)).trim() === "t";
  }

  private async persistPostgresDocument(document: DatabaseDocument, fence?: string): Promise<void> {
    // 版本必须绑定调用时的候选快照，不能等排队执行时换成较新的版本。
    const expectedRevision = this.postgresRevision;
    const statement = postgresStateWrite(document, expectedRevision, fence);
    const write = async () => {
      const revision = acceptedPostgresRevision(await this.sql(statement, true), expectedRevision);
      if (revision === undefined) {
        await this.refreshPostgresState();
        throw new MetadataRevisionConflict();
      }
      this.postgresRevision = revision;
    };
    this.postgresWriteChain = this.postgresWriteChain.then(write, write);
    await this.postgresWriteChain;
  }

  private async refreshPostgresState(): Promise<boolean> {
    const state = parsePostgresState(await this.sql(READ_POSTGRES_STATE, true));
    if (!state) return false;
    this.document = state.document;
    this.postgresRevision = state.revision;
    return true;
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
