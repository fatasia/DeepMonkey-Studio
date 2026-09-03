import type { ReactNode } from "react";
import {
  Box,
  Eye,
  EyeOff,
  Lightbulb,
  Lock,
  LocateFixed,
  MapPin,
  Move,
  Ruler,
  ScanLine,
  Trash2,
  Unlock,
  Upload,
  Plus,
} from "lucide-react";
import type {
  GlobalLightingState,
  MeasurementState,
  SceneAnnotationState,
  SceneLightState,
} from "@bim-studio/contracts";
import {
  formatMeasurementValue,
  lightTypeEnglishName,
  lightTypeName,
  measureModeName,
} from "../appPresentation";
import { translate as tr, type AppLocale } from "../i18n";
import type {
  BimSpaceRecord,
  LoadedSceneModel,
  ViewerEngine,
} from "../viewer/ViewerEngine";
import { FlatSpaceList } from "./FlatSpaceList";
import { EditorEmptyState } from "./EditorEmptyState";

interface FlatSceneObjectListProps {
  locale: AppLocale;
  studio: boolean;
  engine?: ViewerEngine | undefined;
  modelRows: ReactNode;
  empty: boolean;
  lighting: GlobalLightingState;
  selectedLightId: string;
  selectedObjectId?: string | undefined;
  primitives: LoadedSceneModel[];
  measurements: MeasurementState[];
  annotations: SceneAnnotationState[];
  selectedAnnotationId?: string | undefined;
  spaces: BimSpaceRecord[];
  onRevision: () => void;
  onEmptyImport: () => void;
  onEmptyCreateBox: () => void;
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
}

/** 主目录只呈现场景对象；不同对象类型保持同层，避免树结构吞噬操作空间。 */
export function FlatSceneObjectList(props: FlatSceneObjectListProps) {
  return (
    <>
      {props.modelRows}
      {props.empty && (
        <EditorEmptyState
          icon={<Box size={20} />}
          title={tr(props.locale, "还没有场景对象", "No scene objects yet")}
          description={tr(props.locale, "导入已有模型，或用基础方盒快速搭建可交互设备。", "Import an existing model or block out an interactive device with a box.")}
          primaryAction={{ label: tr(props.locale, "导入模型", "Import model"), icon: <Upload size={13} />, onClick: props.onEmptyImport }}
          secondaryAction={{ label: tr(props.locale, "创建方盒", "Create box"), icon: <Plus size={13} />, onClick: props.onEmptyCreateBox }}
          hint={tr(props.locale, "模型、灯光、标签与测量保持同层管理", "Models, lights, labels, and measurements stay in one flat list")}
          variant="panel"
        />
      )}
      {props.studio &&
        (props.lighting.lights?.length ?? 0) > 0 &&
        (props.lighting.lights ?? []).map((light) => (
          <LightRow key={light.id} {...props} light={light} />
        ))}
      {props.primitives.map((primitive) => (
        <PrimitiveRow key={primitive.id} {...props} primitive={primitive} />
      ))}
      {props.measurements.map((measurement, index) => (
        <MeasurementRow
          key={measurement.id}
          locale={props.locale}
          measurement={measurement}
          index={index}
          onFocus={() => props.engine?.focusMeasurement(measurement)}
          onRemove={() => props.onMeasurementRemove(measurement.id)}
        />
      ))}
      {props.annotations.map((annotation) => (
        <AnnotationRow key={annotation.id} {...props} annotation={annotation} />
      ))}
      <FlatSpaceList
        locale={props.locale}
        spaces={props.spaces}
        isVisible={(space) => props.engine?.isSpaceVisible(space) ?? false}
        onFocus={props.onSpaceFocus}
        onVisibilityChange={props.onSpaceVisibilityChange}
      />
    </>
  );
}

