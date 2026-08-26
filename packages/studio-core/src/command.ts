import { DASHBOARD_PAGE_MAX_SIZE, DASHBOARD_PAGE_MIN_SIZE, type ApplicationDocument, type DashboardDataWidgetConfig, type DashboardPageDocument, type DashboardViewportFit, type InteractionFlow, type SceneViewportWidgetNode, type ScriptModule, type TopologyDocument, type WidgetFrame, type WidgetNode } from "@bim-studio/contracts";

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

export interface UpdateDashboardPageViewportCommand {
  readonly id: string;
  readonly type: "dashboard.page.viewport.update";
  readonly label: string;
  readonly payload: {
    readonly pageId: string;
    readonly width: number;
    readonly height: number;
    readonly viewportFit: DashboardViewportFit;
  };
}

export interface InsertDashboardPageCommand {
  readonly id: string;
  readonly type: "dashboard.page.insert";
  readonly label: string;
  readonly payload: { readonly page: DashboardPageDocument; readonly interactions: readonly InteractionFlow[] };
}

export interface DeleteDashboardPageCommand {
  readonly id: string;
  readonly type: "dashboard.page.delete";
  readonly label: string;
  readonly payload: { readonly pageId: string };
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

export interface UpdateDashboardNodeOrderCommand {
  readonly id: string;
  readonly type: "dashboard.node.order.update";
  readonly label: string;
  readonly payload: { readonly pageId: string; readonly order: ReadonlyArray<{ readonly nodeId: string; readonly zIndex: number }> };
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

export interface UpsertScriptModuleCommand {
  readonly id: string;
  readonly type: "script.module.upsert";
  readonly label: string;
  readonly payload: { readonly script: ScriptModule };
}

export interface DeleteScriptModuleCommand {
  readonly id: string;
  readonly type: "script.module.delete";
  readonly label: string;
  readonly payload: { readonly scriptId: string };
}

export interface UpsertTopologyCommand {
  readonly id: string;
  readonly type: "topology.upsert";
  readonly label: string;
  readonly payload: { readonly topology: TopologyDocument };
}

export interface InsertDashboardNodeCommand {
  readonly id: string;
  readonly type: "dashboard.node.insert";
  readonly label: string;
  readonly payload: { readonly pageId: string; readonly node: WidgetNode };
}

export interface InsertDashboardNodesCommand {
  readonly id: string;
  readonly type: "dashboard.nodes.insert";
  readonly label: string;
  readonly payload: { readonly pageId: string; readonly nodes: readonly WidgetNode[] };
}

export interface DeleteDashboardNodesCommand {
  readonly id: string;
  readonly type: "dashboard.nodes.delete";
  readonly label: string;
  readonly payload: { readonly pageId: string; readonly nodeIds: readonly string[] };
}

export interface UpdateDashboardNodeStateCommand {
  readonly id: string;
  readonly type: "dashboard.node.state.update";
  readonly label: string;
  readonly payload: {
    readonly pageId: string;
    readonly nodeId: string;
    readonly state: DashboardNodeStatePatch;
  };
}

export interface UpdateDashboardNodeStatesCommand {
  readonly id: string;
  readonly type: "dashboard.node.states.update";
  readonly label: string;
  readonly payload: {
    readonly pageId: string;
    readonly states: ReadonlyArray<{ readonly nodeId: string; readonly state: DashboardNodeStatePatch }>;
  };
}

export interface DashboardNodeStatePatch {
  readonly name?: string;
  readonly visible?: boolean;
  readonly selectable?: boolean;
  readonly locked?: boolean;
  readonly groupId?: string | null;
}

export interface UpdateDashboardDataWidgetCommand {
  readonly id: string;
  readonly type: "dashboard.data-widget.update";
  readonly label: string;
  readonly payload: { readonly pageId: string; readonly nodeId: string; readonly widget: DashboardDataWidgetConfig };
}

export interface UpdateDashboardSceneViewportCommand {
  readonly id: string;
  readonly type: "dashboard.scene-viewport.update";
  readonly label: string;
  readonly payload: {
    readonly pageId: string;
    readonly nodeId: string;
    readonly viewport: Pick<SceneViewportWidgetNode, "sceneId" | "renderMode" | "interactionPolicy"> & { readonly cameraViewId?: string };
  };
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
  | UpdateDashboardPageViewportCommand
  | InsertDashboardPageCommand
  | DeleteDashboardPageCommand
  | UpdateDashboardNodeFrameCommand
  | UpdateDashboardNodeFramesCommand
  | UpdateDashboardNodeOrderCommand
  | UpsertInteractionFlowCommand
  | DeleteInteractionFlowCommand
  | UpsertScriptModuleCommand
  | DeleteScriptModuleCommand
  | UpsertTopologyCommand
  | InsertDashboardNodeCommand
  | InsertDashboardNodesCommand
  | DeleteDashboardNodesCommand
  | UpdateDashboardNodeStateCommand
  | UpdateDashboardNodeStatesCommand
  | UpdateDashboardDataWidgetCommand
  | UpdateDashboardSceneViewportCommand
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

export function createUpdateDashboardPageViewportCommand(
  pageId: string,
  viewport: { width: number; height: number; viewportFit: DashboardViewportFit }
): UpdateDashboardPageViewportCommand {
  assertDashboardPageSize(viewport.width, "宽度");
  assertDashboardPageSize(viewport.height, "高度");
  return {
    id: commandId(),
    type: "dashboard.page.viewport.update",
    label: `设置页面分辨率为 ${viewport.width} × ${viewport.height}`,
    payload: { pageId, ...viewport }
  };
}

export function createInsertDashboardPageCommand(page: DashboardPageDocument, interactions: readonly InteractionFlow[] = []): InsertDashboardPageCommand {
  return {
    id: commandId(),
    type: "dashboard.page.insert",
    label: `添加二维页面“${page.name}”`,
    payload: { page: structuredClone(page), interactions: structuredClone(interactions) }
  };
}

export function createDeleteDashboardPageCommand(pageId: string): DeleteDashboardPageCommand {
  return { id: commandId(), type: "dashboard.page.delete", label: "删除二维页面", payload: { pageId } };
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

export function createUpdateDashboardNodeOrderCommand(pageId: string, order: ReadonlyArray<{ nodeId: string; zIndex: number }>): UpdateDashboardNodeOrderCommand {
  return { id: commandId(), type: "dashboard.node.order.update", label: "调整二维图层顺序", payload: { pageId, order: structuredClone(order) } };
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

export function createUpsertScriptModuleCommand(script: ScriptModule): UpsertScriptModuleCommand {
  return {
    id: commandId(),
    type: "script.module.upsert",
    label: `更新行为脚本“${script.name}”`,
    payload: { script: structuredClone(script) }
  };
}

export function createDeleteScriptModuleCommand(scriptId: string): DeleteScriptModuleCommand {
  return { id: commandId(), type: "script.module.delete", label: "删除行为脚本", payload: { scriptId } };
}

export function createUpsertTopologyCommand(topology: TopologyDocument): UpsertTopologyCommand {
  return {
    id: commandId(),
    type: "topology.upsert",
    label: `更新拓扑“${topology.name}”`,
    payload: { topology: structuredClone(topology) }
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

export function createInsertDashboardNodesCommand(pageId: string, nodes: readonly WidgetNode[]): InsertDashboardNodesCommand {
  return {
    id: commandId(),
    type: "dashboard.nodes.insert",
    label: `粘贴 ${nodes.length} 个二维组件`,
    payload: { pageId, nodes: structuredClone(nodes) }
  };
}

export function createDeleteDashboardNodesCommand(pageId: string, nodeIds: readonly string[]): DeleteDashboardNodesCommand {
  return {
    id: commandId(),
    type: "dashboard.nodes.delete",
    label: `删除 ${nodeIds.length} 个二维组件`,
    payload: { pageId, nodeIds: [...nodeIds] }
  };
}

export function createUpdateDashboardNodeStateCommand(
  pageId: string,
  nodeId: string,
  state: DashboardNodeStatePatch
): UpdateDashboardNodeStateCommand {
  return {
    id: commandId(),
    type: "dashboard.node.state.update",
    label: state.locked === true ? "锁定二维组件"
      : state.locked === false ? "解锁二维组件"
        : state.selectable === false ? "禁止画布选取二维组件"
          : state.selectable === true ? "允许画布选取二维组件"
            : state.visible === false ? "隐藏二维组件" : "显示二维组件",
    payload: { pageId, nodeId, state: { ...state } }
  };
}

export function createUpdateDashboardNodeStatesCommand(
  pageId: string,
  states: ReadonlyArray<{ nodeId: string; state: DashboardNodeStatePatch }>,
  label = "批量更新二维组件状态"
): UpdateDashboardNodeStatesCommand {
  return { id: commandId(), type: "dashboard.node.states.update", label, payload: { pageId, states: structuredClone(states) } };
}

export function createUpdateDashboardDataWidgetCommand(pageId: string, nodeId: string, widget: DashboardDataWidgetConfig): UpdateDashboardDataWidgetCommand {
  return {
    id: commandId(),
    type: "dashboard.data-widget.update",
    label: `更新组件“${widget.title}”`,
    payload: { pageId, nodeId, widget: structuredClone(widget) }
  };
}

export function createUpdateDashboardSceneViewportCommand(
  pageId: string,
  nodeId: string,
  viewport: UpdateDashboardSceneViewportCommand["payload"]["viewport"]
): UpdateDashboardSceneViewportCommand {
  return { id: commandId(), type: "dashboard.scene-viewport.update", label: "更新三维组件", payload: { pageId, nodeId, viewport: structuredClone(viewport) } };
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
    case "dashboard.page.viewport.update": {
      requirePage(document, command.payload.pageId);
      return updatePage(document, command.payload.pageId, (page) => ({
        ...page,
        width: command.payload.width,
        height: command.payload.height,
        viewportFit: command.payload.viewportFit
      }));
    }
    case "dashboard.page.insert": {
      if (document.pages.some((page) => page.id === command.payload.page.id)) throw new Error(`应用中已存在页面 ${command.payload.page.id}`);
      const flowIds = new Set(command.payload.interactions.map((flow) => flow.id));
      if (flowIds.size !== command.payload.interactions.length || document.interactions.some((flow) => flowIds.has(flow.id))) {
        throw new Error("待插入页面包含重复的联动 ID");
      }
      return {
        ...document,
        pages: [...document.pages, structuredClone(command.payload.page)],
        interactions: [...document.interactions, ...structuredClone(command.payload.interactions)]
      };
    }
    case "dashboard.page.delete": {
      const page = requirePage(document, command.payload.pageId);
      if (document.pages.length === 1) throw new Error("应用至少需要保留一个二维页面");
      const nodeIds = new Set(page.nodes.map((node) => node.id));
      return {
        ...document,
        pages: document.pages.filter((candidate) => candidate.id !== page.id),
        interactions: document.interactions.filter((flow) => flow.source.kind === "page"
          ? flow.source.id !== page.id
          : !(flow.source.kind === "widget" && nodeIds.has(flow.source.id)))
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
    case "dashboard.node.order.update": {
      const page = requirePage(document, command.payload.pageId);
      const order = new Map(command.payload.order.map((entry) => [entry.nodeId, entry.zIndex]));
      for (const nodeId of order.keys()) {
        if (!page.nodes.some((node) => node.id === nodeId)) throw new Error(`页面 ${page.id} 中不存在组件 ${nodeId}`);
      }
      return updatePage(document, page.id, (candidate) => ({
        ...candidate,
        nodes: candidate.nodes.map((node) => order.has(node.id) ? { ...node, zIndex: order.get(node.id)! } : node)
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
    case "script.module.upsert": {
      const script = structuredClone(command.payload.script);
      const exists = document.scripts.some((candidate) => candidate.id === script.id);
      return {
        ...document,
        scripts: exists
          ? document.scripts.map((candidate) => candidate.id === script.id ? script : candidate)
          : [...document.scripts, script]
      };
    }
    case "script.module.delete":
      return {
        ...document,
        scripts: document.scripts.filter((script) => script.id !== command.payload.scriptId)
      };
    case "topology.upsert": {
      const topology = structuredClone(command.payload.topology);
      const exists = document.topologies.some((candidate) => candidate.id === topology.id);
      return {
        ...document,
        topologies: exists
          ? document.topologies.map((candidate) => candidate.id === topology.id ? topology : candidate)
          : [...document.topologies, topology]
      };
    }
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
    case "dashboard.nodes.insert": {
      const page = requirePage(document, command.payload.pageId);
      const nodeIds = new Set(command.payload.nodes.map((node) => node.id));
      if (nodeIds.size !== command.payload.nodes.length) throw new Error("待插入的二维组件 ID 重复");
      for (const nodeId of nodeIds) {
        if (page.nodes.some((node) => node.id === nodeId)) throw new Error(`页面 ${page.id} 中已存在组件 ${nodeId}`);
      }
      return updatePage(document, page.id, (candidate) => ({
        ...candidate,
        nodes: [...candidate.nodes, ...structuredClone(command.payload.nodes)]
      }));
    }
    case "dashboard.nodes.delete": {
      const page = requirePage(document, command.payload.pageId);
      const nodeIds = new Set(command.payload.nodeIds);
      for (const nodeId of nodeIds) {
        if (!page.nodes.some((node) => node.id === nodeId)) throw new Error(`页面 ${page.id} 中不存在组件 ${nodeId}`);
      }
      return {
        ...updatePage(document, page.id, (candidate) => ({
          ...candidate,
          nodes: candidate.nodes.filter((node) => !nodeIds.has(node.id))
        })),
        interactions: document.interactions.filter((flow) => !(flow.source.kind === "widget" && nodeIds.has(flow.source.id)))
      };
    }
    case "dashboard.node.state.update": {
      const page = requirePage(document, command.payload.pageId);
      if (!page.nodes.some((node) => node.id === command.payload.nodeId)) {
        throw new Error(`页面 ${page.id} 中不存在组件 ${command.payload.nodeId}`);
      }
      return updatePage(document, page.id, (candidate) => ({
        ...candidate,
        nodes: candidate.nodes.map((node) => node.id === command.payload.nodeId ? applyNodeState(node, command.payload.state) : node)
      }));
    }
    case "dashboard.node.states.update": {
      const page = requirePage(document, command.payload.pageId);
      const states = new Map(command.payload.states.map((entry) => [entry.nodeId, entry.state]));
      for (const nodeId of states.keys()) {
        if (!page.nodes.some((node) => node.id === nodeId)) throw new Error(`页面 ${page.id} 中不存在组件 ${nodeId}`);
      }
      return updatePage(document, page.id, (candidate) => ({
        ...candidate,
        nodes: candidate.nodes.map((node) => states.has(node.id) ? applyNodeState(node, states.get(node.id)!) : node)
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
    case "dashboard.scene-viewport.update": {
      const page = requirePage(document, command.payload.pageId);
      const node = page.nodes.find((candidate) => candidate.id === command.payload.nodeId);
      if (!node) throw new Error(`页面 ${page.id} 中不存在组件 ${command.payload.nodeId}`);
      if (node.kind !== "scene-viewport") throw new Error(`组件 ${node.id} 不是三维组件`);
      return updatePage(document, page.id, (candidate) => ({
        ...candidate,
        nodes: candidate.nodes.map((item) => item.id === node.id ? { ...item, ...structuredClone(command.payload.viewport) } : item)
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

function applyNodeState(node: WidgetNode, state: DashboardNodeStatePatch): WidgetNode {
  const next = { ...node, ...state };
  if (state.groupId === null) delete next.groupId;
  return next as WidgetNode;
}

function assertDashboardPageSize(value: number, label: string): void {
  if (!Number.isInteger(value) || value < DASHBOARD_PAGE_MIN_SIZE || value > DASHBOARD_PAGE_MAX_SIZE) {
    throw new Error(`页面${label}必须是 ${DASHBOARD_PAGE_MIN_SIZE} 到 ${DASHBOARD_PAGE_MAX_SIZE} 之间的整数`);
  }
}
