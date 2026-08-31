import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from "react";
import type {
  ApplicationObjectRef,
  DashboardGuide,
  DashboardPageDocument,
  WidgetFrame,
  WidgetNode,
} from "@bim-studio/contracts";
import type { StudioCommand } from "@bim-studio/studio-core";
import type { AppLocale } from "../i18n";
import type { DashboardViewState } from "../studio/workspaceRoute";
import type {
  ActiveSnapLines,
  DashboardContextMenuState,
  SelectionRect,
} from "./dashboardWorkspaceModel";

export interface DashboardCanvasControllerContext {
  locale: AppLocale;
  page: DashboardPageDocument;
  zoom: number;
  setZoom: Dispatch<SetStateAction<number>>;
  selectedNode: WidgetNode | undefined;
  selectedNodeIds: string[];
  setSelectedNodeIds: Dispatch<SetStateAction<string[]>>;
  normalizedInitialView: DashboardViewState;
  scrollRef: RefObject<HTMLDivElement | null>;
  artboardRef: RefObject<HTMLDivElement | null>;
  artboardOffsetX: number;
  artboardOffsetY: number;
  spacePressedRef: MutableRefObject<boolean>;
  setViewportScroll: Dispatch<SetStateAction<{ left: number; top: number }>>;
  setPanning: Dispatch<SetStateAction<boolean>>;
  busy: boolean;
  onViewStateChange: (view: DashboardViewState) => void;
  onSelectionChange: (selection: readonly ApplicationObjectRef[]) => void;
  onNodeInteraction: (nodeId: string) => unknown;
  onCommand: (command: StudioCommand) => void;
  guidesVisible: boolean;
  snapEnabled: boolean;
  setDraftFrames: Dispatch<SetStateAction<Record<string, WidgetFrame>>>;
  setActiveSnapLines: Dispatch<SetStateAction<ActiveSnapLines>>;
  draftGuides: DashboardGuide[] | undefined;
  setDraftGuides: Dispatch<SetStateAction<DashboardGuide[] | undefined>>;
  clipboardRef: MutableRefObject<WidgetNode[]>;
  contextMenu: DashboardContextMenuState | undefined;
  setContextMenu: Dispatch<SetStateAction<DashboardContextMenuState | undefined>>;
  marqueeMode: boolean;
  setMarqueeMode: Dispatch<SetStateAction<boolean>>;
  setSelectionRect: Dispatch<SetStateAction<SelectionRect | undefined>>;
  dashboardGroups: Array<{ id: string; nodes: WidgetNode[]; label: string }>;
}
