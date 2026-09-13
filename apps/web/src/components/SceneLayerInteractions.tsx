import { createContext, useContext, type DragEvent, type ReactNode } from "react";
import { Group, Ungroup, LogOut } from "lucide-react";
import { translate as tr, type AppLocale } from "../i18n";
import "./SceneLayerInteractions.css";

const LayerMenu = createContext<ReactNode>(null);
export function SceneLayerMenuActions() { return useContext(LayerMenu); }
const mime = "application/x-scene-object-ids";

export interface SceneGroupingActions {
  onCreateGroup?: ((ids: string[]) => void) | undefined;
  onUngroup?: ((id: string) => void) | undefined;
  onMoveObjects?: ((ids: string[], groupId?: string, beforeId?: string) => void) | undefined;
}

export function SceneLayerInteractions(props: SceneGroupingActions & {
  locale: AppLocale; objectId?: string; groupId?: string; selectedIds?: ReadonlySet<string> | undefined;
  locked?: boolean; children: ReactNode;
}) {
  const ids = props.objectId ? props.selectedIds?.has(props.objectId) ? [...props.selectedIds] : [props.objectId] : [];
  const extras = <>
    {props.objectId && props.onCreateGroup && <button disabled={ids.length < 2 || props.locked} onClick={() => props.onCreateGroup?.(ids)}><Group size={13} />{tr(props.locale, "编组", "Group")}</button>}
    {props.groupId && props.onUngroup && <button onClick={() => props.onUngroup?.(props.groupId!)}><Ungroup size={13} />{tr(props.locale, "取消编组", "Ungroup")}</button>}
    {props.objectId && props.groupId && props.onMoveObjects && <button disabled={props.locked} onClick={() => props.onMoveObjects?.(ids)}><LogOut size={13} />{tr(props.locale, "移出编组", "Move out of group")}</button>}
  </>;
  return <LayerMenu.Provider value={extras}><div className="scene-layer-interaction" data-object-id={props.objectId} data-group-id={props.groupId}
    draggable={Boolean(props.objectId && !props.locked && props.onMoveObjects)}
    onDragStart={event => { event.stopPropagation(); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData(mime, JSON.stringify(ids)); }}
    onDragOver={event => { if (event.dataTransfer.types.includes(mime)) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move"; } }}
    onDrop={event => { event.stopPropagation(); dropSceneObjects(event, props.onMoveObjects, props.groupId, props.objectId); }}
    onContextMenu={event => {
      const row = event.currentTarget;
      const menu = row.querySelector<HTMLDetailsElement>("details.scene-row-menu");
      if (!menu) return;
      event.preventDefault(); event.stopPropagation();
      document.querySelectorAll<HTMLDetailsElement>("details.scene-row-menu[open]").forEach(item => { if (item !== menu) item.open = false; });
      menu.open = true;
      menu.querySelector<HTMLElement>("summary")?.focus();
    }}>
    {props.children}
  </div></LayerMenu.Provider>;
}

export function dropSceneObjects(event: DragEvent, onMove: SceneGroupingActions["onMoveObjects"], groupId?: string, beforeId?: string) {
  if (!event.dataTransfer.types.includes(mime)) return;
  event.preventDefault();
  try {
    const ids: unknown = JSON.parse(event.dataTransfer.getData(mime));
    if (Array.isArray(ids) && ids.every(id => typeof id === "string")) onMove?.(ids, groupId, beforeId);
  } catch { /* 仅接受本目录生成的对象拖拽数据。 */ }
}

export function SceneLayerRootDrop({ locale, onMoveObjects }: { locale: AppLocale; onMoveObjects: SceneGroupingActions["onMoveObjects"] }) {
  if (!onMoveObjects) return null;
  return <div className="scene-layer-root-drop" onDragOver={event => { if (event.dataTransfer.types.includes(mime)) event.preventDefault(); }} onDrop={event => dropSceneObjects(event, onMoveObjects)}>{tr(locale, "拖到此处移出编组", "Drop here to move out of groups")}</div>;
}
