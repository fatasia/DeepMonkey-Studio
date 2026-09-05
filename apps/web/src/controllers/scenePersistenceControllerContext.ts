import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from "react";
import type {
  ApplicationDocument,
  CameraConstraintsState,
  CameraViewState,
  ClippingState,
  GlobalLightingState,
  MeasurementState,
  NavigationSettingsState,
  ProjectRecord,
  SceneAnimationState,
  SceneAssetBindingState,
  SceneAnnotationState,
  SceneCoordinateSystemState,
  SceneDashboardState,
  SceneDataBindingState,
  SceneEnvironmentState,
  SceneInteractionScriptState,
  ScenePhysicsState,
  ScenePostProcessingState,
  SceneSelectionSetState,
  SceneSnapshot,
  WeatherMode
} from "@bim-studio/contracts";
import type { StudioCommand } from "@bim-studio/studio-core";
import type { AppRoute } from "../appRoute";
import type { AppLocale } from "../i18n";
import type { ApplicationSession } from "../studio/applicationSession";
import type { BimSpaceRecord, LoadedSceneModel, NavigationMode, ViewerEngine } from "../viewer/ViewerEngine";
import type { SceneDataBindingRuntimeState } from "../components/SceneDataBindingEditor";
import type { RendererRecoveryState } from "../viewer/rendererRecoveryState";

type Setter<T> = Dispatch<SetStateAction<T>>;

type ViewerLoadState = import("../viewer/viewerLoadProgress").ViewerLoadProgress;

/** 场景持久化控制器的依赖契约；显式列出状态写入点，便于测试与替换。 */
export interface ScenePersistenceControllerContext {
  engine: ViewerEngine | undefined;
  project: ProjectRecord | undefined;
  activeScene: SceneSnapshot | undefined;
  activeApplication: ApplicationDocument | undefined;
  route: AppRoute;
  locale: AppLocale;
  sceneName: string;
  revision: number;
  selected: LoadedSceneModel | undefined;
  selectedLayerId: string | undefined;
  selectedAnnotationId: string | undefined;
  measurements: MeasurementState[];
  cameraViews: CameraViewState[];
  defaultCameraViewId: string | undefined;
  sceneCoordinates: SceneCoordinateSystemState;
  sceneDashboard: SceneDashboardState;
  sceneDataBindings: SceneDataBindingState[];
  sceneAssetBindings: SceneAssetBindingState[];
  sceneInteractions: SceneInteractionScriptState[];
  selectionSets: SceneSelectionSetState[];
  configuredDefaultEnvironment: SceneEnvironmentState;
  studioPublishMode: NonNullable<SceneSnapshot["publicationMode"]>;
  studioPublishPerformance: NonNullable<SceneSnapshot["publicationPerformance"]>;
  scenes: SceneSnapshot[];
  applicationSessionRef: MutableRefObject<ApplicationSession>;
  rendererSnapshotRef: MutableRefObject<RendererRecoveryState | undefined>;
  webGpuSceneReplacementCountRef: MutableRefObject<number>;
  sceneNameCommitRef: MutableRefObject<Promise<boolean> | undefined>;
  sceneApplyVersionRef: MutableRefObject<number>;
  lastAutoSavedSceneRevisionRef: MutableRefObject<number>;
  primitiveColors: MutableRefObject<Map<string, string>>;
  importRef: RefObject<HTMLInputElement | null>;
  navigate: (route: AppRoute, replace?: boolean) => void;
  loadModel: (model: ProjectRecord["models"][number], silent?: boolean) => Promise<LoadedSceneModel | undefined>;
  saveActiveApplication: (automatic?: boolean) => Promise<ApplicationDocument | undefined>;
  enablePublishedCloudScene: (sceneId: string) => Promise<{ viewerUrl?: string }>;
  dispatchApplicationCommand: (command: StudioCommand) => void;
  waitForModelReady: (projectId: string, modelId: string) => Promise<ProjectRecord>;
  isModelLoadSuperseded: (reason: unknown) => boolean;
  sortScenesByTime: (items: SceneSnapshot[]) => SceneSnapshot[];
  showError: (reason: unknown) => void;
  recordSceneEdit: (label: string) => void;
  setActiveScene: Setter<SceneSnapshot | undefined>;
  getActiveScene: () => SceneSnapshot | undefined;
  setAutoSaveEnabled: Setter<boolean>;
  setAnimationPlaying: Setter<boolean>;
  setAnimationTime: Setter<number>;
  setAnnotations: Setter<SceneAnnotationState[]>;
  setAvatarVisible: Setter<boolean>;
  setBusy: Setter<boolean>;
  setCameraConstraints: Setter<CameraConstraintsState>;
  setCameraViews: Setter<CameraViewState[]>;
  setClippingState: Setter<ClippingState>;
  setDefaultCameraViewId: Setter<string | undefined>;
  setLastDeletedSelectionSet: Setter<SceneSelectionSetState | undefined>;
  setLighting: Setter<GlobalLightingState>;
  setMeasurements: Setter<MeasurementState[]>;
  setMessage: Setter<string>;
  setNavigationMode: Setter<NavigationMode>;
  setNavigationSettings: Setter<NavigationSettingsState>;
  setPhysics: Setter<ScenePhysicsState>;
  setPostProcessing: Setter<ScenePostProcessingState>;
  setProject: Setter<ProjectRecord | undefined>;
  setProjects: Setter<ProjectRecord[]>;
  setRevision: Setter<number>;
  setRendererGeneration: Setter<number>;
  setRendererSwitching: Setter<boolean>;
  setSceneAnimation: Setter<SceneAnimationState>;
  setSceneCoordinates: Setter<SceneCoordinateSystemState>;
  setSceneDashboard: Setter<SceneDashboardState>;
  setSceneDataBindingRuntime: Setter<Record<string, SceneDataBindingRuntimeState>>;
  setSceneDataBindings: Setter<SceneDataBindingState[]>;
  setSceneAssetBindings: Setter<SceneAssetBindingState[]>;
  setSceneEnvironment: Setter<SceneEnvironmentState>;
  setSceneInteractions: Setter<SceneInteractionScriptState[]>;
  setSceneName: Setter<string>;
  setSceneOrganizationSelection: Setter<Set<string>>;
  setScenes: Setter<SceneSnapshot[]>;
  setSelected: Setter<LoadedSceneModel | undefined>;
  setSelectedAnnotationId: Setter<string | undefined>;
  setSelectedSpace: Setter<BimSpaceRecord | undefined>;
  setSelectionSets: Setter<SceneSelectionSetState[]>;
  setStudioPublishOpen: Setter<boolean>;
  setViewerLoadState: Setter<ViewerLoadState | undefined>;
  setWeather: Setter<WeatherMode>;
}
