import type { ApplicationDocument, WidgetFrame } from "@bim-studio/contracts";

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

export type StudioCommand =
  | RenameApplicationCommand
  | RenameDashboardPageCommand
  | UpdateDashboardNodeFrameCommand;

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

export function applyStudioCommand(document: ApplicationDocument, command: StudioCommand): ApplicationDocument {
  const reducerInput = freezeRecursively(structuredClone(document));

  switch (command.type) {
    case "application.rename": {
      const renamed = structuredClone(reducerInput);
      return {
        ...renamed,
        metadata: { ...renamed.metadata, name: command.payload.name }
      };
    }
    case "dashboard.page.rename": {
      const renamed = structuredClone(reducerInput);
      const page = requirePage(renamed, command.payload.pageId);
      page.name = command.payload.name;
      return renamed;
    }
    case "dashboard.node.frame.update": {
      const updated = structuredClone(reducerInput);
      const page = requirePage(updated, command.payload.pageId);
      const node = page.nodes.find((candidate) => candidate.id === command.payload.nodeId);
      if (!node) throw new Error(`页面 ${page.id} 中不存在组件 ${command.payload.nodeId}`);
      node.frame = structuredClone(command.payload.frame);
      return updated;
    }
  }
}

function requirePage(document: ApplicationDocument, pageId: string) {
  const page = document.pages.find((candidate) => candidate.id === pageId);
  if (!page) throw new Error(`应用中不存在页面 ${pageId}`);
  return page;
}

function freezeRecursively<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nestedValue of Object.values(value)) {
      freezeRecursively(nestedValue);
    }
    Object.freeze(value);
  }
  return value;
}
