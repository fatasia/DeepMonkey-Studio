import type { AppConfig } from "./config.js";
import { JsonStore } from "./jsonStore.js";
import type { MetadataStore } from "./metadataStore.js";
import { PostgresStore } from "./postgresStore.js";

export * from "./jsonStore.js";
export * from "./metadataStore.js";
export * from "./postgresStore.js";
export * from "./processRunner.js";

export function createMetadataStore(config: AppConfig): MetadataStore {
  return config.metadata.provider === "postgres"
    ? new PostgresStore(config.dataDir, config.metadata.postgres)
    : new JsonStore(config.dataDir);
}
