import type { ApplicationIdReservation } from "./metadataStore.js";
import type { DatabaseDocument, ProjectRecord, PublishedApplicationRecord } from "@bim-studio/contracts";

export interface DocumentMutation<T> {
  changed: boolean;
  value: T;
}

/* 元数据文档的纯函数工具，集中处理默认值、版本冲突与数组更新。 */
export function defaultDocument(): DatabaseDocument {
  const now = new Date().toISOString();
  return {
    projects: [{
      id: "default",
      name: "示例项目",
      description: "上传 IFC、GLTF、GLB、FBX、DXF 与 OpenUSD；RVT、工业 CAD 可通过对应转换器接入",
      models: [],
      assets: [],
      createdAt: now,
      updatedAt: now
    }],
    scenes: [],
    publishedScenes: [],
    scenePublicationHistory: [],
    applications: [],
    publishedApplications: [],
    applicationPublicationPointers: []
  };
}

export function changed<T>(value: T): DocumentMutation<T> {
  return { changed: true, value };
}

export function unchanged<T>(value: T): DocumentMutation<T> {
  return { changed: false, value };
}

export function requireProject(document: DatabaseDocument, projectId: string): ProjectRecord {
  const project = document.projects.find((item) => item.id === projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);
  return project;
}

export function applicationIdReservation(document: DatabaseDocument, applicationId: string): ApplicationIdReservation | undefined {
  const application = (document.applications ?? []).find((candidate) => candidate.metadata.id === applicationId);
  if (application) {
    return {
      projectId: application.metadata.projectId,
      currentRevision: application.metadata.revision
    };
  }
  const publication = (document.publishedApplications ?? [])
    .filter((candidate) => candidate.applicationId === applicationId)
    .reduce<PublishedApplicationRecord | undefined>((latest, candidate) =>
      !latest || candidate.applicationRevision > latest.applicationRevision ? candidate : latest, undefined);
  return publication ? { projectId: publication.projectId, currentRevision: publication.applicationRevision } : undefined;
}

export function exampleMetricFields() {
  return [
    { key: "recorded_at", label: "时间", type: "datetime" as const },
    { key: "device_id", label: "设备", type: "string" as const },
    { key: "temperature", label: "温度", type: "number" as const, unit: "℃" },
    { key: "pressure", label: "压力", type: "number" as const, unit: "kPa" },
    { key: "running", label: "运行状态", type: "boolean" as const }
  ];
}

export function upsert<T extends { id: string }>(items: T[], value: T): void {
  const index = items.findIndex((item) => item.id === value.id);
  if (index >= 0) items[index] = structuredClone(value);
  else items.push(structuredClone(value));
}
