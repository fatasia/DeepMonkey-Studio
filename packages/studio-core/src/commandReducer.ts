import type { ApplicationDocument, WidgetNode } from "@bim-studio/contracts";
import type { DashboardNodeStatePatch, StudioCommand } from "./command.js";
import { insertDashboardPages } from "./dashboardPageBatch.js";
import { patchDashboardNodes } from "./dashboardNodePatch.js";

/** 命令归约保持纯函数：输入文档不原地修改，便于撤销、回放和审计。 */
export function applyStudioCommand(document: ApplicationDocument, command: StudioCommand): ApplicationDocument {
  switch (command.type) {
    case "dashboard.nodes.patch": return patchDashboardNodes(document, command);
    case "dashboard.pages.insert": return insertDashboardPages(document, command);
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
    case "dashboard.page.appearance.update": {
      requirePage(document, command.payload.pageId);
      return updatePage(document, command.payload.pageId, (page) => ({ ...page, appearance: structuredClone(command.payload.appearance) }));
    }
    case "dashboard.page.guides.update": {
      requirePage(document, command.payload.pageId);
      return updatePage(document, command.payload.pageId, (page) => ({
        ...page,
        guides: [...structuredClone(command.payload.guides)]
      }));
    }
    case "dashboard.page.insert": {
      if (document.pages.some((page) => page.id === command.payload.page.id)) throw new Error(`应用中已存在页面 ${command.payload.page.id}`);
      const flowIds = new Set(command.payload.interactions.map((flow) => flow.id));
      if (flowIds.size !== command.payload.interactions.length || document.interactions.some((flow) => flowIds.has(flow.id))) {
        throw new Error("待插入页面包含重复的联动 ID");
      }
      const pageIndex = command.payload.index;
      const pages = [...document.pages];
      pages.splice(pageIndex === undefined || pageIndex < 0 || pageIndex > pages.length ? pages.length : pageIndex, 0, structuredClone(command.payload.page));
      return {
        ...document,
        pages,
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
    case "script.modules.replace":
      return {
        ...document,
        // pull 采用单条命令整体替换，撤销和保存失败回滚都不会留下半套脚本。
        scripts: command.payload.scripts.map((script) => structuredClone(script))
      };
    case "script.dependencies.replace":
      return {
        ...document,
        // 命令载荷只读，文档字段可变；逐项克隆避免把命令快照暴露给后续编辑。
        scriptDependencies: command.payload.dependencies.map((dependency) => structuredClone(dependency))
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
    case "dashboard.data-widgets.update": {
      const page = requirePage(document, command.payload.pageId);
      const widgets = new Map(command.payload.widgets.map((entry) => [entry.nodeId, entry.widget]));
      for (const nodeId of widgets.keys()) {
        const node = page.nodes.find((candidate) => candidate.id === nodeId);
        if (!node) throw new Error(`页面 ${page.id} 中不存在组件 ${nodeId}`);
        if (node.kind !== "data-widget") throw new Error(`组件 ${node.id} 不是数据组件`);
      }
      return updatePage(document, page.id, (candidate) => ({
        ...candidate,
        nodes: candidate.nodes.map((node) => node.kind === "data-widget" && widgets.has(node.id)
          ? { ...node, widget: structuredClone(widgets.get(node.id)!) }
          : node)
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
  if (state.groupName === null) delete next.groupName;
  return next as WidgetNode;
}
