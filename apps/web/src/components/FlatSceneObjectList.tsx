import {
  Box,
  Check,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Folder,
  FolderOpen,
  Focus,
  Group,
  Lightbulb,
  Lock,
  LocateFixed,
  MapPin,
  Move,
  Ruler,
  ScanLine,
  Trash2,
  Unlock,
  Pencil,
} from "lucide-react";
import type {
  GlobalLightingState,
  MeasurementState,
  SceneAnnotationState,
  SceneLightState,
  SceneSelectionSetState,
} from "@bim-studio/contracts";
import { useEffect, useState } from "react";
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
import { WindowedSceneRows, type SceneRow } from "./WindowedSceneRows";
import { SceneRowMenu } from "./SceneRowMenu";
import { focusSceneObjectRow, selectSceneObjectRow } from "./sceneObjectRowEvents";
import type { SceneOrganizationObject } from "./SceneOrganizationPanel";
import { SceneLayerInteractions, SceneLayerRootDrop, type SceneGroupingActions } from "./SceneLayerInteractions";

interface FlatSceneObjectListProps extends SceneGroupingActions {
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

/** 主目录只呈现场景对象；不同对象类型保持同层，避免树结构吞噬操作空间。 */
export function FlatSceneObjectList(props: FlatSceneObjectListProps) {
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const primitiveRows: SceneRow[] = props.primitives.map(primitive => ({ key: `primitive:${primitive.id}`, render: () => <PrimitiveRow {...props} primitive={primitive} /> }));
  const objectRows: SceneRow[] = [...props.modelRows, ...primitiveRows].map(row => {
    const objectId = row.key.slice(row.key.indexOf(":") + 1);
    const groupId = props.groups.find(group => group.kind === "group" && group.objectIds.includes(objectId))?.id;
    return { ...row, render: () => <SceneLayerInteractions {...props} objectId={objectId} {...(groupId ? { groupId } : {})} selectedIds={props.selectedObjectIds} locked={props.organizationObjects.find(item => item.id === objectId)?.locked ?? false}>{row.render()}</SceneLayerInteractions> };
  });
  const rowsByObjectId = new Map(objectRows.map((row) => [row.key.slice(row.key.indexOf(":") + 1), row]));
  const groups = props.groups.filter((group) => group.kind === "group");
  const groupedIds = new Set(groups.flatMap((group) => group.objectIds));
  useEffect(() => {
    setCollapsedGroups((current) => new Set([...current].filter((id) => groups.some((group) => group.id === id))));
  }, [groups.map((group) => group.id).join("\u0000")]);
  const rows: SceneRow[] = [
    ...groups.map((group) => {
      const members = group.objectIds.map((id) => rowsByObjectId.get(id)).filter((row): row is SceneRow => Boolean(row));
      return {
        key: `group:${group.id}`,
        keepMounted: true,
        render: () => <SceneLayerGroup
          {...props}
          group={group}
          members={members}
          open={!collapsedGroups.has(group.id)}
          onToggle={() => setCollapsedGroups((current) => {
            const next = new Set(current);
            if (next.has(group.id)) next.delete(group.id); else next.add(group.id);
            return next;
          })}
        />,
      };
    }),
    ...objectRows.filter((row) => !groupedIds.has(row.key.slice(row.key.indexOf(":") + 1))),
    ...(props.studio ? props.lighting.lights ?? [] : []).map(light => ({ key: `light:${light.id}`, render: () => <LightRow {...props} light={light} /> })),
    ...props.measurements.map((measurement, index) => ({ key: `measurement:${measurement.id}`, render: () => <MeasurementRow locale={props.locale} measurement={measurement} index={index} onFocus={() => props.engine?.focusMeasurement(measurement)} onRemove={() => props.onMeasurementRemove(measurement.id)} /> })),
    ...props.annotations.map(annotation => ({ key: `annotation:${annotation.id}`, render: () => <AnnotationRow {...props} annotation={annotation} /> })),
    ...props.spaces.map(space => ({ key: `space:${space.id}`, render: () => <FlatSpaceList locale={props.locale} spaces={[space]} isVisible={item => props.engine?.isSpaceVisible(item) ?? false} onFocus={props.onSpaceFocus} onVisibilityChange={props.onSpaceVisibilityChange} /> })),
  ];
  const objectKey = props.selectedObjectId && rows.find(row => row.key === `instance:${props.selectedObjectId}` || row.key === `primitive:${props.selectedObjectId}`)?.key;
  const selectedKey = props.selectedAnnotationId ? `annotation:${props.selectedAnnotationId}` : objectKey
    ? props.selectedLayerId ? undefined : objectKey : props.selectedLightId ? `light:${props.selectedLightId}` : undefined;
  return (
    <>
      <WindowedSceneRows rows={rows} selectedKey={selectedKey} />
      {groups.length > 0 && <SceneLayerRootDrop locale={props.locale} onMoveObjects={props.onMoveObjects} />}
    </>
  );
}

function SceneLayerGroup(props: FlatSceneObjectListProps & { group: SceneSelectionSetState; members: SceneRow[]; open: boolean; onToggle: () => void }) {
  const { group, members, organizationObjects, locale } = props;
  const states = group.objectIds.map((id) => organizationObjects.find((item) => item.id === id)).filter((item): item is SceneOrganizationObject => Boolean(item));
  const allHidden = states.length > 0 && states.every((item) => !item.visible);
  const allLocked = states.length > 0 && states.every((item) => item.locked);
  const rename = () => {
    const name = window.prompt(tr(locale, "输入编组名称", "Enter group name"), group.name)?.trim();
    if (name && name !== group.name) props.onRenameGroup(group.id, name);
  };
  return <section className="scene-layer-group" role="treeitem" aria-expanded={props.open}>
    <SceneLayerInteractions {...props} groupId={group.id}><div className="scene-layer-group-row">
      <button className="scene-layer-group-select" onClick={props.onToggle} aria-label={props.open ? tr(locale, `收起编组“${group.name}”`, `Collapse group “${group.name}”`) : tr(locale, `展开编组“${group.name}”`, `Expand group “${group.name}”`)}>
        {props.open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        {props.open ? <FolderOpen size={14} /> : <Folder size={14} />}
      </button>
      <button className="scene-layer-group-name" onClick={() => props.onSelectGroup(group.id)} title={tr(locale, "选择并统一控制组内对象", "Select and control all objects in this group")}>
        <Group size={13} /><strong>{group.name}</strong><small>{members.length}</small>
      </button>
      <button className="scene-layer-group-action" aria-label={tr(locale, "重命名编组", "Rename group")} title={tr(locale, "重命名编组", "Rename group")} onClick={rename}><Pencil size={12} /></button>
      <button className="scene-layer-group-action" aria-label={allHidden ? tr(locale, "显示编组", "Show group") : tr(locale, "隐藏编组", "Hide group")} title={allHidden ? tr(locale, "显示编组", "Show group") : tr(locale, "隐藏编组", "Hide group")} onClick={() => props.onGroupVisibilityChange(group.objectIds, allHidden)}>{allHidden ? <EyeOff size={13} /> : <Eye size={13} />}</button>
      <button className={`scene-layer-group-action ${allLocked ? "active" : ""}`} aria-label={allLocked ? tr(locale, "解锁编组", "Unlock group") : tr(locale, "锁定编组", "Lock group")} title={allLocked ? tr(locale, "解锁编组", "Unlock group") : tr(locale, "锁定编组", "Lock group")} onClick={() => props.onGroupLockChange(group.objectIds, !allLocked)}>{allLocked ? <Lock size={13} /> : <Unlock size={13} />}</button>
      <SceneRowMenu locale={locale}><button onClick={rename}><Pencil size={13} />{tr(locale, "重命名", "Rename")}</button></SceneRowMenu>
    </div></SceneLayerInteractions>
    {props.open && <div className="scene-layer-group-children" role="group">{members.map((row) => <div className="scene-layer-group-child" key={row.key}>{row.render()}</div>)}</div>}
  </section>;
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
      <span className="scene-row-selection-mark" aria-hidden="true" />
      <span className="model-expander" />
      <button
        className="asset-main"
        title={props.selectedLightId === light.id ? tr(locale, "再次单击取消选择", "Click again to clear selection") : tr(locale, "选择光源", "Select light")}
        onClick={() => {
          const selected = props.selectedLightId === light.id;
          props.engine?.clearSceneLightSelection();
          props.onLightSelect(selected ? "" : light.id);
          if (!selected) props.onEnvironmentOpen();
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
      <SceneRowMenu locale={locale}>
      {canMove && (
        <button
          aria-label={tr(locale, "移动光源", "Move light")}
          title={tr(locale, "移动光源", "Move light")}
          onClick={() => props.onLightTransform(light, "position")}
        >
          <Move size={14} /><span>{tr(locale, "移动", "Move")}</span>
        </button>
      )}
      {canAim && (
        <button
          aria-label={tr(locale, "改变光照方向", "Change light direction")}
          title={tr(locale, "改变光照方向", "Change light direction")}
          onClick={() => props.onLightTransform(light, "target")}
        >
          <LocateFixed size={14} /><span>{tr(locale, "调整方向", "Aim")}</span>
        </button>
      )}
      <button
        className="danger"
        aria-label={tr(locale, "删除光源", "Delete light")}
        title={tr(locale, "删除光源", "Delete light")}
        onClick={() => props.onLightRemove(light.id)}
      >
        <Trash2 size={15} /><span>{tr(locale, "删除", "Delete")}</span>
      </button>
      </SceneRowMenu>
    </div>
  );
}

function PrimitiveRow(
  props: FlatSceneObjectListProps & { primitive: LoadedSceneModel },
) {
  const { primitive, engine, locale } = props;
  const locked = engine?.isModelLocked(primitive.id) ?? false;
  const selectedInBatch = props.selectedObjectIds?.has(primitive.id) ?? props.selectedObjectId === primitive.id;
  return (
    <div
      className={`asset-row scene-object-row ${props.selectedObjectId === primitive.id ? "selected" : ""} ${selectedInBatch ? "batch-selected" : ""}`}
    >
      <span className="scene-row-selection-mark" aria-hidden="true">{selectedInBatch ? <Check size={12} strokeWidth={3} /> : null}</span>
      <span className="model-expander" />
      <button
        className="asset-main"
        title={tr(locale, "单击选择，再次单击取消；Ctrl/⌘ 单击多选；Shift 单击连续选择；双击聚焦", "Click to select, click again to clear; Ctrl/⌘-click for multi-select; Shift-click for a range; double-click to focus")}
        onClick={(event) => selectSceneObjectRow(event, primitive.id, engine, props.onObjectSelect)}
        onDoubleClick={() => focusSceneObjectRow(primitive.id, engine)}
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
      <SceneRowMenu locale={locale}>
      <button
        aria-label={tr(locale, "隔离当前基础元素", "Isolate current primitive")}
        title={tr(locale, "仅显示当前基础元素", "Show only this primitive")}
        onClick={() => {
          engine?.isolateModels([primitive.id]);
          props.onRevision();
        }}
      >
        <Focus size={15} /><span>{tr(locale, "隔离", "Isolate")}</span>
      </button>
      <button
        className={`collision-toggle ${engine?.isCollisionEnabled(primitive.id) ? "active" : ""} ${engine?.isColliding(primitive.id) ? "colliding" : ""}`}
        aria-label={engine?.isCollisionEnabled(primitive.id) ? tr(locale, "关闭碰撞检测", "Disable collision detection") : tr(locale, "开启碰撞检测", "Enable collision detection")}
        title={
          engine?.isCollisionEnabled(primitive.id)
            ? tr(locale, "关闭碰撞检测", "Disable collision detection")
            : tr(locale, "开启碰撞检测", "Enable collision detection")
        }
        onClick={() => {
          engine?.setCollisionEnabled(
            primitive.id,
            !engine.isCollisionEnabled(primitive.id),
          );
          props.onRevision();
        }}
      >
        <ScanLine size={15} /><span>{engine?.isCollisionEnabled(primitive.id) ? tr(locale, "关闭碰撞", "Disable collision") : tr(locale, "开启碰撞", "Enable collision")}</span>
      </button>
      <button
        className="danger"
        disabled={locked}
        aria-label={locked ? tr(locale, "请先解锁基础元素", "Unlock the primitive first") : tr(locale, "删除基础元素", "Delete primitive")}
        title={
          locked
            ? tr(locale, "请先解锁基础元素", "Unlock the primitive first")
            : tr(locale, "删除基础元素", "Delete primitive")
        }
        onClick={() => props.onPrimitiveRemove(primitive.id)}
      >
        <Trash2 size={15} /><span>{tr(locale, "删除", "Delete")}</span>
      </button>
      </SceneRowMenu>
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
      <SceneRowMenu locale={locale}>
      <button
        className="danger"
        aria-label={`${tr(locale, "删除标尺", "Delete measurement")} ${index + 1}`}
        title={`${tr(locale, "删除标尺", "Delete measurement")} ${index + 1}`}
        onClick={onRemove}
      >
        <Trash2 size={15} /><span>{tr(locale, "删除", "Delete")}</span>
      </button>
      </SceneRowMenu>
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
      <SceneRowMenu locale={locale}>
        <button
          className="danger"
          disabled={annotation.locked}
          aria-label={annotation.locked ? tr(locale, "请先解锁标签", "Unlock the annotation first") : tr(locale, "删除标签", "Delete annotation")}
          title={
            annotation.locked
              ? tr(locale, "请先解锁标签", "Unlock the annotation first")
              : tr(locale, "删除标签", "Delete annotation")
          }
          onClick={() => props.onAnnotationRemove(annotation.id)}
        >
          <Trash2 size={15} /><span>{tr(locale, "删除", "Delete")}</span>
        </button>
      </SceneRowMenu>
    </div>
  );
}
