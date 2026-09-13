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
    flush: (label?: string) => void;
    undo: () => Promise<void>;
    redo: () => Promise<void>;
  };
}
