import type { AppConfig } from "./config.js";
import { JsonStore } from "./jsonStore.js";
import type { MetadataStore } from "./metadataStore.js";
import { PostgresStore } from "./postgresStore.js";
import { SqliteStore } from "./sqliteStore.js";

export * from "./jsonStore.js";
export * from "./metadataStore.js";
export * from "./postgresStore.js";
export * from "./sqliteStore.js";
export * from "./processRunner.js";

export function createMetadataStore(config: AppConfig): MetadataStore {
  if (config.metadata.provider === "postgres") return new PostgresStore(config.dataDir, config.metadata.postgres);
  if (config.metadata.provider === "sqlite") return new SqliteStore(config.dataDir, config.metadata.sqlite.path);
  return new JsonStore(config.dataDir);
}
