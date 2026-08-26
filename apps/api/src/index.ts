import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import { loadConfig } from "./config.js";
import { ConversionQueue } from "./conversion.js";
import { registerRoutes } from "./routes.js";
import { registerApplicationRoutes } from "./applicationRoutes.js";
import { createObjectStore, migrateLocalObjects } from "./objects.js";
import { createMetadataStore } from "./store.js";
import { ensureDemoMetrics } from "./dataIntegration.js";
import { registerDataEventRoutes } from "./dataEvents.js";
import { registerDataEndpointRuntime } from "./dataEndpointRuntime.js";
import { loadOrCreateServerInstanceId, registerServerMetaRoute } from "./serverMeta.js";
import { registerSystemRoutes } from "./system.js";
import { registerVisionRoutes, VisionEngine } from "./vision.js";
import { createApiServer } from "./serverOptions.js";
import { externalCadConverterRegistrations } from "./converterCatalog.js";
import { registerConversionTaskRoutes } from "./conversionTaskRoutes.js";
import { ConversionTaskService } from "./conversionTasks.js";
import { HttpCloudRenderWorkerClient } from "@bim-studio/server-sdk";
import { CloudRenderControlPlane, JsonCloudRenderRegistry } from "./cloudRenderControl.js";
import { registerCloudRenderRoutes } from "./cloudRenderRoutes.js";
import {
  DirectHttpConnectorGateway,
  DirectWebSocketMultiplexer,
  registerDirectBindingRoutes,
  StaticDirectCredentialResolver
} from "./connectorGateway.js";
import { registerIndustrialDemoRoutes } from "./industrialDemo.js";

export async function buildApp() {
  const config = loadConfig();
  const app = createApiServer({ logger: true, bodyLimit: 32 * 1024 * 1024 });
  const store = createMetadataStore(config);
  await store.init();
  await ensureDemoMetrics(config);
  const objects = createObjectStore(config);
  await objects.init();
  const migratedObjects = await migrateLocalObjects(objects, config.dataDir);
  if (migratedObjects > 0) app.log.info({ migratedObjects }, "local model files migrated to object storage");
  const queue = new ConversionQueue(store, config, objects);
  const cloudWorker = config.cloudRender.workerUrl && config.cloudRender.workerToken
    ? new HttpCloudRenderWorkerClient({
      baseUrl: config.cloudRender.workerUrl,
      token: config.cloudRender.workerToken,
      timeoutMs: config.cloudRender.requestTimeoutMs
    })
    : undefined;
  const cloudRender = new CloudRenderControlPlane(new JsonCloudRenderRegistry(config.dataDir), {
    ...(cloudWorker ? { worker: cloudWorker } : {}),
    ...(config.cloudRender.publicOrigin ? { publicOrigin: config.cloudRender.publicOrigin } : {}),
    healthMaxAgeMs: config.cloudRender.healthMaxAgeMs,
    mediaEvidenceMaxAgeMs: config.cloudRender.mediaEvidenceMaxAgeMs
  });
  await cloudRender.init();

  await app.register(websocket, { options: { maxPayload: 256 * 1024, perMessageDeflate: false } });
  await app.register(cors, { origin: config.webOrigin });
  await app.register(multipart, {
    limits: { fileSize: 2 * 1024 * 1024 * 1024, files: 1 }
  });
  const serverInstanceId = await loadOrCreateServerInstanceId(config.dataDir);
  await registerServerMetaRoute(app, serverInstanceId);
  await registerSystemRoutes(app, store, config.dataDir);
  await registerDataEventRoutes(app, store);
  await registerRoutes(app, {
    store,
    queue,
    objects,
    dataDir: config.dataDir,
    config,
    beforeDiscardPublication: (publication) => cloudRender.setEnabled(publication, false).then(() => undefined)
  });
  const conversionTasks = new ConversionTaskService(await externalCadConverterRegistrations());
  await registerConversionTaskRoutes(app, { service: conversionTasks, projectExists: (projectId) => Boolean(store.getProject(projectId)) });
  await registerDataEndpointRuntime(app, store, config);
  await registerApplicationRoutes(app, store);
  await registerCloudRenderRoutes(app, { store, control: cloudRender });
  await registerIndustrialDemoRoutes(app);
  const directCredentialResolver = new StaticDirectCredentialResolver(config.directBindings.credentials);
  const directBindingOptions = {
    credentialResolver: directCredentialResolver,
    internalOrigin: `http://127.0.0.1:${config.port}`,
    outboundPolicy: {
      allowPrivateNetwork: config.directBindings.allowPrivateNetwork,
      allowedPorts: config.directBindings.allowedPorts,
      allowedHostnames: config.directBindings.allowedHostnames
    },
    timeoutMs: config.directBindings.requestTimeoutMs,
    maxResponseBytes: config.directBindings.maxResponseBytes
  };
  await registerDirectBindingRoutes(app, {
    httpGateway: new DirectHttpConnectorGateway(directBindingOptions),
    webSockets: new DirectWebSocketMultiplexer(directBindingOptions)
  });
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
