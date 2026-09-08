import { assertApplicationDocument, type ApplicationDocument, type DashboardPageDocument, type InteractionFlow } from "@bim-studio/contracts";

export interface InsertDashboardPagesCommand {
  readonly id: string;
  readonly type: "dashboard.pages.insert";
  readonly label: string;
  readonly payload: { readonly pages: readonly DashboardPageDocument[]; readonly interactions: readonly InteractionFlow[]; readonly index?: number; readonly emptyApplicationEntryPageId?: string };
}

/** 整包先构造再提交；Store 只记录一次历史，校验失败不产生部分文档。 */
export function createInsertDashboardPagesCommand(
  pages: readonly DashboardPageDocument[], interactions: readonly InteractionFlow[] = [], index?: number, emptyApplicationEntryPageId?: string,
): InsertDashboardPagesCommand {
  return { id: `command:${crypto.randomUUID()}`, type: "dashboard.pages.insert", label: `导入 ${pages.length} 个二维页面`,
    payload: { pages: structuredClone(pages), interactions: structuredClone(interactions), ...(index === undefined ? {} : { index }), ...(emptyApplicationEntryPageId ? { emptyApplicationEntryPageId } : {}) } };
}

export function insertDashboardPages(document: ApplicationDocument, command: InsertDashboardPagesCommand): ApplicationDocument {
  const { pages: inserted, interactions, index = document.pages.length } = command.payload;
  if (!inserted.length) throw new Error("没有待导入的页面");
  if (!Number.isInteger(index) || index < 0 || index > document.pages.length) throw new Error("页面插入位置无效");
  const pageIds = new Set(document.pages.map(page => page.id));
  const nodeIds = new Set(document.pages.flatMap(page => page.nodes.map(node => node.id)));
  const flowIds = new Set(document.interactions.map(flow => flow.id));
  const unique = (ids: Set<string>, id: string) => {
    if (ids.has(id)) throw new Error(`导入内容包含重复 ID：${id}`);
    ids.add(id);
  };
  for (const page of inserted) {
    unique(pageIds, page.id);
    for (const node of page.nodes) unique(nodeIds, node.id);
  }
  for (const flow of interactions) {
    unique(flowIds, flow.id);
    if (flow.source.kind === "widget" && !nodeIds.has(flow.source.id) || flow.source.kind === "page" && !pageIds.has(flow.source.id)) {
      throw new Error(`联动来源不存在：${flow.id}`);
    }
    for (const action of flow.actions) if (action.type === "dashboard" && action.dashboardPageId && !pageIds.has(action.dashboardPageId)) {
      throw new Error(`联动目标页面不存在：${action.dashboardPageId}`);
    }
  }
  const pages = [...document.pages];
  pages.splice(index, 0, ...structuredClone(inserted));
  const entryId = command.payload.emptyApplicationEntryPageId;
  if (entryId && (document.pages.length !== 1 || document.pages[0]!.nodes.length !== 0 || !inserted.some(page => page.id === entryId))) {
    throw new Error("只能为单一空页面应用设置导入入口");
  }
  // 新建应用自带发布配置指向空首页；保留配置的其他字段及任何非空应用的入口。
  const publicationProfiles = entryId ? document.publicationProfiles.map(profile => profile.entryPageId === document.pages[0]!.id
    ? { ...profile, entryPageId: entryId } : profile) : document.publicationProfiles;
  const next = { ...document, pages, publicationProfiles, interactions: [...document.interactions, ...structuredClone(interactions)] };
  assertApplicationDocument(next);
  return next;
}
