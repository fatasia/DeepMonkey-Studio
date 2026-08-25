import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import Fastify from "fastify";
import { loadConfig } from "./config.js";
import { ConversionQueue } from "./conversion.js";
import { registerRoutes } from "./routes.js";
import { createObjectStore, migrateLocalObjects } from "./objects.js";
import { createMetadataStore } from "./store.js";
import { ensureDemoMetrics } from "./dataIntegration.js";
import { registerSystemRoutes } from "./system.js";
import { registerVisionRoutes, VisionEngine } from "./vision.js";

export async function buildApp() {
  const config = loadConfig();
  const app = Fastify({ logger: true, bodyLimit: 32 * 1024 * 1024 });
  const store = createMetadataStore(config);
  await store.init();
  await ensureDemoMetrics(config);
  const objects = createObjectStore(config);
  await objects.init();
  const migratedObjects = await migrateLocalObjects(objects, config.dataDir);
  if (migratedObjects > 0) app.log.info({ migratedObjects }, "local model files migrated to object storage");
  const queue = new ConversionQueue(store, config, objects);

  await app.register(cors, { origin: config.webOrigin });
  await app.register(multipart, {
    limits: { fileSize: 2 * 1024 * 1024 * 1024, files: 1 }
  });
  await registerSystemRoutes(app, store, config.dataDir);
  await registerRoutes(app, { store, queue, objects, dataDir: config.dataDir, config });
  const vision = new VisionEngine({ store, objects, dataDir: config.dataDir });
  await registerVisionRoutes(app, vision, { store, objects, dataDir: config.dataDir });
  vision.start();
  app.addHook("onClose", async () => vision.stop());
  return { app, config };
}

if (process.env.NODE_ENV !== "test") {
  const { app, config } = await buildApp();
  await app.listen({ port: config.port, host: config.host });
}
