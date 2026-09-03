import {
  DASHBOARD_PAGE_MAX_SIZE,
  DASHBOARD_PAGE_MIN_SIZE,
  type ApplicationScriptDependency,
  type ApplicationDocument,
  type DashboardDataWidgetConfig,
  type DashboardGuide,
  type DashboardPageAppearance,
  type DashboardPageDocument,
  type DashboardViewportFit,
  type InteractionFlow,
  type SceneViewportWidgetNode,
  type ScriptModule,
  type TopologyDocument,
  type WidgetFrame,
  type WidgetNode,
} from "@bim-studio/contracts";

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

export interface UpdateDashboardPageAppearanceCommand {
  readonly id: string;
  readonly type: "dashboard.page.appearance.update";
  readonly label: string;
  readonly payload: { readonly pageId: string; readonly appearance: DashboardPageAppearance };
}

export interface InsertDashboardPageCommand {
  readonly id: string;
  readonly type: "dashboard.page.insert";
  readonly label: string;
  readonly payload: { readonly page: DashboardPageDocument; readonly interactions: readonly InteractionFlow[] };
}

export interface UpdateDashboardPageGuidesCommand {
  readonly id: string;
  readonly type: "dashboard.page.guides.update";
  readonly label: string;
  readonly payload: { readonly pageId: string; readonly guides: readonly DashboardGuide[] };
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

export interface ReplaceScriptModulesCommand {
  readonly id: string;
  readonly type: "script.modules.replace";
  readonly label: string;
  readonly payload: { readonly scripts: readonly ScriptModule[] };
}

export interface ReplaceScriptDependenciesCommand {
  readonly id: string;
  readonly type: "script.dependencies.replace";
  readonly label: string;
  readonly payload: { readonly dependencies: readonly ApplicationScriptDependency[] };
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
  readonly groupName?: string | null;
}

export interface UpdateDashboardDataWidgetCommand {
  readonly id: string;
  readonly type: "dashboard.data-widget.update";
  readonly label: string;
  readonly payload: { readonly pageId: string; readonly nodeId: string; readonly widget: DashboardDataWidgetConfig };
}

export interface UpdateDashboardDataWidgetsCommand {
  readonly id: string;
  readonly type: "dashboard.data-widgets.update";
  readonly label: string;
  readonly payload: {
    readonly pageId: string;
    readonly widgets: ReadonlyArray<{ readonly nodeId: string; readonly widget: DashboardDataWidgetConfig }>;
  };
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
  | UpdateDashboardPageAppearanceCommand
  | UpdateDashboardPageGuidesCommand
  | InsertDashboardPageCommand
  | DeleteDashboardPageCommand
  | UpdateDashboardNodeFrameCommand
  | UpdateDashboardNodeFramesCommand
  | UpdateDashboardNodeOrderCommand
  | UpsertInteractionFlowCommand
  | DeleteInteractionFlowCommand
  | UpsertScriptModuleCommand
  | DeleteScriptModuleCommand
  | ReplaceScriptModulesCommand
  | ReplaceScriptDependenciesCommand
  | UpsertTopologyCommand
  | InsertDashboardNodeCommand
  | InsertDashboardNodesCommand
  | DeleteDashboardNodesCommand
  | UpdateDashboardNodeStateCommand
  | UpdateDashboardNodeStatesCommand
  | UpdateDashboardDataWidgetCommand
  | UpdateDashboardDataWidgetsCommand
  | UpdateDashboardSceneViewportCommand
  | DeleteDashboardNodeCommand;

export function createRenameApplicationCommand(name: string): RenameApplicationCommand {
  return {
    id: commandId(),
    type: "application.rename",
    label: `重命名应用为“${name}”`,
    payload: { name },
  };
}

export function createRenameDashboardPageCommand(pageId: string, name: string): RenameDashboardPageCommand {
  return {
    id: commandId(),
    type: "dashboard.page.rename",
    label: `重命名页面为“${name}”`,
    payload: { pageId, name },
  };
}

export function createUpdateDashboardPageViewportCommand(
  pageId: string,
  viewport: { width: number; height: number; viewportFit: DashboardViewportFit },
): UpdateDashboardPageViewportCommand {
  assertDashboardPageSize(viewport.width, "宽度");
  assertDashboardPageSize(viewport.height, "高度");
  return {
    id: commandId(),
    type: "dashboard.page.viewport.update",
    label: `设置页面分辨率为 ${viewport.width} × ${viewport.height}`,
    payload: { pageId, ...viewport },
  };
}

export function createUpdateDashboardPageAppearanceCommand(pageId: string, appearance: DashboardPageAppearance): UpdateDashboardPageAppearanceCommand {
  return { id: commandId(), type: "dashboard.page.appearance.update", label: "更新页面背景", payload: { pageId, appearance: structuredClone(appearance) } };
}

export function createInsertDashboardPageCommand(page: DashboardPageDocument, interactions: readonly InteractionFlow[] = []): InsertDashboardPageCommand {
  return {
    id: commandId(),
    type: "dashboard.page.insert",
    label: `添加二维页面“${page.name}”`,
    payload: { page: structuredClone(page), interactions: structuredClone(interactions) },
  };
}

export function createUpdateDashboardPageGuidesCommand(pageId: string, guides: readonly DashboardGuide[]): UpdateDashboardPageGuidesCommand {
  return {
    id: commandId(),
    type: "dashboard.page.guides.update",
    label: guides.length === 0 ? "清空页面参考线" : "更新页面参考线",
    payload: { pageId, guides: structuredClone(guides) },
  };
}

export function createDeleteDashboardPageCommand(pageId: string): DeleteDashboardPageCommand {
  return { id: commandId(), type: "dashboard.page.delete", label: "删除二维页面", payload: { pageId } };
}

export function createUpdateDashboardNodeFrameCommand(pageId: string, nodeId: string, frame: WidgetFrame): UpdateDashboardNodeFrameCommand {
  return {
    id: commandId(),
    type: "dashboard.node.frame.update",
    label: "调整二维组件位置与尺寸",
    payload: { pageId, nodeId, frame: structuredClone(frame) },
  };
}

export function createUpdateDashboardNodeFramesCommand(pageId: string, frames: ReadonlyArray<{ nodeId: string; frame: WidgetFrame }>): UpdateDashboardNodeFramesCommand {
  return {
    id: commandId(),
    type: "dashboard.node.frames.update",
    label: frames.length > 1 ? `移动 ${frames.length} 个二维组件` : "调整二维组件位置与尺寸",
    payload: { pageId, frames: structuredClone(frames) },
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
    payload: { flow: structuredClone(flow) },
  };
}

export function createDeleteInteractionFlowCommand(flowId: string): DeleteInteractionFlowCommand {
  return {
    id: commandId(),
    type: "interaction.flow.delete",
    label: "删除联动",
    payload: { flowId },
  };
}

export function createUpsertScriptModuleCommand(script: ScriptModule): UpsertScriptModuleCommand {
  return {
    id: commandId(),
    type: "script.module.upsert",
    label: `更新行为脚本“${script.name}”`,
    payload: { script: structuredClone(script) },
  };
}

export function createDeleteScriptModuleCommand(scriptId: string): DeleteScriptModuleCommand {
  return { id: commandId(), type: "script.module.delete", label: "删除行为脚本", payload: { scriptId } };
}

export function createReplaceScriptModulesCommand(scripts: readonly ScriptModule[]): ReplaceScriptModulesCommand {
  return {
    id: commandId(),
    type: "script.modules.replace",
    label: "替换全部行为脚本",
    payload: { scripts: structuredClone(scripts) },
  };
}

export function createReplaceScriptDependenciesCommand(
  dependencies: readonly ApplicationScriptDependency[],
): ReplaceScriptDependenciesCommand {
  return {
    id: commandId(),
    type: "script.dependencies.replace",
    label: "更新脚本项目依赖",
    payload: { dependencies: structuredClone(dependencies) },
  };
}

export function createUpsertTopologyCommand(topology: TopologyDocument): UpsertTopologyCommand {
  return {
    id: commandId(),
    type: "topology.upsert",
    label: `更新拓扑“${topology.name}”`,
    payload: { topology: structuredClone(topology) },
  };
}

export function createInsertDashboardNodeCommand(pageId: string, node: WidgetNode): InsertDashboardNodeCommand {
  return {
    id: commandId(),
    type: "dashboard.node.insert",
    label: "添加二维组件",
    payload: { pageId, node: structuredClone(node) },
  };
}

export function createInsertDashboardNodesCommand(pageId: string, nodes: readonly WidgetNode[]): InsertDashboardNodesCommand {
  return {
    id: commandId(),
    type: "dashboard.nodes.insert",
    label: `粘贴 ${nodes.length} 个二维组件`,
    payload: { pageId, nodes: structuredClone(nodes) },
  };
}

export function createDeleteDashboardNodesCommand(pageId: string, nodeIds: readonly string[]): DeleteDashboardNodesCommand {
  return {
    id: commandId(),
    type: "dashboard.nodes.delete",
    label: `删除 ${nodeIds.length} 个二维组件`,
    payload: { pageId, nodeIds: [...nodeIds] },
  };
}

export function createUpdateDashboardNodeStateCommand(pageId: string, nodeId: string, state: DashboardNodeStatePatch): UpdateDashboardNodeStateCommand {
  return {
    id: commandId(),
    type: "dashboard.node.state.update",
    label:
      state.locked === true
        ? "锁定二维组件"
        : state.locked === false
          ? "解锁二维组件"
          : state.selectable === false
            ? "禁止画布选取二维组件"
            : state.selectable === true
              ? "允许画布选取二维组件"
              : state.visible === false
                ? "隐藏二维组件"
                : "显示二维组件",
    payload: { pageId, nodeId, state: { ...state } },
  };
}

export function createUpdateDashboardNodeStatesCommand(
  pageId: string,
  states: ReadonlyArray<{ nodeId: string; state: DashboardNodeStatePatch }>,
  label = "批量更新二维组件状态",
): UpdateDashboardNodeStatesCommand {
  return { id: commandId(), type: "dashboard.node.states.update", label, payload: { pageId, states: structuredClone(states) } };
}

export function createUpdateDashboardDataWidgetCommand(pageId: string, nodeId: string, widget: DashboardDataWidgetConfig): UpdateDashboardDataWidgetCommand {
  return {
    id: commandId(),
    type: "dashboard.data-widget.update",
    label: `更新组件“${widget.title}”`,
    payload: { pageId, nodeId, widget: structuredClone(widget) },
  };
}

export function createUpdateDashboardDataWidgetsCommand(
  pageId: string,
  widgets: ReadonlyArray<{ nodeId: string; widget: DashboardDataWidgetConfig }>,
  label = `批量更新 ${widgets.length} 个二维数据组件`,
): UpdateDashboardDataWidgetsCommand {
  return { id: commandId(), type: "dashboard.data-widgets.update", label, payload: { pageId, widgets: structuredClone(widgets) } };
}

export function createUpdateDashboardSceneViewportCommand(
  pageId: string,
  nodeId: string,
  viewport: UpdateDashboardSceneViewportCommand["payload"]["viewport"],
): UpdateDashboardSceneViewportCommand {
  return { id: commandId(), type: "dashboard.scene-viewport.update", label: "更新三维组件", payload: { pageId, nodeId, viewport: structuredClone(viewport) } };
}

export function createDeleteDashboardNodeCommand(pageId: string, nodeId: string): DeleteDashboardNodeCommand {
  return {
    id: commandId(),
    type: "dashboard.node.delete",
    label: "删除二维组件",
    payload: { pageId, nodeId },
  };
}

export { applyStudioCommand } from "./commandReducer.js";
function assertDashboardPageSize(value: number, label: string): void {
  if (!Number.isInteger(value) || value < DASHBOARD_PAGE_MIN_SIZE || value > DASHBOARD_PAGE_MAX_SIZE) {
    throw new Error(`页面${label}必须是 ${DASHBOARD_PAGE_MIN_SIZE} 到 ${DASHBOARD_PAGE_MAX_SIZE} 之间的整数`);
  }
}
