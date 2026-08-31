import type { Dispatch, PointerEvent as ReactPointerEvent, SetStateAction } from "react";
import type { DashboardPageDocument, WidgetFrame, WidgetNode } from "@bim-studio/contracts";
import { createUpdateDashboardNodeFramesCommand, type StudioCommand } from "@bim-studio/studio-core";
import {
  SNAP_THRESHOLD_PX,
  snapDashboardFrame,
  type ActiveSnapLines,
} from "./dashboardWorkspaceModel";

interface DashboardNodeTransformOptions {
  event: ReactPointerEvent<HTMLButtonElement>;
  node: WidgetNode;
  mode: "move" | "resize";
  page: DashboardPageDocument;
  selectedNodeIds: string[];
  guidesVisible: boolean;
  snapEnabled: boolean;
  zoom: number;
  setDraftFrames: Dispatch<SetStateAction<Record<string, WidgetFrame>>>;
  setActiveSnapLines: Dispatch<SetStateAction<ActiveSnapLines>>;
  onCommand: (command: StudioCommand) => void;
}

/** 负责一次完整的移动/缩放指针事务，取消时不产生历史命令。 */
export function beginDashboardNodeTransform(options: DashboardNodeTransformOptions) {
  const { event, node, mode, page, selectedNodeIds, guidesVisible, snapEnabled, zoom } = options;
  if (event.button !== 0 || node.locked) return;
  event.preventDefault();
  event.stopPropagation();
  const nodeIds =
    mode === "move" && selectedNodeIds.includes(node.id)
      ? page.nodes
          .filter((candidate) => selectedNodeIds.includes(candidate.id) && candidate.locked !== true)
          .map((candidate) => candidate.id)
      : [node.id];
  const initial = new Map(
    page.nodes
      .filter((candidate) => nodeIds.includes(candidate.id))
      .map((candidate) => [candidate.id, structuredClone(candidate.frame)]),
  );
  const startX = event.clientX;
  const startY = event.clientY;
  const pointerId = event.pointerId;
  const otherNodes = page.nodes.filter((candidate) => !nodeIds.includes(candidate.id) && candidate.visible !== false);
  const xCandidates = [
    0,
    page.width / 2,
    page.width,
    ...(guidesVisible
      ? (page.guides ?? []).filter((guide) => guide.orientation === "vertical").map((guide) => guide.position)
      : []),
    ...otherNodes.flatMap((candidate) => [
      candidate.frame.x,
      candidate.frame.x + candidate.frame.width / 2,
      candidate.frame.x + candidate.frame.width,
    ]),
  ];
  const yCandidates = [
    0,
    page.height / 2,
    page.height,
    ...(guidesVisible
      ? (page.guides ?? []).filter((guide) => guide.orientation === "horizontal").map((guide) => guide.position)
      : []),
    ...otherNodes.flatMap((candidate) => [
      candidate.frame.y,
      candidate.frame.y + candidate.frame.height / 2,
      candidate.frame.y + candidate.frame.height,
    ]),
  ];
  const framesAt = (clientX: number, clientY: number) =>
    calculateFrames({
      clientX,
      clientY,
      startX,
      startY,
      zoom,
      mode,
      page,
      node,
      initial,
      snapEnabled,
      xCandidates,
      yCandidates,
    });
  const move = (pointer: PointerEvent) => {
    if (pointer.pointerId !== pointerId) return;
    const next = framesAt(pointer.clientX, pointer.clientY);
    options.setDraftFrames(next.frames);
    options.setActiveSnapLines(next.lines);
  };
  const cleanup = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", finish);
    window.removeEventListener("pointercancel", cancel);
  };
  const finish = (pointer: PointerEvent) => {
    if (pointer.pointerId !== pointerId) return;
    cleanup();
    const finalFrames = framesAt(pointer.clientX, pointer.clientY).frames;
    resetDraft(options);
    const changes = Object.entries(finalFrames)
      .filter(([nodeId, frame]) => JSON.stringify(frame) !== JSON.stringify(initial.get(nodeId)))
      .map(([nodeId, frame]) => ({ nodeId, frame }));
    if (changes.length) options.onCommand(createUpdateDashboardNodeFramesCommand(page.id, changes));
  };
  const cancel = (pointer: PointerEvent) => {
    if (pointer.pointerId !== pointerId) return;
    cleanup();
    resetDraft(options);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", finish);
  window.addEventListener("pointercancel", cancel);
}

function calculateFrames(options: {
  clientX: number;
  clientY: number;
  startX: number;
  startY: number;
  zoom: number;
  mode: "move" | "resize";
  page: DashboardPageDocument;
  node: WidgetNode;
  initial: Map<string, WidgetFrame>;
  snapEnabled: boolean;
  xCandidates: number[];
  yCandidates: number[];
}): { frames: Record<string, WidgetFrame>; lines: ActiveSnapLines } {
  let dx = Math.round((options.clientX - options.startX) / options.zoom);
  let dy = Math.round((options.clientY - options.startY) / options.zoom);
  let lines: ActiveSnapLines = { x: [], y: [] };
  if (options.snapEnabled) {
    const anchor = options.initial.get(options.node.id)!;
    if (options.mode === "move") {
      dx = Math.round((anchor.x + dx) / 8) * 8 - anchor.x;
      dy = Math.round((anchor.y + dy) / 8) * 8 - anchor.y;
    } else {
      dx = Math.round((anchor.width + dx) / 8) * 8 - anchor.width;
      dy = Math.round((anchor.height + dy) / 8) * 8 - anchor.height;
    }
    const proposed =
      options.mode === "move"
        ? { ...anchor, x: anchor.x + dx, y: anchor.y + dy }
        : { ...anchor, width: anchor.width + dx, height: anchor.height + dy };
    const snapped = snapDashboardFrame(
      proposed,
      options.mode,
      options.xCandidates,
      options.yCandidates,
      SNAP_THRESHOLD_PX / options.zoom,
    );
    lines = snapped.lines;
    if (options.mode === "move") {
      dx += snapped.frame.x - proposed.x;
      dy += snapped.frame.y - proposed.y;
    } else {
      dx += snapped.frame.width - proposed.width;
      dy += snapped.frame.height - proposed.height;
    }
  }
  const frames = Object.fromEntries(
    [...options.initial].map(([nodeId, frame]) => {
      if (options.mode === "resize") {
        return [
          nodeId,
          {
            ...frame,
            width: Math.max(40, Math.min(options.page.width - frame.x, frame.width + dx)),
            height: Math.max(40, Math.min(options.page.height - frame.y, frame.height + dy)),
          },
        ];
      }
      return [
        nodeId,
        {
          ...frame,
          x: Math.max(0, Math.min(options.page.width - frame.width, frame.x + dx)),
          y: Math.max(0, Math.min(options.page.height - frame.height, frame.y + dy)),
        },
      ];
    }),
  );
  return { frames, lines };
}

function resetDraft(options: Pick<DashboardNodeTransformOptions, "setDraftFrames" | "setActiveSnapLines">) {
  options.setDraftFrames({});
  options.setActiveSnapLines({ x: [], y: [] });
}
