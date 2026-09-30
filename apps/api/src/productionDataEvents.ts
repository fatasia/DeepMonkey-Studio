import type { FastifyInstance } from "fastify";
import type { MetadataStore } from "./store.js";
import { registerDataEventRoutes } from "./dataEvents.js";

/** Production composition: recordings share the configured local data directory. */
export function registerProductionDataEvents(app: FastifyInstance, store: MetadataStore, dataDir: string) {
  return registerDataEventRoutes(app, store, undefined, { recording: { dir: dataDir } });
}
