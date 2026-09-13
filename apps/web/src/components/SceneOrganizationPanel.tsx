import { useEffect, useMemo, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from "react";
import {
  Box,
  Check,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Focus,
  Folder,
  FolderOpen,
  Group,
  GripVertical,
  Layers3,
  Lock,
  RotateCcw,
  Save,
  Search,
  Trash2,
  Unlock,
  X,
} from "lucide-react";
import type { SceneSelectionSetState } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import { WindowedSceneRows } from "./WindowedSceneRows";
import { SceneSelectionBar } from "./SceneSelectionBar";

export interface SceneOrganizationObject {
  id: string;
  name: string;
  kind: "model" | "primitive";
  visible: boolean;
  locked: boolean;
}

interface Props {
  locale: AppLocale;
  objects: SceneOrganizationObject[];
  selectedIds: ReadonlySet<string>;
  selectionSets: SceneSelectionSetState[];
  lastDeletedSelectionSet: SceneSelectionSetState | undefined;
  isolationActive: boolean;
  onClose: () => void;
  onToggle: (id: string) => void;
  onSelect: (ids: string[]) => void;
  onShow: (ids: string[], visible: boolean) => void;
  onLock: (ids: string[], locked: boolean) => void;
  onIsolate: (ids: string[]) => void;
  onRestoreIsolation: () => void;
  onCreateSelectionSet: (name: string) => void;
  onCreateGroup: (name: string) => void;
  onMoveObjects: (ids: string[], groupId?: string, beforeObjectId?: string) => void;
  onReorderGroup: (id: string, beforeId?: string) => void;
  onRenameGroup: (id: string, name: string) => void;
  onUpdateSelectionSet: (id: string) => void;
  onApplySelectionSet: (id: string) => void;
  onDeleteSelectionSet: (id: string) => void;
  onRestoreDeletedSelectionSet: () => void;
  /** 统一对象管理器在主列表已有一条选择工具栏时关闭此处重复的工具栏。 */
  showSelectionBar?: boolean;
}

type ContextTarget = { type: "object" | "group"; id: string; groupId?: string; x: number; y: number };

/** 与场景目录共用一棵紧凑树：选择、编组、拖拽层级和右键操作都在原位置完成。 */
export function SceneOrganizationPanel(props: Props) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(props.selectionSets.filter((item) => item.kind === "group").map((item) => item.id)));
  const [draggingIds, setDraggingIds] = useState<string[]>([]);
  const [dropTarget, setDropTarget] = useState("");
  const [contextTarget, setContextTarget] = useState<ContextTarget>();
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const groups = props.selectionSets.filter((item) => item.kind === "group");
  const savedSets = props.selectionSets.filter((item) => item.kind !== "group");
  const objectsById = useMemo(() => new Map(props.objects.map((item) => [item.id, item])), [props.objects]);
  const groupedIds = new Set(groups.flatMap((group) => group.objectIds));
  const rootObjects = props.objects.filter((item) => !groupedIds.has(item.id));
  const selectedObjects = props.objects.filter((item) => props.selectedIds.has(item.id));

  useEffect(() => {
    if (!contextTarget) return;
    const close = () => setContextTarget(undefined);
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
    };
  }, [contextTarget]);

  function matches(item: SceneOrganizationObject): boolean {
    return !normalizedQuery || `${item.name} ${item.kind}`.toLocaleLowerCase("zh-CN").includes(normalizedQuery);
  }

  function toggleExpanded(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectObject(event: MouseEvent | KeyboardEvent<HTMLDivElement>, id: string) {
    event.stopPropagation();
    if (event.ctrlKey || event.metaKey) props.onToggle(id);
    else props.onSelect(props.selectedIds.size === 1 && props.selectedIds.has(id) ? [] : [id]);
  }

  function startObjectDrag(event: DragEvent, id: string) {
    const ids = props.selectedIds.has(id) && props.selectedIds.size > 1 ? [...props.selectedIds] : [id];
    if (!props.selectedIds.has(id)) props.onSelect([id]);
    setDraggingIds(ids);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-bim-studio-object", ids.join("\n"));
  }

  function startGroupDrag(event: DragEvent, id: string) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-bim-studio-group", id);
  }

  function draggedObjects(event: DragEvent): string[] {
    return (event.dataTransfer.getData("application/x-bim-studio-object") || draggingIds.join("\n")).split("\n").filter(Boolean);
  }

  function openContext(event: MouseEvent, target: Omit<ContextTarget, "x" | "y">) {
    event.preventDefault();
    event.stopPropagation();
    if (target.type === "object" && !props.selectedIds.has(target.id)) props.onSelect([target.id]);
    setContextTarget({ ...target, x: Math.min(event.clientX, window.innerWidth - 220), y: Math.min(event.clientY, window.innerHeight - 270) });
  }

  function objectRow(item: SceneOrganizationObject, groupId?: string) {
    const selected = props.selectedIds.has(item.id);
    return (
      <div
        key={item.id}
        className={`scene-tree-row object ${selected ? "selected" : ""} ${dropTarget === `object:${item.id}` ? "drop-target" : ""}`}
        role="treeitem"
        tabIndex={0}
        aria-selected={selected}
        aria-level={groupId ? 2 : 1}
        draggable
        onDragStart={(event) => startObjectDrag(event, item.id)}
        onDragEnd={() => { setDraggingIds([]); setDropTarget(""); }}
        onDragOver={(event) => { if (groupId) { event.preventDefault(); event.stopPropagation(); setDropTarget(`object:${item.id}`); } }}
        onDrop={(event) => {
          if (!groupId) return;
          event.preventDefault();
          event.stopPropagation();
          props.onMoveObjects(draggedObjects(event), groupId, item.id);
          setDropTarget("");
        }}
        onClick={(event) => selectObject(event, item.id)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          selectObject(event, item.id);
        }}
        onContextMenu={(event) => openContext(event, { type: "object", id: item.id, ...(groupId ? { groupId } : {}) })}
        title={tr(props.locale, "单击选择，Ctrl/⌘ 多选；可拖入或拖出编组", "Click to select, Ctrl/⌘ for multi-select; drag in or out of groups")}
      >
        <GripVertical className="scene-tree-grip" size={12} />
        <span className="scene-tree-type">{item.kind === "model" ? <Layers3 size={13} /> : <Box size={13} />}</span>
        <strong>{item.name}</strong>
        {!item.visible && <EyeOff size={12} />}
        {item.locked && <Lock size={12} />}
        {selected && <Check className="scene-tree-selected" size={12} />}
      </div>
    );
  }

  return (
    <section className="scene-organization-panel scene-tree-manager" aria-label={tr(props.locale, "场景图层与编组", "Scene layers and groups")}>
      <div className="scene-organization-search">
        <Search size={13} />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={tr(props.locale, "搜索场景元素", "Search scene elements")} aria-label={tr(props.locale, "搜索场景元素", "Search scene elements")} />
        {query && <button aria-label={tr(props.locale, "清空搜索", "Clear search")} onClick={() => setQuery("")}><X size={12} /></button>}
      </div>
      {props.showSelectionBar !== false && <SceneSelectionBar
          locale={props.locale}
          selectedObjects={selectedObjects}
          onGroup={() => props.onCreateGroup("")}
          onShow={(visible) => props.onShow(selectedObjects.map((item) => item.id), visible)}
          onLock={() => props.onLock(selectedObjects.map((item) => item.id), true)}
          onClear={() => props.onSelect([])}
        />}

      <div className="scene-tree" role="tree" aria-label={tr(props.locale, "场景元素树", "Scene element tree")}>
        {groups.map((group) => {
          const members = group.objectIds.map((id) => objectsById.get(id)).filter((item): item is SceneOrganizationObject => Boolean(item));
          const visibleMembers = members.filter(matches);
          if (normalizedQuery && !group.name.toLocaleLowerCase("zh-CN").includes(normalizedQuery) && !visibleMembers.length) return null;
          const open = expanded.has(group.id) || Boolean(normalizedQuery);
          return (
            <section
              className={`scene-tree-group ${dropTarget === `group:${group.id}` ? "drop-target" : ""}`}
              key={group.id}
              role="treeitem"
              aria-expanded={open}
              aria-level={1}
              draggable
              onDragStart={(event) => startGroupDrag(event, group.id)}
              onDragEnd={() => setDropTarget("")}
              onDragOver={(event) => { event.preventDefault(); setDropTarget(`group:${group.id}`); }}
              onDrop={(event) => {
                event.preventDefault();
                const sourceGroup = event.dataTransfer.getData("application/x-bim-studio-group");
                if (sourceGroup) props.onReorderGroup(sourceGroup, group.id);
                else props.onMoveObjects(draggedObjects(event), group.id);
                setDropTarget("");
              }}
            >
              <div className="scene-tree-row group" onContextMenu={(event) => openContext(event, { type: "group", id: group.id })}>
                <GripVertical className="scene-tree-grip" size={12} />
                <button className="scene-tree-expander" aria-label={open ? tr(props.locale, `收起编组“${group.name}”`, `Collapse group “${group.name}”`) : tr(props.locale, `展开编组“${group.name}”`, `Expand group “${group.name}”`)} onClick={() => toggleExpanded(group.id)}>{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button>
                <span className="scene-tree-type">{open ? <FolderOpen size={13} /> : <Folder size={13} />}</span>
                <button className="scene-tree-name" onClick={() => props.onApplySelectionSet(group.id)}><strong>{group.name}</strong><small>{members.length}</small></button>
              </div>
              {open && <div className="scene-tree-children" role="group"><WindowedSceneRows rows={visibleMembers.map(item => ({ key: item.id, render: () => objectRow(item, group.id) }))} selectedKey={visibleMembers.find(item => props.selectedIds.has(item.id))?.id} /></div>}
            </section>
          );
        })}

        <div
          className={`scene-tree-root-drop ${dropTarget === "root" ? "drop-target" : ""}`}
          onDragOver={(event) => { event.preventDefault(); setDropTarget("root"); }}
          onDrop={(event) => { event.preventDefault(); props.onMoveObjects(draggedObjects(event)); setDropTarget(""); }}
        >
          <WindowedSceneRows rows={rootObjects.filter(matches).map(item => ({ key: item.id, render: () => objectRow(item) }))} selectedKey={rootObjects.find(item => props.selectedIds.has(item.id))?.id} />
          {props.objects.length > 0 && normalizedQuery && !groups.some((group) => group.objectIds.some((id) => objectsById.get(id) && matches(objectsById.get(id)!))) && !rootObjects.some(matches) && <div className="scene-tree-empty"><Search size={17} /><span>{tr(props.locale, "没有匹配元素", "No matching elements")}</span></div>}
        </div>
      </div>

      <div className="scene-tree-footer">
        <button disabled={!selectedObjects.length} onClick={() => props.onIsolate(selectedObjects.map((item) => item.id))}><Focus size={12} />{tr(props.locale, "隔离", "Isolate")}</button>
        <button disabled={!props.isolationActive} onClick={props.onRestoreIsolation}><RotateCcw size={12} />{tr(props.locale, "恢复", "Restore")}</button>
        <details className="scene-saved-selections">
          <summary><Save size={12} />{tr(props.locale, "保存的选择", "Saved selections")}<small>{savedSets.length}</small></summary>
          <div>
            <button disabled={!selectedObjects.length} onClick={() => props.onCreateSelectionSet("")}><Save size={12} />{tr(props.locale, "保存当前选择", "Save current selection")}</button>
            {savedSets.map((set) => <span key={set.id}><button onClick={() => props.onApplySelectionSet(set.id)}>{set.name}</button><button aria-label={tr(props.locale, `用当前选择更新“${set.name}”`, `Update “${set.name}” with current selection`)} title={tr(props.locale, "更新", "Update")} disabled={!selectedObjects.length} onClick={() => props.onUpdateSelectionSet(set.id)}><Save size={11} /></button><button aria-label={tr(props.locale, `删除保存的选择“${set.name}”`, `Delete saved selection “${set.name}”`)} title={tr(props.locale, "删除", "Delete")} onClick={() => props.onDeleteSelectionSet(set.id)}><Trash2 size={11} /></button></span>)}
            {props.lastDeletedSelectionSet && <button onClick={props.onRestoreDeletedSelectionSet}>{tr(props.locale, "撤销删除", "Undo delete")} · {props.lastDeletedSelectionSet.name}</button>}
          </div>
        </details>
      </div>

      {contextTarget && (
        <div className="scene-tree-context-menu" role="menu" style={{ left: contextTarget.x, top: contextTarget.y }} onPointerDown={(event) => event.stopPropagation()}>
          {contextTarget.type === "object" ? <ObjectContextMenu {...props} target={contextTarget} objectsById={objectsById} close={() => setContextTarget(undefined)} /> : <GroupContextMenu {...props} group={groups.find((item) => item.id === contextTarget.id)!} objectsById={objectsById} close={() => setContextTarget(undefined)} />}
        </div>
      )}
    </section>
  );
}

