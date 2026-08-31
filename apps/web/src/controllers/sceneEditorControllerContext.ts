import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from "react";
import type {
  CameraConstraintsState,
  CameraViewState,
  ClippingState,
  ExplosionMode,
  GlobalLightingState,
  MeasurementState,
  ModelTransform,
  NavigationSettingsState,
  ProjectRecord,
  RvtConversionMode,
  SceneAnimationState,
  SceneAnnotationState,
  SceneCoordinateSystemState,
  SceneDataBindingState,
  SceneEnvironmentState,
  SceneFloorState,
  SceneInteractionScriptState,
  SceneModelEffectsState,
  ScenePhysicsBodyState,
  ScenePhysicsState,
  ScenePostProcessingState,
  SceneSelectionSetState,
  WeatherMode,
} from "@bim-studio/contracts";
import type { AppLocale } from "../i18n";
import type { SceneOrganizationObject } from "../components/SceneOrganizationPanel";
import type { LoadedSceneModel, MeasureMode, NavigationMode, TransformMode, ViewerEngine } from "../viewer/ViewerEngine";

type Setter<T> = Dispatch<SetStateAction<T>>;
type TextureKind = "baseColor" | "normal" | "emissive" | "ambientOcclusion" | "roughness" | "metalness";

/** 三维作者控制器的显式依赖契约，便于测试替换状态与查看器端口。 */
export interface SceneEditorControllerContext {
  engine: ViewerEngine | undefined;
  project: ProjectRecord | undefined;
  locale: AppLocale;
  selected: LoadedSceneModel | undefined;
  selectedLayerId: string | undefined;
  selectedEffects: SceneModelEffectsState | undefined;
  selectedPhysics: ScenePhysicsBodyState | undefined;
  sceneCoordinates: SceneCoordinateSystemState;
  sceneEnvironment: SceneEnvironmentState;
  lighting: GlobalLightingState;
  clipping: ClippingState;
  explosionMode: ExplosionMode;
  floorStatesByModel: Map<string, SceneFloorState[]>;
  sceneOrganizationObjects: SceneOrganizationObject[];
  sceneOrganizationSelection: Set<string>;
  selectionSets: SceneSelectionSetState[];
  lastDeletedSelectionSet: SceneSelectionSetState | undefined;
  annotations: SceneAnnotationState[];
  annotationEnabled: boolean;
  measureEnabled: boolean;
  measureMode: MeasureMode;
  navigationSettings: NavigationSettingsState;
  cameraViews: CameraViewState[];
  cameraConstraints: CameraConstraintsState;
  sceneAnimation: SceneAnimationState;
  animationTime: number;
  animationPlaying: boolean;
  rvtConversionMode: RvtConversionMode;
  rvtRevitVersion: string;
  uploadRef: RefObject<HTMLInputElement | null>;
  environmentMapRef: RefObject<HTMLInputElement | null>;
  materialTextureRef: RefObject<HTMLInputElement | null>;
  materialTextureKindRef: MutableRefObject<TextureKind>;
  primitiveColors: MutableRefObject<Map<string, string>>;
  refreshProject: () => Promise<void>;
  showError: (reason: unknown) => void;
  setUploading: Setter<boolean>;
  setBusy: Setter<boolean>;
  setMessage: Setter<string>;
  setRevision: Setter<number>;
  setSelected: Setter<LoadedSceneModel | undefined>;
  setMeasurements: Setter<MeasurementState[]>;
  setAnnotations: Setter<SceneAnnotationState[]>;
  setAnnotationEnabled: Setter<boolean>;
  setSelectedAnnotationId: Setter<string | undefined>;
  setSceneInteractions: Setter<SceneInteractionScriptState[]>;
  setSceneDataBindings: Setter<SceneDataBindingState[]>;
  setNavigationMode: Setter<NavigationMode>;
  setTransformMode: Setter<TransformMode>;
  setMeasureEnabled: Setter<boolean>;
  setMeasureMode: Setter<MeasureMode>;
  setClippingState: Setter<ClippingState>;
  setWeather: Setter<WeatherMode>;
  setLighting: Setter<GlobalLightingState>;
  setSceneEnvironment: Setter<SceneEnvironmentState>;
  setPostProcessing: Setter<ScenePostProcessingState>;
  setPhysics: Setter<ScenePhysicsState>;
  setEnvironmentOpen: Setter<boolean>;
  setSelectedLightId: Setter<string>;
  setCameraViews: Setter<CameraViewState[]>;
  setCameraConstraints: Setter<CameraConstraintsState>;
  setDefaultCameraViewId: Setter<string | undefined>;
  setNavigationSettings: Setter<NavigationSettingsState>;
  setFloorExpansionByModel: Setter<Record<string, number>>;
  setExpandedModels: Setter<Set<string>>;
  setSceneOrganizationSelection: Setter<Set<string>>;
  setSelectionSets: Setter<SceneSelectionSetState[]>;
  setLastDeletedSelectionSet: Setter<SceneSelectionSetState | undefined>;
  setXrPanelOpen: Setter<boolean>;
  setSceneAnimation: Setter<SceneAnimationState>;
  recordSceneEdit: (label: string) => void;
}
