import type { DatabaseDocument } from "@bim-studio/contracts";
import { MAX_AI_DATA_BINDING_RUNS_PER_PROJECT, retainRecentAiDataBindingRuns } from "./aiDataBindingRunStore.js";
import { exampleMetricFields } from "./storeUtils.js";

export function emptyDatabaseDocument(): DatabaseDocument {
  return { projects: [], scenes: [], applications: [], publishedApplications: [], applicationPublicationPointers: [] };
}

/** 旧项目文档没有 AI 绑定集合；加载时补空数组，避免调用方维护版本分支。 */
export function normalizeAiDataBindings(document: DatabaseDocument): boolean {
  let hasChanges = false;
  for (const project of document.projects) {
    if (Array.isArray(project.aiDataBindings)) continue;
    project.aiDataBindings = [];
    hasChanges = true;
  }
  return hasChanges;
}

/** 旧文档缺少运行历史；超出当前保留策略的历史也在加载时收敛。 */
export function normalizeAiDataBindingRuns(document: DatabaseDocument): boolean {
  let hasChanges = false;
  for (const project of document.projects) {
    if (!Array.isArray(project.aiDataBindingRuns)) {
      project.aiDataBindingRuns = [];
      hasChanges = true;
      continue;
    }
    if (project.aiDataBindingRuns.length <= MAX_AI_DATA_BINDING_RUNS_PER_PROJECT) continue;
    project.aiDataBindingRuns = retainRecentAiDataBindingRuns(project.aiDataBindingRuns);
    hasChanges = true;
  }
  return hasChanges;
}

/** 为首次启动的数据中心补齐可运行示例，避免页面只有空壳。 */
export function ensureExampleDataCatalog(document: DatabaseDocument): boolean {
  const project = document.projects.find((item) => item.id === "default") ?? document.projects[0];
  if (!project) return false;
  project.dataConnections ??= [];
  project.datasets ??= [];
  let hasChanges = false;
  const now = new Date().toISOString();

  if (!project.dataConnections.some((item) => item.id === "example-postgresql")) {
    project.dataConnections.push({
      id: "example-postgresql",
      projectId: project.id,
      name: "本机 PostgreSQL 示例",
      type: "postgresql",
      enabled: true,
      config: { host: "127.0.0.1", port: 5432, database: "bim_studio", user: "postgres", passwordEnv: "POSTGRES_PASSWORD" },
      createdAt: now,
      updatedAt: now,
    });
    hasChanges = true;
  }
  if (!project.dataConnections.some((item) => item.id === "example-http")) {
    project.dataConnections.push({
      id: "example-http",
      projectId: project.id,
      name: "HTTP 设备接口示例",
      type: "http",
      enabled: true,
      config: { method: "GET", url: "/api/demo/sensors" },
      createdAt: now,
      updatedAt: now,
    });
    hasChanges = true;
  }
  if (!project.datasets.some((item) => item.id === "example-postgresql-metrics")) {
    project.datasets.push({
      id: "example-postgresql-metrics",
      projectId: project.id,
      connectionId: "example-postgresql",
      name: "PostgreSQL · 设备运行趋势",
      query: "SELECT recorded_at, device_id, temperature, pressure, running FROM bim_studio_demo_metrics ORDER BY recorded_at DESC LIMIT 60",
      refreshSeconds: 5,
      fields: exampleMetricFields(),
      createdAt: now,
      updatedAt: now,
    });
    hasChanges = true;
  }
  if (!project.datasets.some((item) => item.id === "example-http-metrics")) {
    project.datasets.push({
      id: "example-http-metrics",
      projectId: project.id,
      connectionId: "example-http",
      name: "HTTP · 实时设备状态",
      sourceKey: "items",
      refreshSeconds: 3,
      fields: exampleMetricFields(),
      createdAt: now,
      updatedAt: now,
    });
    hasChanges = true;
  }
  return hasChanges;
}

/** 清理旧品牌字符串，避免历史资源重新带回已废弃名称。 */
export function sanitizeLegacyBranding(document: DatabaseDocument): boolean {
  let hasChanges = false;
  const clean = (value: string) => {
    const legacyName = ["BIM", "FACE"].join("");
    const next = value.replace(new RegExp(legacyName, "gi"), "");
    if (next !== value) hasChanges = true;
    return next;
  };
  for (const project of document.projects) {
    for (const model of project.models) {
      model.name = clean(model.name);
      model.sourceUrl = clean(model.sourceUrl);
      if (model.manifest) model.manifest.sourceName = clean(model.manifest.sourceName);
    }
    for (const asset of project.assets ?? []) {
      asset.name = clean(asset.name);
      asset.fileName = clean(asset.fileName);
      asset.url = clean(asset.url);
    }
  }
  for (const scene of document.scenes) for (const model of scene.models) if (model.sourceName) model.sourceName = clean(model.sourceName);
  for (const publication of document.publishedScenes ?? []) for (const model of publication.snapshot.models) if (model.sourceName) model.sourceName = clean(model.sourceName);
  return hasChanges;
}