function ObjectContextMenu(props: Props & { target: ContextTarget; objectsById: Map<string, SceneOrganizationObject>; close: () => void }) {
  const clicked = props.objectsById.get(props.target.id);
  const ids = props.selectedIds.has(props.target.id) ? [...props.selectedIds] : [props.target.id];
  const run = (action: () => void) => { action(); props.close(); };
  return <>
    <strong>{ids.length > 1 ? tr(props.locale, `${ids.length} 个已选元素`, `${ids.length} selected elements`) : clicked?.name}</strong>
    {ids.length > 1 && <button onClick={() => run(() => props.onCreateGroup(""))}><Group size={13} />{tr(props.locale, "编组所选元素", "Group selection")}</button>}
    {props.target.groupId && <button onClick={() => run(() => props.onMoveObjects(ids))}><Layers3 size={13} />{tr(props.locale, "移出编组", "Move out of group")}</button>}
    <button onClick={() => run(() => props.onShow(ids, true))}><Eye size={13} />{tr(props.locale, "显示", "Show")}</button>
    <button onClick={() => run(() => props.onShow(ids, false))}><EyeOff size={13} />{tr(props.locale, "隐藏", "Hide")}</button>
    <button onClick={() => run(() => props.onLock(ids, true))}><Lock size={13} />{tr(props.locale, "锁定", "Lock")}</button>
    <button onClick={() => run(() => props.onLock(ids, false))}><Unlock size={13} />{tr(props.locale, "解锁", "Unlock")}</button>
    <button onClick={() => run(() => props.onIsolate(ids))}><Focus size={13} />{tr(props.locale, "隔离", "Isolate")}</button>
  </>;
}

