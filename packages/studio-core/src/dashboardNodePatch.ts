import { assertApplicationDocument, type ApplicationDocument, type DashboardDataWidgetNode, type DashboardPageDocument } from "@bim-studio/contracts";

export type DashboardNodeChange =
  | { readonly op: "add" | "update"; readonly node: DashboardDataWidgetNode }
  | { readonly op: "delete"; readonly nodeId: string };

export interface PatchDashboardNodesCommand {
  readonly id: string;
  readonly type: "dashboard.nodes.patch";
  readonly label: string;
  readonly payload: { readonly projectId: string; readonly applicationId: string; readonly revision: number;
    readonly pageId: string; readonly baseline: string; readonly changes: readonly DashboardNodeChange[] };
}

/** 一次明确接受的增改删是一条可撤销命令，基线不一致时拒绝而非覆盖后续人工编辑。 */
export function createPatchDashboardNodesCommand(document: ApplicationDocument, page: DashboardPageDocument, changes: readonly DashboardNodeChange[]): PatchDashboardNodesCommand {
  return { id: `command:${crypto.randomUUID()}`, type: "dashboard.nodes.patch", label: "应用 AI 看板草案", payload: {
    projectId: document.metadata.projectId, applicationId: document.metadata.id, revision: document.metadata.revision,
    pageId: page.id, baseline: JSON.stringify(page), changes: structuredClone(changes),
  } };
}

export function patchDashboardNodes(document: ApplicationDocument, command: PatchDashboardNodesCommand): ApplicationDocument {
  if (!command.payload || typeof command.payload !== "object") throw new Error("草案命令缺少有效内容。");
  const { projectId, applicationId, revision, pageId, baseline, changes } = command.payload;
  const page = document.pages.find(item => item.id === pageId);
  if (!page || projectId !== document.metadata.projectId || applicationId !== document.metadata.id || revision !== document.metadata.revision || JSON.stringify(page) !== baseline) {
    throw new Error("页面已变化，请基于当前页面重新生成草案。");
  }
  if (!Array.isArray(changes) || !changes.length || changes.length > 64) throw new Error("草案需包含 1–64 项明确变更。");
  const seen = new Set<string>();
  const nodes = [...page.nodes];
  for (const change of changes) {
    if (!change || typeof change !== "object" || !["add", "update", "delete"].includes(change.op)) throw new Error("草案包含未知操作。");
    if (change.op !== "delete" && (!change.node || typeof change.node !== "object" || !change.node.widget || typeof change.node.widget !== "object")) throw new Error("草案组件配置无效。");
    const id = change.op === "delete" ? change.nodeId : change.node.id;
    if (typeof id !== "string" || !id.trim()) throw new Error("草案组件 ID 无效。");
    if (seen.has(id)) throw new Error(`草案重复修改组件：${id}`);
    seen.add(id);
    const index = nodes.findIndex(node => node.id === id);
    if (change.op === "add") {
      if (document.pages.some(item => item.nodes.some(node => node.id === id))) throw new Error(`组件 ID 已存在：${id}`);
    } else if (index < 0 || nodes[index]!.kind !== "data-widget" || nodes[index]!.locked) {
      throw new Error(`组件不存在、已锁定或不支持修改：${id}`);
    }
    if (change.op === "delete") {
      const target = nodes[index] as DashboardDataWidgetNode;
      if (hasDashboardReferences(document, target)) throw new Error(`组件仍被联动或脚本引用，请先解除引用：${id}`);
      nodes.splice(index, 1);
    } else {
      if (change.op === "update" && (nodes[index] as DashboardDataWidgetNode).widget.key !== change.node.widget.key) throw new Error("已有组件的数据键不能由草案更换，请在字段绑定中明确修改。");
      const { frame } = change.node;
      if (!frame || typeof frame !== "object" || change.node.kind !== "data-widget" || ![frame.x, frame.y, frame.width, frame.height].every(Number.isFinite)
        || frame.x < 0 || frame.y < 0 || frame.width < 40 || frame.height < 40 || frame.x + frame.width > page.width || frame.y + frame.height > page.height) throw new Error(`组件超出画布：${id}`);
      if (change.op === "add") nodes.push(structuredClone(change.node));
      else nodes[index] = structuredClone(change.node);
    }
  }
  const next = { ...document, pages: document.pages.map(item => item.id === pageId ? { ...item, nodes } : item) };
  assertApplicationDocument(next);
  return next;
}

function hasDashboardReferences(document: ApplicationDocument, node: DashboardDataWidgetNode): boolean {
  return document.interactions.some(flow => flow.source.kind === "widget" && flow.source.id === node.id
    || flow.legacyScript?.script.target.kind === "widget" && flow.legacyScript.script.target.widgetId === node.id
    || flow.actions.some(action => action.dataKey === node.widget.key))
    || document.scripts.some(script => script.target?.kind === "component" && script.target.id === node.id)
    || document.pages.some(page => page.nodes.some(other => other.id !== node.id && other.kind === "data-widget"
      && (other.widget.parentFilterKey === node.widget.key || other.widget.linkageParameterKey === node.widget.key)));
}
