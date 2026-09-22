import type { GlobalLightingState, MeasurementState, SceneAnnotationState, SceneLightState, SceneSelectionSetState, SceneRootLayerRef } from "@bim-studio/contracts";
import type { AppLocale } from "../i18n";
import type { BimSpaceRecord, LoadedSceneModel, ViewerEngine } from "../viewer/ViewerEngine";
import type { SceneRow } from "./WindowedSceneRows";
import type { SceneOrganizationObject } from "./SceneOrganizationPanel";
import type { SceneGroupingActions } from "./SceneLayerInteractions";

export interface FlatSceneObjectListProps extends SceneGroupingActions {
  rootLayerOrder?: readonly SceneRootLayerRef[] | undefined;
  locale: AppLocale;
  studio: boolean;
  engine?: ViewerEngine | undefined;
  modelRows: SceneRow[];
  empty: boolean;
  lighting: GlobalLightingState;
  selectedLightId: string;
  selectedObjectId?: string | undefined;
  selectedObjectIds?: ReadonlySet<string> | undefined;
  selectedLayerId?: string | undefined;
  primitives: LoadedSceneModel[];
  measurements: MeasurementState[];
  annotations: SceneAnnotationState[];
  selectedAnnotationId?: string | undefined;
  spaces: BimSpaceRecord[];
  groups: SceneSelectionSetState[];
  organizationObjects: SceneOrganizationObject[];
  onRevision: () => void;
  onObjectSelect?: (id: string, options: { additive: boolean; range: boolean }) => void;
  onObjectRename?: ((id: string, layerId?: string) => void) | undefined;
  onLightSelect: (id: string) => void;
  onLightUpdate: (id: string, patch: Partial<SceneLightState>) => void;
  onLightTransform: (
    light: SceneLightState,
    handle: "position" | "target",
  ) => void;
  onLightRemove: (id: string) => void;
  onEnvironmentOpen: () => void;
  onPrimitiveRemove: (id: string) => void;
  onMeasurementRemove: (id: string) => void;
  onAnnotationUpdate: (
    id: string,
    patch: Partial<SceneAnnotationState>,
  ) => void;
  onAnnotationRemove: (id: string) => void;
  onSpaceFocus: (space: BimSpaceRecord) => void;
  onSpaceVisibilityChange: (space: BimSpaceRecord, visible: boolean) => void;
  onSelectGroup: (id: string) => void;
  onRenameGroup: (id: string, name: string) => void;
  onGroupVisibilityChange: (ids: string[], visible: boolean) => void;
  onGroupLockChange: (ids: string[], locked: boolean) => void;
}
