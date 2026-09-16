import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import { loadConfig } from "./config.js";
import { ConversionQueue } from "./conversion.js";
import { registerRoutes } from "./routes.js";
import { registerApplicationRoutes } from "./applicationRoutes.js";
import { registerConfiguredDashboardNative } from "./dashboardNativeStartup.js";
import { registerPublishedApplicationRoutes } from "./publishedApplicationRoutes.js";
import { createObjectStore, migrateLocalObjects } from "./objects.js";
import { createMetadataStore } from "./store.js";
import { ensureDemoMetrics } from "./dataIntegration.js";
import { registerDataEventRoutes } from "./dataEvents.js";
import { registerDataEndpointRuntime } from "./dataEndpointRuntime.js";
import { loadOrCreateServerInstanceId, registerServerMetaRoute } from "./serverMeta.js";
import { registerSystemRoutes } from "./system.js";
import { registerVisionRoutes, VisionEngine } from "./vision.js";
import { createApiServer } from "./serverOptions.js";
import { registerConversionTaskRoutes } from "./conversionTaskRoutes.js";
import { ConversionTaskService } from "./conversionTasks.js";
import { HttpCloudRenderWorkerClient } from "@bim-studio/server-sdk";
import { CloudRenderControlPlane, JsonCloudRenderRegistry } from "./cloudRenderControl.js";
import { registerCloudRenderRoutes } from "./cloudRenderRoutes.js";
import { registerCloudRenderViewerRoutes } from "./cloudRenderViewerRoutes.js";
import {
  DirectHttpConnectorGateway,
  DirectWebSocketMultiplexer
} from "./connectorGateway.js";
import { registerDirectBindingRoutes } from "./directBindingRoutes.js";
import { StaticDirectCredentialResolver } from "./directCredentialResolver.js";
import { registerIndustrialDemoRoutes } from "./industrialDemo.js";
import { OperationsService } from "./operations.js";
import { registerOperationsRoutes } from "./operationsRoutes.js";
import { registerUnityResourceRoutes } from "./unityResourceRoutes.js";
import { createIndustrialCapabilityHost, registerIndustrialCapabilityRoutes } from "./industrialCapabilities.js";
import { registerMcpCapabilityRoute } from "./mcpCapabilityAdapter.js";
import { createAssistantService } from "./ai/assistantService.js";
import { createMetadataAiAuditSink } from "./ai/metadataAiAuditSink.js";
import { resolveAiSettings } from "./ai/aiRuntimeSettings.js";
import { createIndustrialAgentRuntime } from "./ai/industrialAgentRuntime.js";
import { registerIndustrialAgentRoutes } from "./ai/industrialAgentRoutes.js";
import { registerAiSampleRoutes } from "./ai/aiSampleRoutes.js";
import { registerModeling3dRoutes } from "./ai/modeling3dRoutes.js";
import { createDataQuerySource } from "./dataQuerySource.js";
import { createExternalConverterRegistrations } from "./externalConverterCatalog.js";
import { registerProductionWeb } from "./productionWeb.js";
import { validateProductionConfig } from "./productionConfig.js";
import { MaintenanceInferenceScheduler } from "./maintenanceInferenceScheduler.js";
import { registerAiDataBindingRoutes } from "./aiDataBindingRoutes.js";
import { BatteryInferenceScheduler } from "./batteryInferenceScheduler.js";
import { PprBopService } from "./pprBopService.js";
import { registerPprBopRoutes } from "./pprBopRoutes.js";
import { createServerNotificationRuntime } from "./notificationRuntime.js";
import { registerNotificationRoutes } from "./notificationRoutes.js";
import { registerScriptDependencyRoutes } from "./scriptDependencyRoutes.js";
import { ScriptDependencyService } from "./scriptDependencyService.js";
import { registerScriptGitRoutes } from "./scriptGitRoutes.js";
import { ScriptGitService } from "./scriptGitService.js";

