import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import type { DashboardGuide, WidgetFrame, WidgetNode } from "@bim-studio/contracts";
import {
  alignDashboardFrames,
  createDeleteDashboardNodesCommand,
  createInsertDashboardNodesCommand,
  createUpdateDashboardNodeFrameCommand,
  createUpdateDashboardNodeFramesCommand,
  createUpdateDashboardNodeOrderCommand,
  createUpdateDashboardNodeStateCommand,
  createUpdateDashboardNodeStatesCommand,
  createUpdateDashboardPageGuidesCommand,
  distributeDashboardFrames,
  type DashboardAlignment,
  type DashboardDistribution
} from "@bim-studio/studio-core";
import { translate as tr } from "../i18n";
import { isolateCopiedDashboardSamples } from "./dashboardSampleMetrics";
import type { DashboardViewState } from "../studio/workspaceRoute";
import {
  CANVAS_MARGIN,
  calculateDashboardEditorFocus,
  dashboardNodeIdentity,
  dashboardNodeLabel,
  dashboardNodeSelection,
  uniqueDashboardNodeName,
  type DashboardEditorFocusMode,
  type SelectionRect
} from "./dashboardWorkspaceModel";
import { beginDashboardNodeTransform } from "./dashboardNodeTransform";
import type { DashboardCanvasControllerContext } from "./dashboardCanvasTypes";

