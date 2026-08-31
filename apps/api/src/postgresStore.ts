import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { DatabaseDocument } from "@bim-studio/contracts";
import type { AppConfig } from "./config.js";
import { JsonStore } from "./jsonStore.js";
import { runProcess } from "./processRunner.js";
import { defaultDocument } from "./storeUtils.js";

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
