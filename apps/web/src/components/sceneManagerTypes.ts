import type {
  ApplicationDocument,
  ModelRecord,
  ProjectRecord,
  SceneSnapshot,
  SystemBrandingSettings,
  TopologyDocument,
} from "@bim-studio/contracts";
import type { AppLocale } from "../i18n";
import type { ManagerWorkspaceTab } from "../appRoute";
import type { ManagerDirectoryController } from "../hooks/useManagerDirectoryController";

/** 场景管理器的外部业务契约，页面内部状态不应泄漏到此接口。 */
export interface SceneManagerProps {
  directory?: ManagerDirectoryController | undefined;
  locale: AppLocale;
  managerTab?: ManagerWorkspaceTab;
  assetScope?: "project" | undefined;
  selectedAssetModelId?: string | undefined;
  onReturnToScene?: ((modelId?: string) => void) | undefined;
  onManagerTabChange?: (tab: ManagerWorkspaceTab) => void;
  branding: SystemBrandingSettings;
  projects: ProjectRecord[];
  project: ProjectRecord | undefined;
  scenes: SceneSnapshot[];
  applications: ApplicationDocument[];
  topologies: Array<{ applicationId: string; applicationName: string; topology: TopologyDocument }>;
  userName: string;
  isAdmin: boolean;
  navigationNotice?: string;
  onDismissNavigationNotice?: () => void;
  onProjectChange: (projectId: string) => void;
  onCreateProject: () => void;
  onRenameProject: () => void;
  onDeleteProject: () => void;
  onCreate: (name: string) => Promise<void>;
  onCreateShowcase: () => Promise<void>;
  showcaseExists: boolean;
  onOpen: (scene: SceneSnapshot) => Promise<void>;
  /** 从交付主线进入带上下文的脚本或仿真工作区。 */
  onOpenBehavior?: (scene: SceneSnapshot) => Promise<void>;
  onOpenSimulation?: (scene: SceneSnapshot) => Promise<void>;
  onCopy: (scene: SceneSnapshot) => Promise<void>;
  onRename: (scene: SceneSnapshot, name: string) => Promise<void>;
  onPublish: (
    scene: SceneSnapshot,
    mode: NonNullable<SceneSnapshot["publicationMode"]>,
    performance: NonNullable<SceneSnapshot["publicationPerformance"]>,
    toolbarVisible: boolean,
  ) => Promise<boolean>;
  onUnpublish: (scene: SceneSnapshot) => Promise<void>;
  onRestorePublication: (sceneId: string, publishedAt: string) => Promise<void>;
  onBrowse: (scene: SceneSnapshot) => void;
  onBrowsePublished: (scene: SceneSnapshot) => void;
  onImport: () => void;
  onExportLoose: (scene: SceneSnapshot) => void;
  onExportSingle: (scene: SceneSnapshot) => Promise<void>;
  onExportGlb: (scene: SceneSnapshot) => Promise<void>;
  onExportFbx: (scene: SceneSnapshot) => Promise<void>;
  onDelete: (scene: SceneSnapshot) => Promise<void>;
  onOptimizer: (modelId?: string) => void;
  onDataCenter: () => void;
  onCreateTopology: () => void;
  onOpenTopology: (applicationId: string, topologyId: string) => void;
  onVisionCenter: () => void;
  onOperationsCenter: () => void;
  onAiAssistant: () => void;
  onDocs: () => void;
  onSystem: () => void;
  onCloudRender: () => void;
  onLocaleToggle: () => void;
  onConnectionStatus: () => void;
  onCredits: () => void;
  onLogout: () => void;
  onUploadModels: (files: FileList) => Promise<void>;
  onDeleteModel: (model: ModelRecord) => Promise<void>;
  onRefreshModels: () => Promise<void>;
}
