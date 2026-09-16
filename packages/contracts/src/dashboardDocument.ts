import { assertApplicationDocument, type ApplicationDocument } from "./application.js";
import { assertDashboardDocumentReferences } from "./dashboardDocumentReferences.js";

/** 发布编译源，保留完整作者快照；不作为 Native 可执行 payload。 */
export interface DashboardDocument {
  readonly schema: "deep-engine.dashboard-document";
  readonly schemaVersion: 1;
  readonly entryPageId: string;
  readonly application: ApplicationDocument;
}

export function createDashboardDocument(application: ApplicationDocument, entryPageId: string): DashboardDocument {
  const document: DashboardDocument = { schema: "deep-engine.dashboard-document", schemaVersion: 1,
    entryPageId, application: structuredClone(application) };
  assertDashboardDocument(document);
  return document;
}

export function assertDashboardDocument(value: unknown): asserts value is DashboardDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("DashboardDocument 必须是对象");
  const record = value as Record<string, unknown>;
  const fields = new Set(["schema", "schemaVersion", "entryPageId", "application"]);
  if (Object.keys(record).some(key => !fields.has(key))) throw new Error("DashboardDocument 包含未知字段");
  if (record.schema !== "deep-engine.dashboard-document" || record.schemaVersion !== 1) throw new Error("仅支持 DashboardDocument v1");
  if (typeof record.entryPageId !== "string" || !record.entryPageId) throw new Error("DashboardDocument 必须指定入口页");
  assertApplicationDocument(record.application);
  const pages = new Set<string>(), nodes = new Set<string>();
  for (const page of record.application.pages) {
    if (!page.id || pages.has(page.id)) throw new Error(`DashboardDocument 页面 ID 缺失或重复：${page.id}`);
    pages.add(page.id);
    for (const node of page.nodes) {
      if (!node.id || nodes.has(node.id)) throw new Error(`DashboardDocument 节点 ID 缺失或重复：${node.id}`);
      nodes.add(node.id);
    }
  }
  if (!pages.has(record.entryPageId)) throw new Error(`DashboardDocument 入口页不存在：${record.entryPageId}`);
  assertDashboardDocumentReferences(record.application, pages, nodes);
}
