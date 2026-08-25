import { createDocsCatalog, groupDocsByCategory, validateDocsLinks } from "@bim-studio/docs-runtime";
import agvRuntimeSimulation from "./agv-runtime-simulation.md?raw";
import behaviorScript from "./behavior-script.md?raw";
import dashboardScene from "./dashboard-scene.md?raw";
import serverPublish from "./server-publish.md?raw";

export const DOCS_VERSION = "0.9.0";

export const docsDocuments = createDocsCatalog([
  { id: "dashboard-scene", category: "快速开始", order: 10, version: DOCS_VERSION, markdown: dashboardScene },
  { id: "behavior-script", category: "场景编程", order: 20, version: DOCS_VERSION, markdown: behaviorScript },
  { id: "server-publish", category: "客户端与发布", order: 30, version: DOCS_VERSION, markdown: serverPublish },
  { id: "agv-runtime-simulation", category: "行业扩展", order: 40, version: DOCS_VERSION, markdown: agvRuntimeSimulation }
]);

export const docsCategories = groupDocsByCategory(docsDocuments);
export const docsLinkIssues = validateDocsLinks(docsDocuments);
