import type {
  ApplicationDocument,
  ApplicationObjectRef,
  DashboardPageDocument,
  JsonValue,
  ProjectRecord,
  SceneInteractionTarget,
  SceneInteractionTrigger
} from "@bim-studio/contracts";
import type { ApplicationInteractionResult, StudioCommand } from "@bim-studio/studio-core";
import type { AppLocale } from "../i18n";
import type { DashboardViewState } from "../studio/workspaceRoute";
import type { RendererBackend } from "../viewer/ViewerEngine";

/** 二维编辑器的宿主合同；页面实现只通过命令和稳定回调修改应用状态。 */
export interface DashboardWorkspaceProps {
  locale: AppLocale;
  /** 仅作者宿主显式授权填报；未传身份的预览/嵌入不提供业务写入口。 */
  writebackAccess?: { userId: string; canWrite: boolean };
  application: ApplicationDocument;
  project: ProjectRecord;
  page: DashboardPageDocument;
  rendererBackend: RendererBackend;
  initialView?: DashboardViewState;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  busy: boolean;
  autoSaveEnabled?: boolean;
  liveDataEnabled?: boolean;
  selection: readonly ApplicationObjectRef[];
  variables: Readonly<Record<string, JsonValue>>;
  filters: Readonly<Record<string, JsonValue>>;
  onBack: () => void;
  onSelectPage: (pageId: string, view: DashboardViewState) => void;
  onEnterScene: (sceneId: string, view: DashboardViewState) => void;
  /** 从二维页面直接回到当前页面关联的三维场景。 */
  onOpen3D?: (sceneId: string, view: DashboardViewState) => void;
  onOpenTopology: (topologyId: string | undefined, nodeId: string, view: DashboardViewState) => void;
  onOpenData: () => void;
  onAiAssistant?: () => void;
  onOpenScripts?: (selection: readonly ApplicationObjectRef[]) => void;
  scriptOpen?: boolean;
  onCloseScripts?: () => void;
  onSelectionChange: (selection: readonly ApplicationObjectRef[]) => void;
  onFilterChange: (key: string, value: JsonValue | undefined) => void;
  onVariableChange: (key: string, value: JsonValue) => void;
  onObjectInteraction: (sceneId: string, trigger: SceneInteractionTrigger, target: SceneInteractionTarget) => void;
  onNodeInteraction: (nodeId: string, trigger?: SceneInteractionTrigger, payload?: JsonValue) => ApplicationInteractionResult | undefined;
  onCommand: (command: StudioCommand) => void;
  onUndo: () => void;
  onRedo: () => void;
  onSave: () => void;
  onAutoSaveChange?: (enabled: boolean) => void;
  onPublish: () => void;
  onViewStateChange: (view: DashboardViewState) => void;
}