export async function buildApp() {
  const config = loadConfig();
  validateProductionConfig(config);
  const app = createApiServer({ logger: true, bodyLimit: 32 * 1024 * 1024 });
  const store = createMetadataStore(config);
  await store.init();
  const operations = new OperationsService(config.dataDir);
  await operations.init();
  const pprBop = new PprBopService(config.dataDir);
  await pprBop.init();
  const notifications = await createServerNotificationRuntime(config.dataDir);
  await ensureDemoMetrics(config);
  const objects = createObjectStore(config);
  await objects.init();
  const migratedObjects = await migrateLocalObjects(objects, config.dataDir);
  if (migratedObjects > 0) app.log.info({ migratedObjects }, "local model files migrated to object storage");
  const conversionTasks = new ConversionTaskService(createExternalConverterRegistrations(config, objects));
  const dataQuerySource = createDataQuerySource(store, config);
  const aiAudit = createMetadataAiAuditSink(store);
  const maintenanceScheduler = new MaintenanceInferenceScheduler({
    store,
    operations,
    dataQuerySource,
    onError: (error, deploymentId) => app.log.warn({ err: error, deploymentId }, "maintenance inference failed"),
  });
  const industrialCapabilities = await createIndustrialCapabilityHost(operations, {
    aiSettings: () => resolveAiSettings(store),
    dataQuerySource,
    conversionTasks,
  });
  const industrialAgent = await createIndustrialAgentRuntime({
    dataDir: config.dataDir,
    registry: industrialCapabilities.registry,
    settings: () => resolveAiSettings(store),
    dataSource: dataQuerySource,
    projectContext: (projectId) => {
      const operationsSnapshot = operations.snapshotForApi(projectId);
      return {
        operations: {
          models: operationsSnapshot.models.slice(0, 20),
          deployments: operationsSnapshot.deployments.slice(0, 20),
          assessments: operationsSnapshot.assessments.slice(0, 20),
          cases: operationsSnapshot.cases.slice(0, 20),
          logisticsExperiments: operationsSnapshot.logisticsExperiments.slice(0, 20),
          plantLiteStudies: operationsSnapshot.plantLiteStudies.slice(0, 20),
          energyInsights: operationsSnapshot.energyInsights.slice(0, 20),
          validationStudies: operationsSnapshot.validationStudies.slice(0, 20),
          whatIfStudies: operationsSnapshot.whatIfStudies.slice(0, 20),
          studies: operationsSnapshot.studies.slice(0, 30),
        },
        battery: {
          release: industrialCapabilities.batteryRelease,
          deployment: {
            enabled: industrialCapabilities.batteryOnnx.enabled,
            mode: industrialCapabilities.batteryOnnx.mode,
          activeModels: industrialCapabilities.batteryOnnxRuntimeModels.map((model) => ({
              id: `battery.${model}`,
              model,
              runtime: "onnx",
            })),
          },
          availableCapabilities: industrialCapabilities.registry.listCapabilities()
            .filter((capability) => capability.id.startsWith("battery."))
            .map((capability) => ({ id: capability.id, label: capability.label, kind: capability.kind })),
        },
        aiDataBindings: store.listAiDataBindings(projectId).slice(0, 20),
        aiDataBindingRuns: store.listAiDataBindingRuns(projectId, { limit: 20 }),
      };
    },
    audit: aiAudit,
  });
  const batteryScheduler = new BatteryInferenceScheduler({
    store,
    host: industrialCapabilities,
    dataQuerySource,
    onError: (error, bindingId) => app.log.warn({ err: error, bindingId }, "battery inference failed"),
  });
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
  await registerSystemRoutes(app, store, config.dataDir, {
    assistant: createAssistantService(industrialCapabilities.registry, {
      audit: aiAudit,
    }),
  });
  await registerDataEventRoutes(app, store);
  await registerNotificationRoutes(app, notifications);
  await registerRoutes(app, {
    store,
    queue,
    objects,
    dataDir: config.dataDir,
    config,
    beforeDiscardPublication: (publication) => cloudRender.setEnabled(publication, false).then(() => undefined),
    afterPublish: async (publication) => {
      await notifications.service.dispatch({
        id: `scene-published:${publication.sceneId}:${publication.publishedAt}`,
        type: "scene.published",
        severity: "info",
        title: `场景已发布：${publication.name}`,
        body: `项目 ${publication.projectId} 的场景 ${publication.sceneId} 已生成可浏览版本。`,
        occurredAt: publication.publishedAt,
        target: { projectId: publication.projectId, sceneId: publication.sceneId },
      });
    },
  });
  await registerUnityResourceRoutes(app, { store, objects, dataDir: config.dataDir });
  await registerConversionTaskRoutes(app, { service: conversionTasks, projectExists: (projectId) => Boolean(store.getProject(projectId)) });
  await registerDataEndpointRuntime(app, store, config);
  await registerApplicationRoutes(app, store);
  await registerConfiguredDashboardNative(app, { store, objects, config });
  const scriptDependencies = new ScriptDependencyService({ dataDir: config.dataDir, objects });
  await registerPublishedApplicationRoutes(app, { store, dependencies: scriptDependencies });
  await registerScriptDependencyRoutes(app, {
    store,
    service: scriptDependencies,
  });
  await registerScriptGitRoutes(app, {
    store,
    service: new ScriptGitService({ dataDir: config.dataDir }),
  });
  await registerCloudRenderRoutes(app, { store, control: cloudRender });
  registerCloudRenderViewerRoutes(app, { workerUrl: config.cloudRender.workerUrl });
  await registerIndustrialDemoRoutes(app);
  await registerOperationsRoutes(app, { store, service: operations, dataQuerySource });
  await registerPprBopRoutes(app, { store, service: pprBop });
  await registerAiDataBindingRoutes(app, store);
  await registerIndustrialCapabilityRoutes(app, { store, host: industrialCapabilities, dataQuerySource });
  await registerIndustrialAgentRoutes(app, { store, runtime: industrialAgent });
  await registerAiSampleRoutes(app, { store });
  await registerModeling3dRoutes(app, { store });
  await registerMcpCapabilityRoute(app, { store, host: industrialCapabilities });
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
  await registerProductionWeb(app);
  vision.start();
  maintenanceScheduler.start();
  batteryScheduler.start();
  app.addHook("onClose", async () => {
    batteryScheduler.stop();
    maintenanceScheduler.stop();
    vision.stop();
  });
  return { app, config };
}

if (process.env.NODE_ENV !== "test") {
  const { app, config } = await buildApp();
  await app.listen({ port: config.port, host: config.host });
}
