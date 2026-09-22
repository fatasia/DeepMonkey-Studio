import { createContext, useContext, type ReactNode } from "react";
import { Group, Ungroup, LogOut } from "lucide-react";
import { translate as tr, type AppLocale } from "../i18n";
import "./SceneLayerInteractions.css";
import { useSceneLayerDrag } from "./useSceneLayerDrag";
import type { SceneRootLayerRef } from "@bim-studio/contracts";

const LayerMenu = createContext<ReactNode>(null);
export function SceneLayerMenuActions() { return useContext(LayerMenu); }

export interface SceneGroupingActions {
  onCreateGroup?: ((ids: string[]) => void) | undefined;
  onUngroup?: ((id: string) => void) | undefined;
  onMoveObjects?: ((ids: string[], groupId?: string, targetId?: string, position?: "before" | "after") => void) | undefined;
  onMoveRootEntries?: ((refs: SceneRootLayerRef[], target?: SceneRootLayerRef, position?: "before" | "after") => void) | undefined;
}

export function SceneLayerInteractions(props: SceneGroupingActions & {
  locale: AppLocale; objectId?: string; groupId?: string; selectedIds?: ReadonlySet<string> | undefined;
  locked?: boolean; children: ReactNode;
  organizationObjects?: readonly { id: string; locked: boolean }[];
  groups?: readonly { id: string; objectIds: string[] }[];
}) {
  const drag = useSceneLayerDrag({ ...props, deniedText: tr(props.locale, "无法放置：对象已锁定、目标失效或不支持该排序位置", "Cannot drop: locked objects, invalid target, or unsupported ordering position") });
  const ids = props.objectId ? props.selectedIds?.has(props.objectId) ? [...props.selectedIds] : [props.objectId] : [];
  const extras = <>
    {props.objectId && props.onCreateGroup && <button disabled={ids.length < 2 || props.locked} onClick={() => props.onCreateGroup?.(ids)}><Group size={13} />{tr(props.locale, "编组", "Group")}</button>}
    {props.groupId && props.onUngroup && <button onClick={() => props.onUngroup?.(props.groupId!)}><Ungroup size={13} />{tr(props.locale, "取消编组", "Ungroup")}</button>}
    {props.objectId && props.groupId && props.onMoveObjects && <button disabled={props.locked} onClick={() => props.onMoveObjects?.(ids)}><LogOut size={13} />{tr(props.locale, "移出编组", "Move out of group")}</button>}
  </>;
  return <LayerMenu.Provider value={extras}><div {...drag} className="scene-layer-interaction" data-layer-keyboard-row="" data-object-id={props.objectId} data-group-id={props.groupId}
    draggable={Boolean(!props.locked && (props.objectId ? props.onMoveObjects : props.groupId && props.onMoveRootEntries))}
    onContextMenu={event => {
      const row = event.currentTarget;
      const menu = row.querySelector<HTMLDetailsElement>("details.scene-row-menu");
      if (!menu) return;
      event.preventDefault(); event.stopPropagation();
      // 右键新对象先同步目录与检查器；已有多选内右键保留整组选中。
      if (props.objectId && !props.selectedIds?.has(props.objectId)) {
        row.querySelector<HTMLButtonElement>("button.asset-main")?.click();
      }
      document.querySelectorAll<HTMLDetailsElement>("details.scene-row-menu[open]").forEach(item => { if (item !== menu) item.open = false; });
      menu.open = true;
      menu.querySelector<HTMLElement>("summary")?.focus();
    }}>
    {props.children}
  </div></LayerMenu.Provider>;
}

export function SceneLayerRootDrop({ locale, onMoveObjects }: { locale: AppLocale; onMoveObjects: SceneGroupingActions["onMoveObjects"] }) {
  const drag = useSceneLayerDrag({ root: true, onMoveObjects, deniedText: tr(locale, "无法移出编组", "Cannot move out of group") });
  if (!onMoveObjects) return null;
  return <div {...drag} className="scene-layer-root-drop">{tr(locale, "拖到此处移出编组", "Drop here to move out of groups")}</div>;
}