function LightRow(
  props: FlatSceneObjectListProps & { light: SceneLightState },
) {
  const { light, locale } = props;
  const canMove = !["ambient", "hemisphere"].includes(light.type);
  const canAim = ["directional", "spot", "rectArea"].includes(light.type);
  return (
    <div
      className={`asset-row scene-object-row ${props.selectedLightId === light.id ? "selected" : ""}`}
    >
      <span className="model-expander" />
      <button
        className="asset-main"
        onClick={() => {
          props.onLightSelect(light.id);
          props.onEnvironmentOpen();
        }}
      >
        <span
          className="scene-object-badge light-layer-badge"
          style={{ color: light.color }}
        >
          <Lightbulb size={15} />
        </span>
        <span className="asset-copy">
          <strong>{light.name}</strong>
          <small>
            {tr(
              locale,
              lightTypeName(light.type),
              lightTypeEnglishName(light.type),
            )}
          </small>
        </span>
      </button>
      <button
        className="mini-button"
        aria-label={light.enabled ? tr(locale, "关闭光源", "Disable light") : tr(locale, "开启光源", "Enable light")}
        title={
          light.enabled
            ? tr(locale, "关闭光源", "Disable light")
            : tr(locale, "开启光源", "Enable light")
        }
        onClick={() =>
          props.onLightUpdate(light.id, { enabled: !light.enabled })
        }
      >
        {light.enabled ? <Eye size={15} /> : <EyeOff size={15} />}
      </button>
      {canMove && (
        <button
          className="mini-button"
          aria-label={tr(locale, "移动光源", "Move light")}
          title={tr(locale, "移动光源", "Move light")}
          onClick={() => props.onLightTransform(light, "position")}
        >
          <Move size={14} />
        </button>
      )}
      {canAim && (
        <button
          className="mini-button"
          aria-label={tr(locale, "改变光照方向", "Change light direction")}
          title={tr(locale, "改变光照方向", "Change light direction")}
          onClick={() => props.onLightTransform(light, "target")}
        >
          <LocateFixed size={14} />
        </button>
      )}
      <button
        className="mini-button scene-row-optional-action danger"
        aria-label={tr(locale, "删除光源", "Delete light")}
        title={tr(locale, "删除光源", "Delete light")}
        onClick={() => props.onLightRemove(light.id)}
      >
        <Trash2 size={15} />
      </button>
    </div>
  );
}

function PrimitiveRow(
  props: FlatSceneObjectListProps & { primitive: LoadedSceneModel },
) {
  const { primitive, engine, locale } = props;
  const locked = engine?.isModelLocked(primitive.id) ?? false;
  return (
    <div
      className={`asset-row scene-object-row ${props.selectedObjectId === primitive.id ? "selected" : ""}`}
    >
      <span className="model-expander" />
      <button
        className="asset-main"
        title={tr(locale, "单击选择，双击聚焦", "Click to select, double-click to focus")}
        onClick={() => engine?.select(primitive.id)}
        onDoubleClick={() => engine?.focusModel(primitive.id)}
      >
        <span className="scene-object-badge">
          <Box size={15} />
        </span>
        <span className="asset-copy">
          <strong>{primitive.name}</strong>
          <small>
            {tr(locale, "基础元素 · 可编辑", "Primitive · Editable")}
          </small>
        </span>
      </button>
      <button
        className="mini-button"
        aria-label={primitive.visible ? tr(locale, "隐藏基础元素", "Hide primitive") : tr(locale, "显示基础元素", "Show primitive")}
        title={
          primitive.visible
            ? tr(locale, "隐藏基础元素", "Hide primitive")
            : tr(locale, "显示基础元素", "Show primitive")
        }
        onClick={() => engine?.setVisible(primitive.id, !primitive.visible)}
      >
        {primitive.visible ? <Eye size={15} /> : <EyeOff size={15} />}
      </button>
      <button
        className={`mini-button ${locked ? "active" : ""}`}
        aria-label={locked ? tr(locale, "解锁基础元素", "Unlock primitive") : tr(locale, "锁定基础元素", "Lock primitive")}
        title={
          locked
            ? tr(locale, "解锁基础元素", "Unlock primitive")
            : tr(locale, "锁定基础元素", "Lock primitive")
        }
        onClick={() => {
          engine?.setModelLocked(primitive.id, !locked);
          props.onRevision();
        }}
      >
        {locked ? <Lock size={14} /> : <Unlock size={14} />}
      </button>
      <button
        className={`mini-button scene-row-optional-action collision-toggle ${engine?.isCollisionEnabled(primitive.id) ? "active" : ""} ${engine?.isColliding(primitive.id) ? "colliding" : ""}`}
        aria-label={engine?.isCollisionEnabled(primitive.id) ? tr(locale, "关闭碰撞检测", "Disable collision detection") : tr(locale, "开启碰撞检测", "Enable collision detection")}
        title={
          engine?.isCollisionEnabled(primitive.id)
            ? tr(locale, "关闭碰撞检测", "Disable collision detection")
            : tr(locale, "开启碰撞检测", "Enable collision detection")
        }
        onClick={() =>
          engine?.setCollisionEnabled(
            primitive.id,
            !engine.isCollisionEnabled(primitive.id),
          )
        }
      >
        <ScanLine size={15} />
      </button>
      <button
        className="mini-button scene-row-optional-action danger"
        disabled={locked}
        aria-label={locked ? tr(locale, "请先解锁基础元素", "Unlock the primitive first") : tr(locale, "删除基础元素", "Delete primitive")}
        title={
          locked
            ? tr(locale, "请先解锁基础元素", "Unlock the primitive first")
            : tr(locale, "删除基础元素", "Delete primitive")
        }
        onClick={() => props.onPrimitiveRemove(primitive.id)}
      >
        <Trash2 size={15} />
      </button>
    </div>
  );
}