/** 集中管理画布坐标、选择、吸附与图层操作，页面组件只负责产品编排。 */
export function createDashboardCanvasController(context: DashboardCanvasControllerContext) {
  const {
    locale, page, zoom, setZoom, selectedNode, selectedNodeIds, setSelectedNodeIds,
    normalizedInitialView, scrollRef, artboardRef, artboardOffsetX, artboardOffsetY, spacePressedRef,
    setViewportScroll, setPanning, busy, onViewStateChange, onSelectionChange, onNodeInteraction,
    onCommand, guidesVisible, snapEnabled, setDraftFrames, setActiveSnapLines, draftGuides,
    setDraftGuides, clipboardRef, contextMenu, setContextMenu, marqueeMode, setMarqueeMode,
    setSelectionRect, dashboardGroups
  } = context;
  function currentView(): DashboardViewState {
    return {
      zoom,
      scrollLeft: scrollRef.current?.scrollLeft ?? normalizedInitialView.scrollLeft,
      scrollTop: scrollRef.current?.scrollTop ?? normalizedInitialView.scrollTop,
      selectedNodeIds
    };
  }

  function emitViewState() {
    onViewStateChange(currentView());
  }

  function handleCanvasScroll() {
    const surface = scrollRef.current;
    if (surface) setViewportScroll({ left: surface.scrollLeft, top: surface.scrollTop });
    emitViewState();
  }

  function fitCanvasToViewport(mode: DashboardEditorFocusMode = "page") {
    const surface = scrollRef.current;
    if (!surface) return;
    const focus = calculateDashboardEditorFocus(page, page.nodes, surface.clientWidth, surface.clientHeight, mode);
    const nextZoom = focus.zoom;
    setZoom(nextZoom);
    window.requestAnimationFrame(() => {
      const nextStageWidth = Math.max(surface.clientWidth, page.width * nextZoom + CANVAS_MARGIN * 2);
      const nextStageHeight = Math.max(surface.clientHeight, page.height * nextZoom + CANVAS_MARGIN * 2);
      const nextOffsetX = Math.max(CANVAS_MARGIN, (nextStageWidth - page.width * nextZoom) / 2);
      const nextOffsetY = Math.max(CANVAS_MARGIN, (nextStageHeight - page.height * nextZoom) / 2);
      surface.scrollLeft = Math.max(0, Math.min(nextStageWidth - surface.clientWidth, nextOffsetX + focus.centerX * nextZoom - surface.clientWidth / 2));
      surface.scrollTop = Math.max(0, Math.min(nextStageHeight - surface.clientHeight, nextOffsetY + focus.centerY * nextZoom - surface.clientHeight / 2));
      onViewStateChange({ zoom: nextZoom, scrollLeft: surface.scrollLeft, scrollTop: surface.scrollTop, selectedNodeIds });
    });
  }

  function changeZoom(nextZoom: number, clientX?: number, clientY?: number) {
    const surface = scrollRef.current;
    const clamped = Math.max(0.1, Math.min(2, Number(nextZoom.toFixed(3))));
    if (!surface || clamped === zoom) return setZoom(clamped);
    const bounds = surface.getBoundingClientRect();
    const localX = clientX === undefined ? surface.clientWidth / 2 : clientX - bounds.left;
    const localY = clientY === undefined ? surface.clientHeight / 2 : clientY - bounds.top;
    const logicalX = (surface.scrollLeft + localX - artboardOffsetX) / zoom;
    const logicalY = (surface.scrollTop + localY - artboardOffsetY) / zoom;
    const nextStageWidth = Math.max(surface.clientWidth, page.width * clamped + CANVAS_MARGIN * 2);
    const nextStageHeight = Math.max(surface.clientHeight, page.height * clamped + CANVAS_MARGIN * 2);
    const nextOffsetX = Math.max(CANVAS_MARGIN, (nextStageWidth - page.width * clamped) / 2);
    const nextOffsetY = Math.max(CANVAS_MARGIN, (nextStageHeight - page.height * clamped) / 2);
    setZoom(clamped);
    window.requestAnimationFrame(() => {
      surface.scrollLeft = Math.max(0, nextOffsetX + logicalX * clamped - localX);
      surface.scrollTop = Math.max(0, nextOffsetY + logicalY * clamped - localY);
      onViewStateChange({ zoom: clamped, scrollLeft: surface.scrollLeft, scrollTop: surface.scrollTop, selectedNodeIds });
    });
  }

  function zoomCanvas(event: WheelEvent) {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    changeZoom(zoom * (event.deltaY > 0 ? 0.9 : 1.1), event.clientX, event.clientY);
  }

  function beginCanvasPan(event: ReactPointerEvent<HTMLDivElement>): boolean {
    if (event.button !== 1 && !(event.button === 0 && spacePressedRef.current)) return false;
    const surface = scrollRef.current;
    if (!surface) return false;
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startY = event.clientY;
    const startLeft = surface.scrollLeft;
    const startTop = surface.scrollTop;
    const pointerId = event.pointerId;
    setPanning(true);
    const move = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      surface.scrollLeft = startLeft - (pointer.clientX - startX);
      surface.scrollTop = startTop - (pointer.clientY - startY);
    };
    const finish = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      setPanning(false);
      emitViewState();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    return true;
  }

  function selectNode(node: WidgetNode, additive: boolean, force = false) {
    if (node.locked || (!force && node.selectable === false)) return;
    const next = dashboardNodeSelection(page.nodes, node.id, selectedNodeIds, additive);
    setSelectedNodeIds(next);
    onSelectionChange(next.map((id) => ({ kind: "widget", id })));
    onNodeInteraction(node.id);
  }

  function updateSelectedFrame(field: keyof WidgetFrame, value: number) {
    if (!selectedNode || selectedNode.locked || !Number.isFinite(value)) return;
    const next = {
      ...selectedNode.frame,
      [field]: field === "width" || field === "height" ? Math.max(1, Math.round(value)) : Math.round(value)
    };
    onCommand(createUpdateDashboardNodeFrameCommand(page.id, selectedNode.id, next));
  }

  function beginNodeTransform(event: ReactPointerEvent<HTMLButtonElement>, node: WidgetNode, mode: "move" | "resize") {
    // Alt+拖拽=复制并拖动副本（对标 FVS alt+拖拽）：同步插入同位克隆，手势无缝接管克隆体。
    if (event.altKey && mode === "move" && !node.locked) {
      const topZIndex = Math.max(0, ...page.nodes.map((item) => item.zIndex));
      const usedNames = new Set(page.nodes.map((item) => dashboardNodeIdentity(item).toLocaleLowerCase()));
      const name = uniqueDashboardNodeName(`${dashboardNodeIdentity(node)} ${tr(locale, "副本", "copy")}`, usedNames);
      const clone: WidgetNode = {
        ...structuredClone(node),
        id: `${node.kind}:${crypto.randomUUID()}`,
        name,
        zIndex: topZIndex + 1,
        visible: true,
        locked: false,
        ...(node.groupId ? { groupId: `group:${crypto.randomUUID()}` } : {})
      };
      if (clone.kind === "data-widget") clone.widget = (isolateCopiedDashboardSamples([clone])[0] as typeof clone).widget;
      onCommand(createInsertDashboardNodesCommand(page.id, [clone]));
      const ids = [clone.id];
      setSelectedNodeIds(ids);
      onSelectionChange(ids.map((id) => ({ kind: "widget", id })));
      node = clone;
    }
    beginDashboardNodeTransform({
      event,
      node,
      mode,
      page,
      selectedNodeIds,
      guidesVisible,
      snapEnabled,
      zoom,
      setDraftFrames,
      setActiveSnapLines,
      onCommand,
    });
  }

  function addGuide(orientation: DashboardGuide["orientation"], event: ReactPointerEvent<HTMLElement>) {
    const artboard = artboardRef.current;
    if (!artboard || event.button !== 0) return;
    const bounds = artboard.getBoundingClientRect();
    const raw = orientation === "vertical" ? (event.clientX - bounds.left) / zoom : (event.clientY - bounds.top) / zoom;
    const limit = orientation === "vertical" ? page.width : page.height;
    const position = Math.max(0, Math.min(limit, Math.round(raw)));
    onCommand(createUpdateDashboardPageGuidesCommand(page.id, [...(page.guides ?? []), { id: `guide:${crypto.randomUUID()}`, orientation, position }]));
  }

  function beginGuideDrag(event: ReactPointerEvent<HTMLButtonElement>, guide: DashboardGuide) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const pointerId = event.pointerId;
    const currentGuides = structuredClone(page.guides ?? []);
    const positionAt = (pointer: PointerEvent) => {
      const bounds = artboardRef.current?.getBoundingClientRect();
      if (!bounds) return guide.position;
      return Math.round((guide.orientation === "vertical" ? pointer.clientX - bounds.left : pointer.clientY - bounds.top) / zoom);
    };
    const move = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      const position = positionAt(pointer);
      setDraftGuides(currentGuides.map((item) => item.id === guide.id ? { ...item, position } : item));
    };
    const finish = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      cleanup();
      const limit = guide.orientation === "vertical" ? page.width : page.height;
      const position = positionAt(pointer);
      const next = position < 0 || position > limit
        ? currentGuides.filter((item) => item.id !== guide.id)
        : currentGuides.map((item) => item.id === guide.id ? { ...item, position: Math.max(0, Math.min(limit, position)) } : item);
      setDraftGuides(undefined);
      onCommand(createUpdateDashboardPageGuidesCommand(page.id, next));
    };
    const cancel = () => { cleanup(); setDraftGuides(undefined); };
    const cleanup = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", finish); window.removeEventListener("pointercancel", cancel); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
  }

  function copySelectedNodes() {
    clipboardRef.current = page.nodes.filter((node) => selectedNodeIds.includes(node.id)).map((node) => structuredClone(node));
  }

  function pasteCopiedNodes() {
    if (clipboardRef.current.length === 0 || busy) return;
    const topZIndex = Math.max(0, ...page.nodes.map((node) => node.zIndex));
    const groupIds = new Map([...new Set(clipboardRef.current.flatMap((node) => node.groupId ? [node.groupId] : []))].map((groupId) => [groupId, `group:${crypto.randomUUID()}`]));
    const usedNames = new Set(page.nodes.map((node) => dashboardNodeIdentity(node).toLocaleLowerCase()));
    const nodes = isolateCopiedDashboardSamples(clipboardRef.current.map((source, index): WidgetNode => {
      const name = uniqueDashboardNodeName(`${dashboardNodeIdentity(source)} ${tr(locale, "副本", "copy")}`, usedNames);
      usedNames.add(name.toLocaleLowerCase());
      return {
        ...structuredClone(source),
        id: `${source.kind}:${crypto.randomUUID()}`,
        name,
        frame: {
          ...source.frame,
          x: Math.min(page.width - source.frame.width, Math.max(0, source.frame.x + 24)),
          y: Math.min(page.height - source.frame.height, Math.max(0, source.frame.y + 24))
        },
        zIndex: topZIndex + index + 1,
        visible: true,
        locked: false,
        ...(source.groupId ? { groupId: groupIds.get(source.groupId)! } : {})
      };
    }));
    clipboardRef.current = nodes.map((node) => structuredClone(node));
    onCommand(createInsertDashboardNodesCommand(page.id, nodes));
    const ids = nodes.map((node) => node.id);
    setSelectedNodeIds(ids);
    onSelectionChange(ids.map((id) => ({ kind: "widget", id })));
  }

  function deleteSelectedNodes() {
    if (busy) return;
    const nodeIds = page.nodes.filter((node) => selectedNodeIds.includes(node.id) && node.locked !== true).map((node) => node.id);
    if (nodeIds.length === 0) return;
    onCommand(createDeleteDashboardNodesCommand(page.id, nodeIds));
    const remaining = selectedNodeIds.filter((id) => !nodeIds.includes(id));
    setSelectedNodeIds(remaining);
    onSelectionChange(remaining.map((id) => ({ kind: "widget", id })));
  }

  function deleteLayerNode(node: WidgetNode) {
    if (busy || node.locked) return;
    if (!window.confirm(tr(locale, `确定删除组件“${dashboardNodeLabel(node)}”吗？删除后仍可通过撤销恢复。`, `Delete “${dashboardNodeLabel(node)}”? You can still restore it with Undo.`))) return;
    onCommand(createDeleteDashboardNodesCommand(page.id, [node.id]));
    const remaining = selectedNodeIds.filter((id) => id !== node.id);
    setSelectedNodeIds(remaining);
    onSelectionChange(remaining.map((id) => ({ kind: "widget", id })));
  }

  function toggleLayerLock(node: WidgetNode) {
    const locked = !node.locked;
    onCommand(createUpdateDashboardNodeStateCommand(page.id, node.id, { locked, selectable: !locked }));
    if (!locked || !selectedNodeIds.includes(node.id)) return;
    const remaining = selectedNodeIds.filter((id) => id !== node.id);
    setSelectedNodeIds(remaining);
    onSelectionChange(remaining.map((id) => ({ kind: "widget", id })));
  }

  function nudgeSelectedNodes(dx: number, dy: number) {
    if (busy) return;
    const frames = page.nodes
      .filter((node) => selectedNodeIds.includes(node.id) && node.locked !== true)
      .map((node) => ({
        nodeId: node.id,
        frame: {
          ...node.frame,
          x: Math.max(0, Math.min(page.width - node.frame.width, node.frame.x + dx)),
          y: Math.max(0, Math.min(page.height - node.frame.height, node.frame.y + dy))
        }
      }))
      .filter(({ nodeId, frame }) => {
        const original = page.nodes.find((node) => node.id === nodeId)!.frame;
        return frame.x !== original.x || frame.y !== original.y;
      });
    if (frames.length > 0) onCommand(createUpdateDashboardNodeFramesCommand(page.id, frames));
  }

  function layoutSelectedNodes(mode: DashboardAlignment | DashboardDistribution) {
    const entries = page.nodes
      .filter((node) => selectedNodeIds.includes(node.id) && node.visible !== false && node.locked !== true)
      .map((node) => ({ nodeId: node.id, frame: node.frame }));
    const next = mode === "horizontal" || mode === "vertical"
      ? distributeDashboardFrames(entries, mode)
      : alignDashboardFrames(entries, mode);
    const changed = next.filter(({ nodeId, frame }) => {
      const original = page.nodes.find((node) => node.id === nodeId)!.frame;
      return frame.x !== original.x || frame.y !== original.y;
    });
    if (changed.length > 0) onCommand(createUpdateDashboardNodeFramesCommand(page.id, changed));
  }

  function groupSelectedNodes() {
    const nodes = page.nodes.filter((node) => selectedNodeIds.includes(node.id) && node.locked !== true);
    if (nodes.length < 2) return;
    const groupId = `group:${crypto.randomUUID()}`;
    const groupName = `${tr(locale, "编组", "Group")} ${dashboardGroups.length + 1}`;
    onCommand(createUpdateDashboardNodeStatesCommand(page.id, nodes.map((node) => ({ nodeId: node.id, state: { groupId, groupName } })), `编组 ${nodes.length} 个二维组件`));
  }

  function ungroupSelectedNodes() {
    const nodes = page.nodes.filter((node) => selectedNodeIds.includes(node.id) && node.groupId && node.locked !== true);
    if (nodes.length === 0) return;
    onCommand(createUpdateDashboardNodeStatesCommand(page.id, nodes.map((node) => ({ nodeId: node.id, state: { groupId: null, groupName: null } })), `解组 ${nodes.length} 个二维组件`));
  }

  function renameDashboardGroup(group: { id: string; nodes: readonly WidgetNode[]; label: string }) {
    const name = window.prompt(tr(locale, "输入编组名称", "Enter group name"), group.label)?.trim();
    if (!name || name === group.label) return;
    onCommand(createUpdateDashboardNodeStatesCommand(page.id, group.nodes.map((node) => ({ nodeId: node.id, state: { groupName: name } })), `重命名二维编组为 ${name}`));
  }

  function updateDashboardGroup(group: { id: string; nodes: WidgetNode[] }, patch: { visible?: boolean; locked?: boolean }) {
    const states = group.nodes.filter((node) => node.locked !== true || patch.locked === false).map((node) => ({ nodeId: node.id, state: patch }));
    if (states.length > 0) onCommand(createUpdateDashboardNodeStatesCommand(page.id, states, `${patch.visible === undefined ? (patch.locked ? "锁定" : "解锁") : patch.visible ? "显示" : "隐藏"}二维编组`));
  }

  function reorderSelectedNodes(direction: "front" | "forward" | "backward" | "back") {
    reorderNodeIds(selectedNodeIds, direction);
  }

  function reorderNodeIds(nodeIds: readonly string[], direction: "front" | "forward" | "backward" | "back") {
    const selected = new Set(page.nodes.filter((node) => nodeIds.includes(node.id) && node.locked !== true).map((node) => node.id));
    if (selected.size === 0) return;
    const ordered = [...page.nodes].sort((left, right) => left.zIndex - right.zIndex);
    if (direction === "front" || direction === "back") {
      const picked = ordered.filter((node) => selected.has(node.id));
      const rest = ordered.filter((node) => !selected.has(node.id));
      ordered.splice(0, ordered.length, ...(direction === "front" ? [...rest, ...picked] : [...picked, ...rest]));
    } else if (direction === "forward") {
      for (let index = ordered.length - 2; index >= 0; index -= 1) {
        if (selected.has(ordered[index]!.id) && !selected.has(ordered[index + 1]!.id)) [ordered[index], ordered[index + 1]] = [ordered[index + 1]!, ordered[index]!];
      }
    } else {
      for (let index = 1; index < ordered.length; index += 1) {
        if (selected.has(ordered[index]!.id) && !selected.has(ordered[index - 1]!.id)) [ordered[index - 1], ordered[index]] = [ordered[index]!, ordered[index - 1]!];
      }
    }
    const order = ordered.map((node, zIndex) => ({ nodeId: node.id, zIndex })).filter(({ nodeId, zIndex }) => page.nodes.find((node) => node.id === nodeId)!.zIndex !== zIndex);
    if (order.length > 0) onCommand(createUpdateDashboardNodeOrderCommand(page.id, order));
  }

  function reorderLayerByDrop(sourceId: string, targetId: string) {
    if (sourceId === targetId) return;
    const displayed = [...page.nodes].sort((left, right) => right.zIndex - left.zIndex);
    const source = displayed.find((node) => node.id === sourceId);
    const targetIndex = displayed.findIndex((node) => node.id === targetId);
    if (!source || source.locked || targetIndex < 0) return;
    const withoutSource = displayed.filter((node) => node.id !== sourceId);
    const insertionIndex = withoutSource.findIndex((node) => node.id === targetId);
    withoutSource.splice(Math.max(0, insertionIndex), 0, source);
    const order = [...withoutSource].reverse().map((node, zIndex) => ({ nodeId: node.id, zIndex }));
    onCommand(createUpdateDashboardNodeOrderCommand(page.id, order));
  }

  function contextNodeIds(): string[] {
    if (!contextMenu) return [];
    return selectedNodeIds.includes(contextMenu.nodeId) ? selectedNodeIds : [contextMenu.nodeId];
  }

  function openNodeContextMenu(event: ReactMouseEvent, node: WidgetNode) {
    if (node.locked) return;
    event.preventDefault();
    event.stopPropagation();
    if (!selectedNodeIds.includes(node.id)) {
      setSelectedNodeIds([node.id]);
      onSelectionChange([{ kind: "widget", id: node.id }]);
    }
    const menuWidth = 190;
    const menuHeight = 310;
    // 右键选层（EX-001A）：按 zIndex 降序列出该节点包围盒内、与节点有面积重叠的全部组件，
    // 被遮挡组件经"选择"子菜单直达（对标 FVS 右键图层列表）。
    const bounds = node.frame;
    const stack = page.nodes
      .filter((candidate) => candidate.visible !== false)
      .filter((candidate) => candidate.frame.x < bounds.x + bounds.width
        && candidate.frame.y < bounds.y + bounds.height
        && candidate.frame.x + candidate.frame.width > bounds.x
        && candidate.frame.y + candidate.frame.height > bounds.y)
      .sort((left, right) => right.zIndex - left.zIndex)
      .map((candidate) => candidate.id);
    setContextMenu({ x: Math.min(event.clientX, window.innerWidth - menuWidth - 8), y: Math.min(event.clientY, window.innerHeight - menuHeight - 8), nodeId: node.id, ...(stack.length > 1 ? { stack } : {}) });
  }

  function copyContextNodes(duplicate = false) {
    const ids = contextNodeIds();
    clipboardRef.current = page.nodes.filter((node) => ids.includes(node.id)).map((node) => structuredClone(node));
    if (duplicate) pasteCopiedNodes();
    setContextMenu(undefined);
  }

  function updateContextNodes(state: Parameters<typeof createUpdateDashboardNodeStatesCommand>[1][number]["state"], label: string) {
    const ids = contextNodeIds();
    if (!ids.length) return;
    onCommand(createUpdateDashboardNodeStatesCommand(page.id, ids.map((nodeId) => ({ nodeId, state })), label));
    if (state.locked === true) {
      setSelectedNodeIds([]);
      onSelectionChange([]);
    }
    setContextMenu(undefined);
  }

  function deleteContextNodes() {
    const ids = contextNodeIds();
    const nodes = page.nodes.filter((node) => ids.includes(node.id) && !node.locked);
    if (!nodes.length || !window.confirm(tr(locale, `确定删除 ${nodes.length} 个组件吗？删除后仍可通过撤销恢复。`, `Delete ${nodes.length} component(s)? You can still restore them with Undo.`))) return;
    onCommand(createDeleteDashboardNodesCommand(page.id, nodes.map((node) => node.id)));
    setSelectedNodeIds([]);
    onSelectionChange([]);
    setContextMenu(undefined);
  }

  function beginMarqueeSelection(event: ReactPointerEvent<HTMLDivElement>) {
    // 主流约定（对标 FVS/Figma）：空白画布普通拖拽即框选，无需先按 Shift 或切换工具；
    // 点在组件上时不拦截，交还组件自身的选择/拖动处理。
    const onNode = (event.target as HTMLElement).closest?.(".dashboard-node");
    if (event.button !== 0 || (!marqueeMode && onNode)) return;
    event.preventDefault();
    event.stopPropagation();
    const pointerId = event.pointerId;
    const bounds = artboardRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const additive = event.ctrlKey || event.metaKey || event.shiftKey;
    const pointAt = (clientX: number, clientY: number) => ({
      x: Math.max(0, Math.min(page.width, (clientX - bounds.left) / zoom)),
      y: Math.max(0, Math.min(page.height, (clientY - bounds.top) / zoom))
    });
    const start = pointAt(event.clientX, event.clientY);
    const rectangleAt = (clientX: number, clientY: number): SelectionRect => {
      const end = pointAt(clientX, clientY);
      return { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) };
    };
    const move = (pointer: PointerEvent) => {
      if (pointer.pointerId === pointerId) setSelectionRect(rectangleAt(pointer.clientX, pointer.clientY));
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
    };
    const finish = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      cleanup();
      const rectangle = rectangleAt(pointer.clientX, pointer.clientY);
      setSelectionRect(undefined);
      // 真实拖拽后的尾随 click 会命中 stage/画布的"点空白清空"处理器，吞掉它保住框选结果。
      if (rectangle.width >= 3 || rectangle.height >= 3) {
        const swallowClick = (clickEvent: Event) => {
          clickEvent.stopPropagation();
          clickEvent.preventDefault();
        };
        window.addEventListener("click", swallowClick, { capture: true, once: true });
        window.setTimeout(() => window.removeEventListener("click", swallowClick, { capture: true }), 0);
      }
      const hits = rectangle.width < 3 && rectangle.height < 3 ? [] : page.nodes
        .filter((node) => node.visible !== false && node.selectable !== false && node.locked !== true
          && node.frame.x < rectangle.x + rectangle.width
          && node.frame.y < rectangle.y + rectangle.height
          && node.frame.x + node.frame.width > rectangle.x
          && node.frame.y + node.frame.height > rectangle.y)
        .map((node) => node.id);
      const ids = additive ? [...new Set([...selectedNodeIds, ...hits])] : hits;
      setSelectedNodeIds(ids);
      onSelectionChange(ids.map((id) => ({ kind: "widget", id })));
      setMarqueeMode(false);
    };
    const cancel = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      cleanup();
      setSelectionRect(undefined);
    };
    setSelectionRect({ x: start.x, y: start.y, width: 0, height: 0 });
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
  }
  return {
    currentView, emitViewState, handleCanvasScroll, fitCanvasToViewport, changeZoom, zoomCanvas,
    beginCanvasPan, selectNode, updateSelectedFrame, beginNodeTransform, addGuide,
    beginGuideDrag, copySelectedNodes, pasteCopiedNodes, deleteSelectedNodes,
    deleteLayerNode, toggleLayerLock, nudgeSelectedNodes, layoutSelectedNodes,
    groupSelectedNodes, ungroupSelectedNodes, renameDashboardGroup, updateDashboardGroup,
    reorderSelectedNodes, reorderNodeIds, reorderLayerByDrop, contextNodeIds,
    openNodeContextMenu, copyContextNodes, updateContextNodes, deleteContextNodes,
    beginMarqueeSelection
  };
}
