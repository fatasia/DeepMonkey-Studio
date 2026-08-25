import type { ApplicationDocument, DashboardDataWidgetConfig, InteractionFlow, WidgetFrame, WidgetNode } from "@bim-studio/contracts";

let nextCommandId = 1;

function commandId(): string {
  return `command:${nextCommandId++}`;
}

export interface RenameApplicationCommand {
  readonly id: string;
  readonly type: "application.rename";
  readonly label: string;
  readonly payload: {
    readonly name: string;
  };
}

export interface RenameDashboardPageCommand {
  readonly id: string;
  readonly type: "dashboard.page.rename";
  readonly label: string;
  readonly payload: {
    readonly pageId: string;
    readonly name: string;
  };
}

export interface UpdateDashboardNodeFrameCommand {
  readonly id: string;
  readonly type: "dashboard.node.frame.update";
  readonly label: string;
  readonly payload: {
    readonly pageId: string;
    readonly nodeId: string;
    readonly frame: WidgetFrame;
  };
}

export interface UpdateDashboardNodeFramesCommand {
  readonly id: string;
  readonly type: "dashboard.node.frames.update";
  readonly label: string;
  readonly payload: {
    readonly pageId: string;
    readonly frames: ReadonlyArray<{ readonly nodeId: string; readonly frame: WidgetFrame }>;
  };
}

export interface UpsertInteractionFlowCommand {
  readonly id: string;
  readonly type: "interaction.flow.upsert";
  readonly label: string;
  readonly payload: { readonly flow: InteractionFlow };
}

export interface DeleteInteractionFlowCommand {
  readonly id: string;
  readonly type: "interaction.flow.delete";
  readonly label: string;
  readonly payload: { readonly flowId: string };
}

export interface InsertDashboardNodeCommand {
  readonly id: string;
  readonly type: "dashboard.node.insert";
  readonly label: string;
  readonly payload: { readonly pageId: string; readonly node: WidgetNode };
}

export interface UpdateDashboardDataWidgetCommand {
  readonly id: string;
  readonly type: "dashboard.data-widget.update";
  readonly label: string;
  readonly payload: { readonly pageId: string; readonly nodeId: string; readonly widget: DashboardDataWidgetConfig };
}

export interface DeleteDashboardNodeCommand {
  readonly id: string;
  readonly type: "dashboard.node.delete";
  readonly label: string;
  readonly payload: { readonly pageId: string; readonly nodeId: string };
}

export type StudioCommand =
  | RenameApplicationCommand
  | RenameDashboardPageCommand
  | UpdateDashboardNodeFrameCommand
  | UpdateDashboardNodeFramesCommand
  | UpsertInteractionFlowCommand
  | DeleteInteractionFlowCommand
  | InsertDashboardNodeCommand
  | UpdateDashboardDataWidgetCommand
  | DeleteDashboardNodeCommand;

export function createRenameApplicationCommand(name: string): RenameApplicationCommand {
  return {
    id: commandId(),
    type: "application.rename",
    label: `重命名应用为“${name}”`,
    payload: { name }
  };
}

export function createRenameDashboardPageCommand(pageId: string, name: string): RenameDashboardPageCommand {
  return {
    id: commandId(),
    type: "dashboard.page.rename",
    label: `重命名页面为“${name}”`,
    payload: { pageId, name }
  };
}

export function createUpdateDashboardNodeFrameCommand(
  pageId: string,
  nodeId: string,
  frame: WidgetFrame
): UpdateDashboardNodeFrameCommand {
  return {
    id: commandId(),
    type: "dashboard.node.frame.update",
    label: "调整二维组件位置与尺寸",
    payload: { pageId, nodeId, frame: structuredClone(frame) }
  };
}

export function createUpdateDashboardNodeFramesCommand(
  pageId: string,
  frames: ReadonlyArray<{ nodeId: string; frame: WidgetFrame }>
): UpdateDashboardNodeFramesCommand {
  return {
    id: commandId(),
    type: "dashboard.node.frames.update",
    label: frames.length > 1 ? `移动 ${frames.length} 个二维组件` : "调整二维组件位置与尺寸",
    payload: { pageId, frames: structuredClone(frames) }
  };
}

export function createUpsertInteractionFlowCommand(flow: InteractionFlow): UpsertInteractionFlowCommand {
  return {
    id: commandId(),
    type: "interaction.flow.upsert",
    label: `更新联动“${flow.name}”`,
    payload: { flow: structuredClone(flow) }
  };
}

export function createDeleteInteractionFlowCommand(flowId: string): DeleteInteractionFlowCommand {
  return {
    id: commandId(),
    type: "interaction.flow.delete",
    label: "删除联动",
    payload: { flowId }
  };
}

export function createInsertDashboardNodeCommand(pageId: string, node: WidgetNode): InsertDashboardNodeCommand {
  return {
    id: commandId(),
    type: "dashboard.node.insert",
    label: "添加二维组件",
    payload: { pageId, node: structuredClone(node) }
  };
}

