import { createDocsCatalog, groupDocsByCategory, validateDocsLinks } from "@bim-studio/docs-runtime";
import agvRuntimeSimulation from "./agv-runtime-simulation.md?raw";
import behaviorScript from "./behavior-script.md?raw";
import dashboardScene from "./dashboard-scene.md?raw";
import dataPipeline from "./data-pipeline.md?raw";
import deploymentOperations from "./deployment-operations.md?raw";
import containerDeployment from "./container-deployment.md?raw";
import openSourceAssets from "./open-source-assets.md?raw";
import onDemandPackaging from "./on-demand-packaging.md?raw";
import deepEngine from "./deep-engine.md?raw";
import deepEngineSdk from "./deep-engine-sdk.md?raw";
import engineCapabilityMatrix from "./engine-capability-matrix.md?raw";
import engineDesignInfluences from "./engine-design-influences.md?raw";
import engineBenchmarks from "./engine-benchmarks.md?raw";
import aiModeling3dApi from "./ai-modeling3d-api.md?raw";
import aiWorkflows from "./ai-workflows.md?raw";
import apiReference from "./api-reference.md?raw";
import industrialPlanning from "./industrial-planning.md?raw";
import mediaWidgets from "./media-widgets.md?raw";
import resourceWorkflow from "./resource-workflow.md?raw";
import runtimeAndExtensions from "./runtime-and-extensions.md?raw";
import serverPublish from "./server-publish.md?raw";
import simulationCommissioning from "./simulation-commissioning.md?raw";
import studioApi from "./studio-api.md?raw";
import sdkExamples from "./sdk-examples.md?raw";
import sdkApiOverview from "./sdk-api-overview.md?raw";
import topologyResources from "./topology-resources.md?raw";
import troubleshooting from "./troubleshooting.md?raw";
import gettingStarted from "./getting-started.md?raw";
import coreConcepts from "./core-concepts.md?raw";
import sceneEffectsRendering from "./scene-effects-rendering.md?raw";
import modelImport from "./model-import.md?raw";
import contributing from "./contributing.md?raw";
import community from "./community.md?raw";
import faq from "./faq.md?raw";

export const DOCS_VERSION = "2026.10";

export const docsDocuments = createDocsCatalog([
  { id: "getting-started", category: "快速开始", order: 1, version: DOCS_VERSION, markdown: gettingStarted },
  { id: "core-concepts", category: "快速开始", order: 2, version: DOCS_VERSION, markdown: coreConcepts },
  { id: "dashboard-scene", category: "快速开始", order: 3, version: DOCS_VERSION, markdown: dashboardScene },
  { id: "runtime-and-extensions", category: "快速开始", order: 4, version: DOCS_VERSION, markdown: runtimeAndExtensions },
  { id: "resource-workflow", category: "资源与编辑", order: 10, version: DOCS_VERSION, markdown: resourceWorkflow },
  { id: "model-import", category: "资源与编辑", order: 11, version: DOCS_VERSION, markdown: modelImport },
  { id: "scene-effects-rendering", category: "资源与编辑", order: 12, version: DOCS_VERSION, markdown: sceneEffectsRendering },
  { id: "media-widgets", category: "资源与编辑", order: 13, version: DOCS_VERSION, markdown: mediaWidgets },
  { id: "topology-resources", category: "资源与编辑", order: 14, version: DOCS_VERSION, markdown: topologyResources },
  { id: "data-pipeline", category: "数据与 AI", order: 20, version: DOCS_VERSION, markdown: dataPipeline },
  { id: "ai-workflows", category: "数据与 AI", order: 21, version: DOCS_VERSION, markdown: aiWorkflows },
  { id: "ai-modeling3d-api", category: "数据与 AI", order: 22, version: DOCS_VERSION, markdown: aiModeling3dApi },
  { id: "behavior-script", category: "数据与 AI", order: 23, version: DOCS_VERSION, markdown: behaviorScript },
  { id: "studio-api", category: "数据与 AI", order: 24, version: DOCS_VERSION, markdown: studioApi },
  { id: "sdk-examples", category: "数据与 AI", order: 25, version: DOCS_VERSION, markdown: sdkExamples },
  { id: "api-reference", category: "数据与 AI", order: 26, version: DOCS_VERSION, markdown: apiReference },
  { id: "sdk-api-overview", category: "数据与 AI", order: 27, version: DOCS_VERSION, markdown: sdkApiOverview },
  { id: "industrial-planning", category: "工业任务", order: 30, version: DOCS_VERSION, markdown: industrialPlanning },
  { id: "agv-runtime-simulation", category: "工业任务", order: 31, version: DOCS_VERSION, markdown: agvRuntimeSimulation },
  { id: "simulation-commissioning", category: "工业任务", order: 32, version: DOCS_VERSION, markdown: simulationCommissioning },
  { id: "server-publish", category: "交付与运维", order: 40, version: DOCS_VERSION, markdown: serverPublish },
  { id: "deployment-operations", category: "交付与运维", order: 41, version: DOCS_VERSION, markdown: deploymentOperations },
  { id: "container-deployment", category: "交付与运维", order: 42, version: DOCS_VERSION, markdown: containerDeployment },
  { id: "troubleshooting", category: "交付与运维", order: 43, version: DOCS_VERSION, markdown: troubleshooting },
  { id: "faq", category: "交付与运维", order: 44, version: DOCS_VERSION, markdown: faq },
  { id: "deep-engine", category: "渲染引擎", order: 50, version: DOCS_VERSION, markdown: deepEngine },
  { id: "deep-engine-sdk", category: "渲染引擎", order: 51, version: DOCS_VERSION, markdown: deepEngineSdk },
  { id: "engine-design-influences", category: "渲染引擎", order: 52, version: DOCS_VERSION, markdown: engineDesignInfluences },
  { id: "engine-benchmarks", category: "渲染引擎", order: 53, version: DOCS_VERSION, markdown: engineBenchmarks },
  // 六引擎对标 P2:公开能力矩阵页(导语文档;数据表由 EngineCapabilityMatrix 组件在 DocsCenter 内渲染,单源=contracts 登记表)。
  { id: "engine-capability-matrix", category: "渲染引擎", order: 54, version: DOCS_VERSION, markdown: engineCapabilityMatrix },
  { id: "contributing", category: "参与项目", order: 60, version: DOCS_VERSION, markdown: contributing },
  { id: "community", category: "参与项目", order: 61, version: DOCS_VERSION, markdown: community },
  { id: "open-source-assets", category: "参与项目", order: 62, version: DOCS_VERSION, markdown: openSourceAssets },
  { id: "on-demand-packaging", category: "参与项目", order: 63, version: DOCS_VERSION, markdown: onDemandPackaging }
]);

export const docsCategories = groupDocsByCategory(docsDocuments);
export const docsLinkIssues = validateDocsLinks(docsDocuments);