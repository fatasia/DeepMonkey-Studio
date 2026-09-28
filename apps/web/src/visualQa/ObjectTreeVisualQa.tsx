import { Profiler, useEffect, useMemo, useRef, useState } from "react";
import type { GlobalLightingState, ModelRecord, SceneSelectionSetState } from "@bim-studio/contracts";
import type { LayerTreeNode, LoadedSceneModel, ViewerEngine } from "../viewer/ViewerEngine";
import { FlatSceneObjectList } from "../components/FlatSceneObjectList";
import { LayerTree } from "../components/LayerTree";
import { ModelTreeItem } from "../components/ModelTreeItem";
import { OptimizerLayerTree } from "../components/OptimizerLayerTree";
import type { OptimizerLayer, OptimizerLayerEdit } from "../optimizer/optimizerLayers";
import { SceneOrganizationPanel } from "../components/SceneOrganizationPanel";
import { SceneTreeWindowingContext } from "../components/sceneTreePreference";
import { COMPLEX_TEXT_MATRIX, complexTextFixtureName } from "./complexTextMatrix";
import "./objectTreeVisualQa.css";

const noop = () => {};
type Mode = "objects" | "models" | "layers" | "groups";
interface Item { id: string; name: string; visible: boolean; locked: boolean; kind: "primitive" }
export default function ObjectTreeVisualQa() {
  const search = new URLSearchParams(window.location.search);
  const textMatrix = search.get("text") === "1";
  const inputMatrix = search.get("input") === "1";
  const [count, setCount] = useState(search.get("count") === "100000" ? 100000 : search.get("count") === "10000" ? 10000 : 1000);
  const [mode, setMode] = useState<Mode>((["objects", "models", "layers", "groups"].includes(search.get("mode") ?? "") ? search.get("mode") : "objects") as Mode);
  const [windowed, setWindowed] = useState(search.get("windowed") !== "0");
  const [items, setItems] = useState<Item[]>(() => fixture(count, textMatrix));
  const [selected, setSelected] = useState<string>();
  const [expanded, setExpanded] = useState(new Set<string>());
  const [query, setQuery] = useState(""), [status, setStatus] = useState("就绪：合成目录数据，不载入几何");
  const [groups, setGroups] = useState<SceneSelectionSetState[]>([]);
  const [metrics, setMetrics] = useState<Record<string, unknown>>({});
  const panel = useRef<HTMLElement>(null), began = useRef(performance.now()), cpu = useRef<number | undefined>(undefined);
  const changeCount = (next: number) => act(() => { setCount(next); setItems(fixture(next, textMatrix)); setSelected(undefined); setExpanded(new Set()); setQuery(""); });
  const filtered = useMemo(() => query ? items.filter(item => item.name.includes(query) || item.id.includes(query)) : items, [items, query]);
  const update = (id: string, patch: Partial<Item>) => setItems(current => current.map(item => item.id === id ? { ...item, ...patch } : item));
  const remove = (id: string) => { setItems(current => current.filter(item => item.id !== id)); setSelected(current => current === id ? undefined : current); setStatus(`已删除 ${id}`); };
  const engine = {
    select: (id: string) => { setSelected(id); setStatus(`已选中 ${id}`); }, focusModel: (id: string) => setStatus(`聚焦回调 ${id}`),
    setVisible: (id: string, visible: boolean) => update(id, { visible }), isModelLocked: (id: string) => items.find(item => item.id === id)?.locked ?? false,
    setModelLocked: (id: string, locked: boolean) => update(id, { locked }), isCollisionEnabled: () => false, isColliding: () => false,
    setCollisionEnabled: (id: string) => setStatus(`碰撞回调 ${id}`), hasAnimation: () => false,
    selectLayer: (_model: string, id: string) => setSelected(id),
  } as unknown as ViewerEngine;
  const layerRoot: LayerTreeNode = useMemo(() => ({ id: "root", modelId: "qa-tree", name: "合成装配", type: "Group", visible: true, locked: false, deleted: false,
    children: mode === "layers" || mode === "models" ? filtered.map(item => ({ ...item, modelId: "qa-tree", type: "Mesh", deleted: false, children: [] })) : [] }), [filtered, mode]);
  function collect() {
    const element = panel.current, scroll = element?.querySelector<HTMLElement>(".asset-list,.scene-tree");
    const active = document.activeElement;
    setMetrics({ fixtureItems: items.length, filteredItems: filtered.length, mode, windowed,
      renderedRows: element?.querySelectorAll(".asset-row,.layer-node,.scene-tree-row").length ?? 0,
      domElements: element?.querySelectorAll("*").length ?? 0,
      updateToTwoFramesMs: +(performance.now() - began.current).toFixed(2),
      reactRenderCpuMs: cpu.current === undefined ? null : +cpu.current.toFixed(2),
      scrollTop: scroll?.scrollTop ?? 0, scrollHeight: scroll?.scrollHeight ?? 0, clientHeight: scroll?.clientHeight ?? 0,
      selected: selected ?? null, focused: active instanceof HTMLElement && active !== document.body
        ? active.getAttribute("aria-label") ?? active.textContent?.trim().slice(0, 80) ?? null : null });
  }
  useEffect(() => {
    let second = 0;
    const first = requestAnimationFrame(() => { second = requestAnimationFrame(collect); });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, [count, mode, windowed, items, query, selected]);
  const act = (action: () => void) => { began.current = performance.now(); cpu.current = undefined; action(); };
  const modelRows = mode === "models" ? filtered.map(item => ({ key: `instance:${item.id}`, keepMounted: expanded.has(item.id), render: () => <ModelTreeItem key={item.id}
    locale="zh-CN" model={{ id: item.id, name: item.name, format: "glb", status: "ready" } as ModelRecord} loaded={{ ...item, kind: "model" } as unknown as LoadedSceneModel}
    tree={expanded.has(item.id) ? { ...layerRoot, id: `root-${item.id}`, modelId: item.id, children: layerRoot.children.slice(0, 3) } : undefined} expanded={expanded.has(item.id)}
    modelFloors={[]} floorExpansion={0} selectedModelId={selected} selectedLayerId={undefined} engine={engine}
    onToggleTree={() => setExpanded(current => { const next = new Set(current); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return next; })}
    onLoadModel={() => setSelected(item.id)} onSetRevision={noop} onExpandFloors={noop} onUpdateFloor={noop} onRemoveObjectInteractions={noop} onSetMessage={setStatus} onDeleteModel={() => remove(item.id)} /> })) : [];
  return <main className="object-tree-qa">
    <header><h1>大对象目录验收</h1><span>{status}</span></header>
    <nav aria-label="验收控制">
      <label>数量<select aria-label="目录数量" value={count} onChange={event => changeCount(Number(event.target.value))}><option value="1000">1,000</option><option value="10000">10,000</option><option value="100000">100,000</option></select></label>
      <label>目录<select aria-label="目录类型" value={mode} onChange={event => act(() => setMode(event.target.value as Mode))}><option value="objects">基础对象</option><option value="models">模型实例</option><option value="layers">模型层级</option><option value="groups">编组目录</option></select></label>
      <label><input type="checkbox" checked={windowed} onChange={event => act(() => setWindowed(event.target.checked))} />按可见行绘制</label>
      <input aria-label="筛选样例" placeholder="筛选样例" value={query} onChange={event => act(() => setQuery(event.target.value))} />
      <button onClick={() => act(() => setSelected(filtered.at(-1)?.id))}>选中末行</button>
      <button onClick={() => act(() => { const id = `added-${Date.now()}`; setItems(current => [...current, { id, name: "新增设备", visible: true, locked: false, kind: "primitive" }]); setSelected(id); })}>新增设备</button>
      <button disabled={!selected} onClick={() => selected && act(() => remove(selected))}>删除选中</button>
      <button onClick={collect}>采集指标</button>
    </nav>
    <div className="object-tree-qa-layout">
      <aside ref={panel} className="object-tree-qa-panel">
        <div className="panel-heading"><h2>{mode === "models" ? "场景模型" : mode === "layers" ? "装配层级" : "场景对象"}</h2></div>
        <SceneTreeWindowingContext.Provider value={windowed}>
          <Profiler id="scene-tree" onRender={(_id, _phase, duration) => { cpu.current = (cpu.current ?? 0) + duration; }}>
            {mode === "groups" ? <SceneOrganizationPanel locale="zh-CN" objects={filtered} selectedIds={new Set(selected ? [selected] : [])} selectionSets={groups} lastDeletedSelectionSet={undefined} isolationActive={false}
              onClose={noop} onToggle={setSelected} onSelect={ids => setSelected(ids.at(-1))} onShow={(ids, visible) => ids.forEach(id => update(id, { visible }))} onLock={(ids, locked) => ids.forEach(id => update(id, { locked }))}
              onIsolate={ids => setStatus(`隔离回调 ${ids.length} 项`)} onRestoreIsolation={noop} onCreateSelectionSet={noop} onCreateGroup={noop} onMoveObjects={(ids, groupId) => setStatus(`移动回调 ${ids.length} 项 → ${groupId ?? "根目录"}`)} onReorderGroup={noop} onRenameGroup={noop} onUpdateSelectionSet={noop} onApplySelectionSet={id => setSelected(groups.find(group => group.id === id)?.objectIds[0])} onDeleteSelectionSet={id => setGroups(current => current.filter(group => group.id !== id))} onRestoreDeletedSelectionSet={noop} />
              : <div className="asset-list">{mode === "layers" ? <LayerTree locale="zh-CN" root={layerRoot} selectedNodeId={selected}
                onSelect={node => setSelected(node.id)} onVisibilityChange={(node, visible) => update(node.id, { visible })} onLockChange={(node, locked) => update(node.id, { locked })} onDelete={node => remove(node.id)} />
                : <FlatSceneObjectList locale="zh-CN" studio engine={engine} modelRows={modelRows} empty={!filtered.length} lighting={{ lights: [] } as unknown as GlobalLightingState}
                  selectedLightId="" selectedObjectId={selected} primitives={mode === "objects" ? filtered as unknown as LoadedSceneModel[] : []}
                  measurements={[]} annotations={[]} spaces={[]} groups={groups} organizationObjects={filtered}
                  onRevision={noop} onLightSelect={noop} onLightUpdate={noop} onLightTransform={noop}
                  onLightRemove={noop} onEnvironmentOpen={noop} onPrimitiveRemove={remove} onMeasurementRemove={noop} onAnnotationUpdate={noop} onAnnotationRemove={noop} onSpaceFocus={noop} onSpaceVisibilityChange={noop}
                  onSelectGroup={id => setSelected(groups.find(group => group.id === id)?.objectIds[0])} onRenameGroup={noop}
                  onGroupVisibilityChange={(ids, visible) => ids.forEach(id => update(id, { visible }))} onGroupLockChange={(ids, locked) => ids.forEach(id => update(id, { locked }))} />}</div>}
          </Profiler>
        </SceneTreeWindowingContext.Provider>
      </aside>
      <section><h2>实际 DOM 与更新指标</h2><output aria-label="目录性能指标"><pre>{JSON.stringify(metrics, null, 2)}</pre></output><p>数据为本地合成目录；两帧耗时含浏览器调度，React CPU 仅在开发构建可用。分别切换全量与可见行，比较同一数量及目录。</p>{inputMatrix && <InputMatrixSection />}</section>
    </div>
  </main>;
}
function fixture(count: number, textMatrix: boolean): Item[] {
  return Array.from({ length: count }, (_, index) => {
    const fallback = `工业设备 ${String(index).padStart(5, "0")}`;
    return { id: `device-${index}`, name: textMatrix ? complexTextFixtureName(index, fallback) ?? fallback : fallback, visible: true, locked: false, kind: "primitive" };
  });
}

/** 行内重命名输入验收：真实 OptimizerLayerTree（Enter/Escape/失焦提交 + IME 守卫），非复制品。 */
function InputMatrixSection() {
  const [layers, setLayers] = useState<OptimizerLayer[]>(() => Array.from({ length: 48 }, (_, index) => (
    { id: index + 1, name: `图层 ${String(index + 1).padStart(3, "0")} · ${COMPLEX_TEXT_MATRIX[index % COMPLEX_TEXT_MATRIX.length]!.text}`, depth: 0, hidden: false, deleted: false, mesh: true })));
  const onEdit = (edit: OptimizerLayerEdit) => setLayers(current => current.map(layer => {
    if (layer.id !== edit.id) return layer;
    if (edit.action === "rename") return { ...layer, name: edit.name };
    if (edit.action === "hidden") return { ...layer, hidden: edit.hidden };
    return { ...layer, deleted: true };
  }));
  return <section className="object-tree-qa-input" aria-label="行内输入验收">
    <h2>行内输入与 IME 验收</h2>
    <p>双击图层名进入重命名；组合输入期间 Enter/Escape 归输入法。真实系统输入法无法自动化，组合键序列以合成事件注入。</p>
    <OptimizerLayerTree locale="zh-CN" layers={layers} busy={false} onEdit={onEdit} canUndo={false} canRedo={false} onUndo={noop} onRedo={noop} />
  </section>;
}