export function createUpdateDashboardDataWidgetCommand(pageId: string, nodeId: string, widget: DashboardDataWidgetConfig): UpdateDashboardDataWidgetCommand {
  return {
    id: commandId(),
    type: "dashboard.data-widget.update",
    label: `更新组件“${widget.title}”`,
    payload: { pageId, nodeId, widget: structuredClone(widget) }
  };
}

export function createDeleteDashboardNodeCommand(pageId: string, nodeId: string): DeleteDashboardNodeCommand {
  return {
    id: commandId(),
    type: "dashboard.node.delete",
    label: "删除二维组件",
    payload: { pageId, nodeId }
  };
}

export function applyStudioCommand(document: ApplicationDocument, command: StudioCommand): ApplicationDocument {
  switch (command.type) {
    case "application.rename":
      return { ...document, metadata: { ...document.metadata, name: command.payload.name } };
    case "dashboard.page.rename": {
      requirePage(document, command.payload.pageId);
      return {
        ...document,
        pages: document.pages.map((page) => page.id === command.payload.pageId
          ? { ...page, name: command.payload.name }
          : page)
      };
    }
    case "dashboard.node.frame.update": {
      const page = requirePage(document, command.payload.pageId);
      const node = page.nodes.find((candidate) => candidate.id === command.payload.nodeId);
      if (!node) throw new Error(`页面 ${page.id} 中不存在组件 ${command.payload.nodeId}`);
      return {
        ...document,
        pages: document.pages.map((candidate) => candidate.id === page.id
          ? {
              ...candidate,
              nodes: candidate.nodes.map((item) => item.id === command.payload.nodeId
                ? { ...item, frame: { ...command.payload.frame } }
                : item)
            }
          : candidate)
      };
    }
    case "dashboard.node.frames.update": {
      const page = requirePage(document, command.payload.pageId);
      const frames = new Map(command.payload.frames.map((entry) => [entry.nodeId, entry.frame]));
      for (const nodeId of frames.keys()) {
        if (!page.nodes.some((node) => node.id === nodeId)) throw new Error(`页面 ${page.id} 中不存在组件 ${nodeId}`);
      }
      return updatePage(document, page.id, (candidate) => ({
        ...candidate,
        nodes: candidate.nodes.map((node) => {
          const frame = frames.get(node.id);
          return frame ? { ...node, frame: { ...frame } } : node;
        })
      }));
    }
    case "interaction.flow.upsert": {
      const flow = structuredClone(command.payload.flow);
      const exists = document.interactions.some((candidate) => candidate.id === flow.id);
      return {
        ...document,
        interactions: exists
          ? document.interactions.map((candidate) => candidate.id === flow.id ? flow : candidate)
          : [...document.interactions, flow]
      };
    }
    case "interaction.flow.delete":
      return {
        ...document,
        interactions: document.interactions.filter((flow) => flow.id !== command.payload.flowId)
      };
    case "dashboard.node.insert": {
      const page = requirePage(document, command.payload.pageId);
      if (page.nodes.some((node) => node.id === command.payload.node.id)) {
        throw new Error(`页面 ${page.id} 中已存在组件 ${command.payload.node.id}`);
      }
      return updatePage(document, page.id, (candidate) => ({
        ...candidate,
        nodes: [...candidate.nodes, structuredClone(command.payload.node)]
      }));
    }
    case "dashboard.data-widget.update": {
      const page = requirePage(document, command.payload.pageId);
      const node = page.nodes.find((candidate) => candidate.id === command.payload.nodeId);
      if (!node) throw new Error(`页面 ${page.id} 中不存在组件 ${command.payload.nodeId}`);
      if (node.kind !== "data-widget") throw new Error(`组件 ${node.id} 不是数据组件`);
      return updatePage(document, page.id, (candidate) => ({
        ...candidate,
        nodes: candidate.nodes.map((item) => item.id === node.id
          ? { ...item, widget: structuredClone(command.payload.widget) }
          : item)
      }));
    }
    case "dashboard.node.delete": {
      const page = requirePage(document, command.payload.pageId);
      if (!page.nodes.some((node) => node.id === command.payload.nodeId)) {
        throw new Error(`页面 ${page.id} 中不存在组件 ${command.payload.nodeId}`);
      }
      return {
        ...updatePage(document, page.id, (candidate) => ({
          ...candidate,
          nodes: candidate.nodes.filter((node) => node.id !== command.payload.nodeId)
        })),
        interactions: document.interactions.filter((flow) => !(flow.source.kind === "widget" && flow.source.id === command.payload.nodeId))
      };
    }
  }
}

function updatePage(document: ApplicationDocument, pageId: string, update: (page: ApplicationDocument["pages"][number]) => ApplicationDocument["pages"][number]): ApplicationDocument {
  return {
    ...document,
    pages: document.pages.map((page) => page.id === pageId ? update(page) : page)
  };
}

function requirePage(document: ApplicationDocument, pageId: string) {
  const page = document.pages.find((candidate) => candidate.id === pageId);
  if (!page) throw new Error(`应用中不存在页面 ${pageId}`);
  return page;
}