function MeasurementRow({
  locale,
  measurement,
  index,
  onFocus,
  onRemove,
}: {
  locale: AppLocale;
  measurement: MeasurementState;
  index: number;
  onFocus: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="asset-row scene-object-row">
      <span className="model-expander" />
      <button className="asset-main" onClick={onFocus}>
        <span className="scene-object-badge">
          <Ruler size={15} />
        </span>
        <span className="asset-copy">
          <strong>
            {tr(locale, "测量", "Measurement")} {index + 1}
          </strong>
          <small>
            {measureModeName(measurement.kind ?? "distance", locale)} ·{" "}
            {formatMeasurementValue(measurement)}
          </small>
        </span>
      </button>
      <button
        className="mini-button scene-row-optional-action danger"
        aria-label={`${tr(locale, "删除标尺", "Delete measurement")} ${index + 1}`}
        title={`${tr(locale, "删除标尺", "Delete measurement")} ${index + 1}`}
        onClick={onRemove}
      >
        <Trash2 size={15} />
      </button>
    </div>
  );
}

function AnnotationRow(
  props: FlatSceneObjectListProps & { annotation: SceneAnnotationState },
) {
  const { annotation, locale } = props;
  return (
    <div
      className={`asset-row scene-object-row ${props.selectedAnnotationId === annotation.id ? "selected" : ""}`}
    >
      <span className="model-expander" />
      <button
        className="asset-main"
        onClick={() => props.engine?.focusAnnotation(annotation.id)}
      >
        <span
          className="scene-object-badge annotation-badge"
          style={{ color: annotation.color }}
        >
          <MapPin size={15} />
        </span>
        <span className="asset-copy">
          <strong>{annotation.name}</strong>
          <small>
            {annotation.anchorName ||
              tr(locale, "场景标签", "Scene annotation")}
          </small>
        </span>
      </button>
      <button
        className="mini-button"
        aria-label={annotation.visible ? tr(locale, "隐藏标签", "Hide annotation") : tr(locale, "显示标签", "Show annotation")}
        title={
          annotation.visible
            ? tr(locale, "隐藏标签", "Hide annotation")
            : tr(locale, "显示标签", "Show annotation")
        }
        onClick={() =>
          props.onAnnotationUpdate(annotation.id, {
            visible: !annotation.visible,
          })
        }
      >
        {annotation.visible ? <Eye size={15} /> : <EyeOff size={15} />}
      </button>
      <button
        className={`mini-button ${annotation.locked ? "active" : ""}`}
        aria-label={annotation.locked ? tr(locale, "解锁标签", "Unlock annotation") : tr(locale, "锁定标签", "Lock annotation")}
        title={
          annotation.locked
            ? tr(locale, "解锁标签", "Unlock annotation")
            : tr(locale, "锁定标签", "Lock annotation")
        }
        onClick={() =>
          props.onAnnotationUpdate(annotation.id, {
            locked: !annotation.locked,
          })
        }
      >
        {annotation.locked ? <Lock size={14} /> : <Unlock size={14} />}
      </button>
      <button
        className="mini-button scene-row-optional-action danger"
        disabled={annotation.locked}
        aria-label={annotation.locked ? tr(locale, "请先解锁标签", "Unlock the annotation first") : tr(locale, "删除标签", "Delete annotation")}
        title={
          annotation.locked
            ? tr(locale, "请先解锁标签", "Unlock the annotation first")
            : tr(locale, "删除标签", "Delete annotation")
        }
        onClick={() => props.onAnnotationRemove(annotation.id)}
      >
        <Trash2 size={15} />
      </button>
    </div>
  );
}
