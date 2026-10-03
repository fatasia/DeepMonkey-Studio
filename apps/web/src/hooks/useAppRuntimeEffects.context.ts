import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from "react";
import type {
  ApplicationDocument,
  ApplicationObjectRef,
  CameraState,
  CameraViewState,
  ClippingState,
  GlobalLightingState,
  MeasurementState,
  ProjectRecord,
  SceneAnnotationState,
  JsonValue,
  SceneDataBindingState,
  SceneInteractionScriptState,
  SceneInteractionTrigger,
  SceneSnapshot,
  SystemUserRecord,
} from "@bim-studio/contracts";
import type { SceneDataBindingRuntimeState } from "../components/SceneDataBindingEditor";
import type { SceneDataBridgeStatus } from "../sceneDataBridge";
import type { AppRoute } from "../appRoute";
import type { AppLocale } from "../i18n";
import type { ApplicationSession } from "../studio/applicationSession";
import type { SceneBehaviorManager, SceneBehaviorManagerEntry } from "../behavior/SceneBehaviorManager";
import type { BimSpaceRecord, LoadedSceneModel, NavigationCollisionDiagnostics, PointerInfo, RendererBackend, ViewerEngine } from "../viewer/ViewerEngine";
import type { RendererRecoveryState } from "../viewer/rendererRecoveryState";
import type { PendingRendererPreference } from "../viewer/rendererBackendPreference";

export type Setter<T> = Dispatch<SetStateAction<T>>;

interface XrCapabilities {
  checking: boolean;
  secure: boolean;
  webxr: boolean;
  vr: boolean;
  ar: boolean;
}

/** 渲染器恢复上下文的每渲染快照:设备丢失瞬间据此捕获场景并恢复。 */
export interface RendererRecoveryContext {
  activeScene: SceneSnapshot | undefined;
  project: ProjectRecord | undefined;
  readOnly: boolean;
  fastRuntime: boolean;
  captureSceneSnapshot: () => SceneSnapshot | undefined;
}

export interface AppRuntimeEffectsContext {
  authReady: boolean;
  currentUser: SystemUserRecord | undefined;
  viewerRouteActive: boolean;
  viewportRef: RefObject<HTMLDivElement | null>;
  rendererBackend: RendererBackend;
  rendererActiveBackend: RendererBackend;
  rendererGeneration: number;
  revision: number;
  engine: ViewerEngine | undefined;
  route: AppRoute;
  locale: AppLocale;
  project: ProjectRecord | undefined;
  activeScene: SceneSnapshot | undefined;
  activeApplication: ApplicationDocument | undefined;
  applicationState: ReturnType<ApplicationSession["store"]["getState"]>;
  scenes: SceneSnapshot[];
  cameraViews: CameraViewState[];
  infoEnabled: boolean;
  xrPanelOpen: boolean;
  studioPublishOpen: boolean;
  sceneBehaviorActive: boolean;
  sceneBehaviorPaused: boolean;
  sceneDataBindings: SceneDataBindingState[];
  sceneInteractions: SceneInteractionScriptState[];
  activeSceneIdRef: MutableRefObject<string | undefined>;
  rendererSnapshotRef: MutableRefObject<RendererRecoveryState | undefined>;
  rendererPreferenceCommitRef: PendingRendererPreference;
  webGpuSceneReplacementCountRef: MutableRefObject<number>;
  visionEventCursorRef: MutableRefObject<{ scope: string; id: string }>;
  behaviorManagerRef: MutableRefObject<SceneBehaviorManager | undefined>;
  primitiveColors: MutableRefObject<Map<string, string>>;
  navigate: (route: AppRoute, replace?: boolean) => void;
  applyScene: (scene: SceneSnapshot, updateRoute?: boolean, sceneProject?: ProjectRecord, readOnly?: boolean, fastRuntime?: boolean,
    safeAuthoringEntry?: boolean, requireComplete?: boolean, incrementalPlay?: boolean, restoreAnimationPlayheadSec?: number | undefined,
    restoreLiveCamera?: boolean) => Promise<void>;
  dispatchApplicationInteraction: (source: ApplicationObjectRef, trigger: SceneInteractionTrigger, selectSource?: boolean, payload?: JsonValue) => unknown;
  recordSceneEdit: (label: string) => void;
  captureSceneSnapshot: () => SceneSnapshot | undefined;
  showError: (reason: unknown) => void;
  setEngine: Setter<ViewerEngine | undefined>;
  setRendererSwitching: Setter<boolean>;
  setRevision: Setter<number>;
  setSelected: Setter<LoadedSceneModel | undefined>;
  setSceneOrganizationSelection: Setter<Set<string>>;
  setSelectedSpace: Setter<BimSpaceRecord | undefined>;
  setSelectedLightId: Setter<string>;
  setMeasurements: Setter<MeasurementState[]>;
  setAnnotations: Setter<SceneAnnotationState[]>;
  setSelectedAnnotationId: Setter<string | undefined>;
  setLighting: Setter<GlobalLightingState>;
  setClippingState: Setter<ClippingState>;
  setCameraInfo: Setter<CameraState | undefined>;
  setPointerInfo: Setter<PointerInfo | undefined>;
  setNavigationDiagnostics: Setter<NavigationCollisionDiagnostics>;
  setFrameRate: Setter<number>;
  setAnimationTime: Setter<number>;
  setAnimationPlaying: Setter<boolean>;
  setXrActiveMode: Setter<"immersive-vr" | "immersive-ar" | undefined>;
  setXrCapabilities: Setter<XrCapabilities>;
  setStudioCloudConfigured: Setter<boolean | undefined>;
  setStudioCloudHint: Setter<string | undefined>;
  setSceneDataStatus: Setter<SceneDataBridgeStatus>;
  setSceneDataReceived: Setter<number>;
  setSceneDataBindingRuntime: Setter<Record<string, SceneDataBindingRuntimeState>>;
  setSceneBehaviorActive: Setter<boolean>;
  setSceneBehaviorPaused: Setter<boolean>;
  setSceneBehaviorEntries: Setter<SceneBehaviorManagerEntry[]>;
  setViewerToolsOpen: Setter<boolean>;
  setMessage: Setter<string>;
  setRoute: Setter<AppRoute>;
  setRendererBackend: Setter<RendererBackend>;
  setRendererActiveBackend: Setter<RendererBackend>;
  setRendererSwitchPhase: Setter<"idle" | "preparing" | "recovering" | "failed">;
  setRendererSwitchMessage: Setter<string | undefined>;
  /** 任一模型开启描边(outline)。Deep 具备对象级描边能力时放行;仅在能力缺失时才保留 WebGL(fail-closed)。 */
  rendererOutlineRequired: boolean;
}
