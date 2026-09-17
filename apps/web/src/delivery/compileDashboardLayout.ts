import { assertDashboardDocument, type DashboardDocument, type WidgetFrame } from "@bim-studio/contracts";
import { layoutRetainedUi, validateRetainedUiTree, type RetainedUiNode, type RetainedUiStyle, type RetainedUiTree } from "@bim-studio/deep-engine";
import { runtimeContentSha256, dashboardRuntimePageId } from "@bim-studio/deep-engine/runtime-package";

const NODE_FIELDS = new Set(["id", "frame", "zIndex", "visible"]);
const PAGE_FIELDS = new Set(["id", "width", "height", "nodes"]);

/** 外框布局 pass；组件内容和发布适配由独立 pass 消费。 */
export function compileDashboardLayout(input: DashboardDocument, pageId = input.entryPageId) {
  const document = structuredClone(input);
  assertDashboardDocument(document);
  return compilePageLayout(document, pageId);
}

/** 多页发布共享一次文档快照与校验，避免每页复制整个应用。 */
export function compileDashboardLayouts(input: DashboardDocument) {
  const document = structuredClone(input);
  assertDashboardDocument(document);
  return { source: document, pages: document.application.pages.map(page => compilePageLayout(document, page.id)) };
}

function compilePageLayout(document: DashboardDocument, pageId: string) {
  const page = document.application.pages.find(page => page.id === pageId);
  if (!page) throw new Error(`二维布局页面不存在：${pageId}`);
  const appId = document.application.metadata.id, revision = document.application.metadata.revision;
  const identity = (kind: string, sourceId: string) => `${kind}.${runtimeContentSha256(JSON.stringify([appId, pageId, sourceId]))}`;
  const rootId = dashboardRuntimePageId(appId, page.id);
  const nodes: RetainedUiNode[] = page.nodes.map(node => ({
    id: identity("node", node.id), revision, parentId: rootId, children: [],
    style: style(node.frame, node.zIndex, node.visible !== false),
    content: { kind: "container" }, a11y: { role: "none" },
  }));
  const tree: RetainedUiTree = {
    schemaVersion: 1, id: rootId, revision, rootId, width: page.width, height: page.height,
    nodes: [{ id: rootId, revision, parentId: null, children: nodes.map(node => node.id),
      style: style({ x: 0, y: 0, width: page.width, height: page.height }, 0, true),
      content: { kind: "container" }, a11y: { role: "none" } }, ...nodes],
  };
  const validation = validateRetainedUiTree(tree);
  if (!validation.valid) throw new Error(`二维布局超出 Retained UI 契约：${validation.diagnostics[0]?.path} ${validation.diagnostics[0]?.message}`);
  return {
    scope: "dashboard-outer-layout" as const, source: document, pageId, tree,
    layout: layoutRetainedUi(tree),
    nodeBindings: page.nodes.map(node => ({ nodeId: node.id, layoutId: identity("node", node.id),
      compiledFields: [...NODE_FIELDS], deferredFields: Object.keys(node).filter(field => !NODE_FIELDS.has(field)) })),
    deferredPageFields: Object.keys(page).filter(field => !PAGE_FIELDS.has(field)),
  };
}

function style(frame: WidgetFrame, zIndex: number, visible: boolean): RetainedUiStyle {
  return { layout: "absolute", ...frame, padding: 0, gap: 0, grow: 0, align: "start", clip: false,
    visible, opacity: 1, pointerEvents: "none", zIndex, background: null, foreground: [1, 1, 1, 1],
    borderColor: null, borderWidth: 0, cornerRadius: 0, fontId: null, fontSize: 14 };
}
