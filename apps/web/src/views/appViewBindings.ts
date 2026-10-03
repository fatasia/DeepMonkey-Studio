import type { AppRoute } from "../appRoute";
import type { RendererBackend } from "../viewer/ViewerEngine";
import type { DashboardViewState } from "../studio/workspaceRoute";
import type { AppState } from "../hooks/useAppState";
import type { AppDerivedState } from "../hooks/useAppDerivedState";
import type { SceneEditorController } from "../controllers/sceneEditorController";
import type { ScenePersistenceController } from "../controllers/scenePersistenceController";
import type { ApplicationRuntimeController } from "../controllers/applicationRuntimeController";
import type { WorkspaceRecoveryDraft } from "../studio/workspaceRecoveryStore";
import type { ManagerDirectoryController } from "../hooks/useManagerDirectoryController";
import type { useApplicationRecovery } from "../hooks/useApplicationRecovery";
import type { useScenePublicationArtifacts } from "../hooks/useScenePublicationArtifacts";
import type { EditorPrimitiveDeleteAuthoring } from "../studio/editorPrimitiveDeleteAuthoring";
import type { SceneEditHistoryFlush } from "../hooks/useSceneHistoryState";

export interface AppViewActions {
  navigate: (route: AppRoute, replace?: boolean) => void;
  openDataCenter: () => void;
  closeDataCenter: () => void;
  openDocs: (documentId?: string, sectionId?: string) => void;
  replaceDashboardView: (view: DashboardViewState) => void;
  changeRendererBackend: (backend: RendererBackend) => void;
  switchProjectById: (projectId: string) => void;
  openProjectDialog: (mode: "create" | "rename") => void;
  submitProjectDialog: () => Promise<void>;
  deleteCurrentProject: () => Promise<void>;
  refreshProject: () => Promise<void>;
}

export interface AppViewBindings {
  publicationArtifacts: ReturnType<typeof useScenePublicationArtifacts>;
  applicationRecovery?: ReturnType<typeof useApplicationRecovery>;
  managerDirectory?: ManagerDirectoryController;
  state: AppState;
  derived: AppDerivedState;
  sceneEditor: SceneEditorController;
  scenePersistence: ScenePersistenceController;
  applicationRuntime: ApplicationRuntimeController;
  actions: AppViewActions;
  recovery: {
    draft: WorkspaceRecoveryDraft | undefined;
    busy: boolean;
    restore: () => Promise<void>;
    export: () => void;
    defer: () => void;
    discard: () => Promise<void>;
  };
  sceneHistory: {
    canUndo: boolean;
    canRedo: boolean;
    undoLabel?: string;
    redoLabel?: string;
    /** T27：flush 兼事务入口，beginTransaction 把多步异步序列合并为一个撤销单元。 */
    flush: SceneEditHistoryFlush;
    undo: () => Promise<void>;
    redo: () => Promise<void>;
  };
  /** 作者写入口(播放/行为/动画运行或忙碌时为 undefined);助手场景改动闭环与编辑器 presence 共用。 */
  sceneAuthoring?: EditorPrimitiveDeleteAuthoring | undefined;
  playMode?: {
    active: boolean;
    enter: () => void;
    exit: () => Promise<void>;
  };
}
