import { ChevronDown, ChevronRight, Eye, EyeOff, Folder, FolderOpen, Lock, Unlock, Pencil } from "lucide-react";
import type { SceneSelectionSetState, SceneRootLayerRef } from "@bim-studio/contracts";
import { useEffect, useState } from "react";
import { sortSceneRootLayers } from "./sceneRootLayerOrder";
import { translate as tr } from "../i18n";
import { FlatSpaceList } from "./FlatSpaceList";
import { WindowedSceneRows, type SceneRow } from "./WindowedSceneRows";
import { SceneRowMenu } from "./SceneRowMenu";
import type { SceneOrganizationObject } from "./SceneOrganizationPanel";
import { SceneLayerInteractions, SceneLayerRootDrop } from "./SceneLayerInteractions";
import { visibleLayerIds } from "./layerSelection";
import { handleLayerTreeKeyDown } from "./layerKeyboard";
import { LightRow, MeasurementRow, AnnotationRow } from "./SceneAuxiliaryRows";
import { PrimitiveRow } from "./ScenePrimitiveRow";
import type { FlatSceneObjectListProps } from "./sceneObjectListTypes";

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
  const defaultRows: SceneRow[] = [
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
  const rows = sortSceneRootLayers(defaultRows, props.rootLayerOrder, row => {
    const separator = row.key.indexOf(":"), kind = row.key.slice(0, separator), id = row.key.slice(separator + 1);
    return { kind: kind === "instance" || kind === "primitive" ? "object" : kind as SceneRootLayerRef["kind"], id };
  });
  const objectKey = props.selectedObjectId && rows.find(row => row.key === `instance:${props.selectedObjectId}` || row.key === `primitive:${props.selectedObjectId}`)?.key;
  const selectedKey = props.selectedAnnotationId ? `annotation:${props.selectedAnnotationId}` : objectKey
    ? props.selectedLayerId ? undefined : objectKey : props.selectedLightId ? `light:${props.selectedLightId}` : undefined;
  return (
    <div className="scene-object-directory" data-multiselect={(props.selectedObjectIds?.size ?? 0) > 1} onKeyDown={event => handleLayerTreeKeyDown(event, false, { rename: row => {
      const { objectId, layerId } = row.dataset;
      if (!objectId || !props.onObjectRename) return "unsupported";
      if (props.engine?.isLayerLocked(objectId, layerId ?? "root")) return "blocked";
      props.onObjectRename(objectId, layerId); return "handled";
    } })} data-layer-order={JSON.stringify(visibleLayerIds([...rowsByObjectId.keys()], groups, collapsedGroups, props.rootLayerOrder))}>
      <WindowedSceneRows rows={rows} selectedKey={selectedKey} />
      {groups.length > 0 && <SceneLayerRootDrop locale={props.locale} onMoveObjects={props.onMoveObjects} />}
    </div>
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
  return <section className="scene-layer-group" data-layer-keyboard-group="" role="treeitem" aria-expanded={props.open}>
    <SceneLayerInteractions {...props} groupId={group.id} locked={states.some(item => item.locked)}><div className="scene-layer-group-row">
      <button data-layer-expander="" className="scene-layer-group-select" onClick={props.onToggle} aria-label={props.open ? tr(locale, `收起编组“${group.name}”`, `Collapse group “${group.name}”`) : tr(locale, `展开编组“${group.name}”`, `Expand group “${group.name}”`)}>
        {props.open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        {props.open ? <FolderOpen size={14} /> : <Folder size={14} />}
      </button>
      <button data-layer-primary="" className="scene-layer-group-name" onClick={() => props.onSelectGroup(group.id)} title={tr(locale, "选择并统一控制组内对象", "Select and control all objects in this group")}>
        <strong>{group.name}</strong><small>{members.length}</small>
      </button>
      <button data-layer-action="rename" className="scene-layer-group-action" aria-label={tr(locale, "重命名编组", "Rename group")} title={tr(locale, "重命名编组", "Rename group")} onClick={rename}><Pencil size={12} /></button>
      <button className="scene-layer-group-action" aria-label={allHidden ? tr(locale, "显示编组", "Show group") : tr(locale, "隐藏编组", "Hide group")} title={allHidden ? tr(locale, "显示编组", "Show group") : tr(locale, "隐藏编组", "Hide group")} onClick={() => props.onGroupVisibilityChange(group.objectIds, allHidden)}>{allHidden ? <EyeOff size={13} /> : <Eye size={13} />}</button>
      <button className={`scene-layer-group-action ${allLocked ? "active" : ""}`} aria-label={allLocked ? tr(locale, "解锁编组", "Unlock group") : tr(locale, "锁定编组", "Lock group")} title={allLocked ? tr(locale, "解锁编组", "Unlock group") : tr(locale, "锁定编组", "Lock group")} onClick={() => props.onGroupLockChange(group.objectIds, !allLocked)}>{allLocked ? <Lock size={13} /> : <Unlock size={13} />}</button>
      <SceneRowMenu locale={locale}><button onClick={rename}><Pencil size={13} />{tr(locale, "重命名", "Rename")}</button></SceneRowMenu>
    </div></SceneLayerInteractions>
    {props.open && <div className="scene-layer-group-children" role="group">{members.map((row) => <div className="scene-layer-group-child" key={row.key}>{row.render()}</div>)}</div>}
  </section>;
}
