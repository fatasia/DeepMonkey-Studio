import { createDocsCatalog, groupDocsByCategory, validateDocsLinks } from "@bim-studio/docs-runtime";
import agvRuntimeSimulation from "./agv-runtime-simulation.md?raw";
import behaviorScript from "./behavior-script.md?raw";
import dashboardScene from "./dashboard-scene.md?raw";
import dataPipeline from "./data-pipeline.md?raw";
import deploymentOperations from "./deployment-operations.md?raw";
import aiWorkflows from "./ai-workflows.md?raw";
import industrialPlanning from "./industrial-planning.md?raw";
import mediaWidgets from "./media-widgets.md?raw";
import resourceWorkflow from "./resource-workflow.md?raw";
import runtimeAndExtensions from "./runtime-and-extensions.md?raw";
import serverPublish from "./server-publish.md?raw";
import simulationCommissioning from "./simulation-commissioning.md?raw";
import studioApi from "./studio-api.md?raw";
import topologyResources from "./topology-resources.md?raw";
import troubleshooting from "./troubleshooting.md?raw";

export const DOCS_VERSION = "2026.09";

export const docsDocuments = createDocsCatalog([
  { id: "dashboard-scene", category: "快速开始", order: 10, version: DOCS_VERSION, markdown: dashboardScene },
  { id: "runtime-and-extensions", category: "快速开始", order: 11, version: DOCS_VERSION, markdown: runtimeAndExtensions },
  { id: "resource-workflow", category: "资源与编辑", order: 20, version: DOCS_VERSION, markdown: resourceWorkflow },
  { id: "media-widgets", category: "资源与编辑", order: 21, version: DOCS_VERSION, markdown: mediaWidgets },
  { id: "topology-resources", category: "资源与编辑", order: 22, version: DOCS_VERSION, markdown: topologyResources },
  { id: "data-pipeline", category: "数据与 AI", order: 30, version: DOCS_VERSION, markdown: dataPipeline },
  { id: "ai-workflows", category: "数据与 AI", order: 31, version: DOCS_VERSION, markdown: aiWorkflows },
  { id: "behavior-script", category: "数据与 AI", order: 32, version: DOCS_VERSION, markdown: behaviorScript },
  { id: "studio-api", category: "数据与 AI", order: 33, version: DOCS_VERSION, markdown: studioApi },
  { id: "industrial-planning", category: "工业任务", order: 40, version: DOCS_VERSION, markdown: industrialPlanning },
  { id: "agv-runtime-simulation", category: "工业任务", order: 41, version: DOCS_VERSION, markdown: agvRuntimeSimulation },
  { id: "simulation-commissioning", category: "工业任务", order: 42, version: DOCS_VERSION, markdown: simulationCommissioning },
  { id: "server-publish", category: "交付与运维", order: 50, version: DOCS_VERSION, markdown: serverPublish },
  { id: "deployment-operations", category: "交付与运维", order: 51, version: DOCS_VERSION, markdown: deploymentOperations },
  { id: "troubleshooting", category: "交付与运维", order: 52, version: DOCS_VERSION, markdown: troubleshooting }
]);

export const docsCategories = groupDocsByCategory(docsDocuments);
export const docsLinkIssues = validateDocsLinks(docsDocuments);
