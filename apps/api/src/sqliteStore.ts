import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DatabaseDocument } from "@bim-studio/contracts";
import { JsonStore } from "./jsonStore.js";
import { defaultDocument } from "./storeUtils.js";

/** 单机元数据存储：使用 Node 24 内置 SQLite，保持与 JsonStore 相同的整文档合同。 */
export class SqliteStore extends JsonStore {
  private readonly sqlitePath: string;

  constructor(dataDir: string, sqlitePath = path.join(dataDir, "database.sqlite")) {
    super(dataDir);
    this.sqlitePath = sqlitePath;
  }

  override async init(): Promise<void> {
    await mkdir(path.dirname(this.sqlitePath), { recursive: true });
    const database = new DatabaseSync(this.sqlitePath);
    try {
      database.exec("CREATE TABLE IF NOT EXISTS bim_studio_state (id INTEGER PRIMARY KEY CHECK (id = 1), document TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
      const row = database.prepare("SELECT document FROM bim_studio_state WHERE id = 1").get() as { document?: string } | undefined;
      this.document = row?.document ? JSON.parse(row.document) as DatabaseDocument : defaultDocument();
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
      const normalizedExampleDataCatalog = this.ensureExampleDataCatalog();
      const sanitizedLegacyBranding = this.sanitizeLegacyBranding();
      if (!row || normalizedExampleDataCatalog || sanitizedLegacyBranding || normalizedAiDataBindings || normalizedAiDataBindingRuns) {
        await this.persistDocument(this.document);
      }
    } finally {
      database.close();
    }
  }

  protected override async persistDocument(document: DatabaseDocument): Promise<void> {
    const database = new DatabaseSync(this.sqlitePath);
    try {
      database.exec("BEGIN IMMEDIATE");
      database.prepare("INSERT INTO bim_studio_state (id, document, revision) VALUES (1, ?, 0) ON CONFLICT(id) DO UPDATE SET document = excluded.document, revision = bim_studio_state.revision + 1, updated_at = CURRENT_TIMESTAMP").run(JSON.stringify(document));
      database.exec("COMMIT");
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* preserve original error */ }
      throw error;
    } finally {
      database.close();
    }
  }
}