function GroupContextMenu(props: Props & { group: SceneSelectionSetState; objectsById: Map<string, SceneOrganizationObject>; close: () => void }) {
  const group = props.group;
  if (!group) return null;
  const members = group.objectIds.map((id) => props.objectsById.get(id)).filter((item): item is SceneOrganizationObject => Boolean(item));
  const run = (action: () => void) => { action(); props.close(); };
  return <>
    <strong>{group.name}</strong>
    <button onClick={() => run(() => props.onApplySelectionSet(group.id))}><Check size={13} />{tr(props.locale, "选择组内元素", "Select group elements")}</button>
    <button onClick={() => run(() => { const name = window.prompt(tr(props.locale, "重命名编组", "Rename group"), group.name); if (name) props.onRenameGroup(group.id, name); })}><Group size={13} />{tr(props.locale, "重命名", "Rename")}</button>
    <button onClick={() => run(() => props.onShow(group.objectIds, !members.some((item) => item.visible)))}>{members.some((item) => item.visible) ? <EyeOff size={13} /> : <Eye size={13} />}{members.some((item) => item.visible) ? tr(props.locale, "隐藏编组", "Hide group") : tr(props.locale, "显示编组", "Show group")}</button>
    <button onClick={() => run(() => props.onLock(group.objectIds, !members.every((item) => item.locked)))}>{members.every((item) => item.locked) ? <Unlock size={13} /> : <Lock size={13} />}{members.every((item) => item.locked) ? tr(props.locale, "解锁编组", "Unlock group") : tr(props.locale, "锁定编组", "Lock group")}</button>
    <button onClick={() => run(() => { props.onMoveObjects(group.objectIds); props.onDeleteSelectionSet(group.id); })}><Layers3 size={13} />{tr(props.locale, "解组并保留元素", "Ungroup and keep elements")}</button>
    <button className="danger" onClick={() => run(() => props.onDeleteSelectionSet(group.id))}><Trash2 size={13} />{tr(props.locale, "删除编组", "Delete group")}</button>
  </>;
}
