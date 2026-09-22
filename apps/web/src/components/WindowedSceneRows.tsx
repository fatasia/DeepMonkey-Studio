import { Fragment, memo, useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { sceneRowOffsets, sceneRowScrollDelta, visibleSceneRows, type SceneRowSize } from "./virtualSceneRows";
import { useSceneTreeWindowing } from "./sceneTreePreference";
import { focusLayerRow, layerKeyboardOccupied } from "./layerKeyboard";
import "./WindowedSceneRows.css";

export interface SceneRow extends SceneRowSize { render: () => ReactNode }
interface Props { rows: readonly SceneRow[]; selectedKey?: string | undefined; rowHeight?: number; enabled?: boolean | undefined }
const focusable = 'button:not(:disabled),[tabindex="0"],input:not(:disabled),select:not(:disabled)';

function focusRevealedRow(element: HTMLElement, last: boolean, lastLayer: boolean) {
  const layers = element.querySelectorAll<HTMLElement>('[data-layer-keyboard-row]');
  if (layers.length && !last) { focusLayerRow(lastLayer ? layers[layers.length - 1] : layers[0]); return; }
  const controls = element.querySelectorAll<HTMLElement>(focusable);
  const target = last ? controls[controls.length - 1] : element.querySelector<HTMLElement>('.asset-main,.layer-node-main,.scene-tree-name,[role="treeitem"][tabindex="0"]') ?? controls[0];
  target?.focus({ preventScroll: true });
}

/** 复用目录原来的滚动容器。展开行保留挂载，其内部树也按同一视口裁剪。 */
export function WindowedSceneRows({ rows, selectedKey, rowHeight = 32, enabled }: Props) {
  const preference = useSceneTreeWindowing(), virtual = (enabled ?? preference) && rows.length > 200;
  const root = useRef<HTMLDivElement>(null), scroll = useRef<HTMLElement | null>(null);
  const measured = useRef(new Map<string, number>()), elements = useRef(new Map<string, HTMLDivElement>());
  const observer = useRef<ResizeObserver | undefined>(undefined), pendingFrame = useRef(0);
  const [viewport, setViewport] = useState({ top: 0, height: 600 }), [, revise] = useState(0);
  const [focusedKey, setFocusedKey] = useState<string>();
  const [pendingKey, setPendingKey] = useState<string>();
  const revealFrame = useRef(0);
  const previousFocusIndex = useRef(0), previousSelected = useRef<string | undefined>(undefined);
  const offsets = sceneRowOffsets(rows, measured.current, rowHeight);
  const live = useRef({ rows, offsets, viewport }); live.current = { rows, offsets, viewport };

  const updateViewport = useCallback(() => {
    const host = root.current, parent = scroll.current;
    if (!host || !parent) return;
    const next = { top: parent.getBoundingClientRect().top + parent.clientTop - host.getBoundingClientRect().top, height: parent.clientHeight || 600 };
    setViewport(old => old.top === next.top && old.height === next.height ? old : next);
  }, []);
  const scheduleViewport = useCallback(() => {
    if (!pendingFrame.current) pendingFrame.current = requestAnimationFrame(() => { pendingFrame.current = 0; updateViewport(); });
  }, [updateViewport]);
  useLayoutEffect(() => {
    const host = root.current;
    if (!host) return;
    let parent = host.parentElement;
    while (parent && !/(auto|scroll)/.test(getComputedStyle(parent).overflowY)) parent = parent.parentElement;
    scroll.current = parent ?? document.documentElement;
    scroll.current.addEventListener("scroll", scheduleViewport, { passive: true });
    window.addEventListener("resize", scheduleViewport);
    const resize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(scheduleViewport);
    resize?.observe(scroll.current); resize?.observe(host);
    updateViewport();
    return () => {
      scroll.current?.removeEventListener("scroll", scheduleViewport); window.removeEventListener("resize", scheduleViewport);
      resize?.disconnect(); if (pendingFrame.current) cancelAnimationFrame(pendingFrame.current);
      if (revealFrame.current) cancelAnimationFrame(revealFrame.current);
    };
  }, [scheduleViewport, updateViewport]);
  useLayoutEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const resize = new ResizeObserver(entries => {
      let changed = false;
      for (const entry of entries) {
        const element = entry.target as HTMLElement, key = element.dataset.sceneRowKey!;
        const height = element.getBoundingClientRect().height;
        if (height > 0 && Math.abs((measured.current.get(key) ?? 0) - height) > .5) { measured.current.set(key, height); changed = true; }
      }
      if (changed) revise(value => value + 1);
    });
    observer.current = resize; elements.current.forEach(element => resize.observe(element));
    return () => { resize.disconnect(); observer.current = undefined; };
  }, []);
  const bind = useCallback((key: string, element: HTMLDivElement | null) => {
    const previous = elements.current.get(key);
    if (previous) observer.current?.unobserve(previous);
    if (element) { elements.current.set(key, element); observer.current?.observe(element); }
    else elements.current.delete(key);
  }, []);
  const reveal = useCallback((key: string, focus = false, last = false, lastLayer = false) => {
    const index = live.current.rows.findIndex(row => row.key === key), parent = scroll.current;
    if (index < 0 || !parent) return;
    const { offsets: positions } = live.current;
    const top = parent.getBoundingClientRect().top + parent.clientTop - (root.current?.getBoundingClientRect().top ?? 0);
    parent.scrollTop += sceneRowScrollDelta(positions[index]!, positions[index + 1]!, top, parent.clientHeight || 600);
    updateViewport();
    // 先使目标挂载，再以真实位置校正；展开/切换列表时旧占位高度可能被浏览器限幅。
    setPendingKey(key);
    if (focus) { setFocusedKey(key); previousFocusIndex.current = index; }
    // 已挂载行立即移焦；只有虚拟列表尚未挂载的目标才等待下一帧。
    const mounted = elements.current.get(key);
    if (focus && mounted) focusRevealedRow(mounted, last, lastLayer);
    if (revealFrame.current) cancelAnimationFrame(revealFrame.current);
    revealFrame.current = requestAnimationFrame(() => {
      revealFrame.current = 0;
      const element = elements.current.get(key);
      if (element) {
        const rect = element.getBoundingClientRect(), viewportTop = parent.getBoundingClientRect().top + parent.clientTop;
        parent.scrollTop += sceneRowScrollDelta(rect.top, rect.bottom, viewportTop, parent.clientHeight || 600);
        updateViewport();
        if (focus) focusRevealedRow(element, last, lastLayer);
      }
      setPendingKey(undefined);
    });
  }, [updateViewport]);
  useLayoutEffect(() => {
    const keys = new Set(rows.map(row => row.key));
    for (const key of measured.current.keys()) if (!keys.has(key)) measured.current.delete(key);
    if (selectedKey && selectedKey !== previousSelected.current && keys.has(selectedKey)) { reveal(selectedKey); previousSelected.current = selectedKey; }
    if (!selectedKey) previousSelected.current = undefined;
    if (focusedKey) {
      const index = rows.findIndex(row => row.key === focusedKey);
      if (index >= 0) previousFocusIndex.current = index;
      else { const next = rows[Math.min(previousFocusIndex.current, rows.length - 1)]; if (next) reveal(next.key, true); else setFocusedKey(undefined); }
    }
  }, [rows, selectedKey, focusedKey, reveal]);

  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.defaultPrevented || (event.target as HTMLElement).closest('.windowed-scene-rows') !== root.current) return;
    if (layerKeyboardOccupied(event) || (event.target as HTMLElement).closest('details[open]')) return;
    if (event.altKey || event.ctrlKey || event.metaKey || (event.shiftKey && event.key !== "Tab")) return;
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-scene-row-key]');
    const index = rows.findIndex(item => item.key === row?.dataset.sceneRowKey);
    if (index < 0) return;
    // 一个虚拟行可包含整个编组；先走组内可见行，边界才交还虚拟列表揭示下一行。
    const layerRows = [...row!.querySelectorAll<HTMLElement>('[data-layer-keyboard-row]')];
    const layerIndex = layerRows.indexOf((event.target as HTMLElement).closest<HTMLElement>('[data-layer-keyboard-row]')!);
    const adjacent = event.key === "ArrowDown" ? layerIndex + 1 : event.key === "ArrowUp" ? layerIndex - 1 : -1;
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && layerIndex >= 0 && adjacent >= 0 && adjacent < layerRows.length) {
      event.preventDefault(); event.stopPropagation(); focusLayerRow(layerRows[adjacent]); return;
    }
    let next = index, last = false;
    if (event.key === "ArrowDown") next++;
    else if (event.key === "ArrowUp") next--;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = rows.length - 1;
    else if (event.key === "Tab" && virtual) {
      const controls = row!.querySelectorAll<HTMLElement>(focusable);
      if (event.shiftKey && event.target === controls[0]) { next--; last = true; }
      else if (!event.shiftKey && event.target === controls[controls.length - 1]) next++;
      else return;
    } else return;
    if (next < 0 || next >= rows.length) return;
    event.preventDefault(); event.stopPropagation(); reveal(rows[next]!.key, true, last, event.key === "ArrowUp" || event.key === "End");
  }

  const range = virtual ? visibleSceneRows(offsets, viewport.top, viewport.height) : { start: 0, end: rows.length };
  const indices = new Set<number>();
  for (let i = range.start; i < range.end; i++) indices.add(i);
  if (virtual) rows.forEach((row, index) => { if (row.keepMounted || row.key === focusedKey || row.key === pendingKey) indices.add(index); });
  let cursor = 0;
  const content = [...indices].sort((a, b) => a - b).map(index => {
    const row = rows[index]!, gap = offsets[index]! - offsets[cursor]!; cursor = index + 1;
    return <Fragment key={row.key}>{gap > 0 && <div aria-hidden="true" style={{ height: gap }} />}
      <MeasuredRow row={row} bind={bind} />
    </Fragment>;
  });
  return <div ref={root} className="windowed-scene-rows" data-windowed={virtual} data-total-rows={rows.length} onKeyDown={keyDown}
    onFocusCapture={event => { if ((event.target as HTMLElement).closest('.windowed-scene-rows') === root.current) setFocusedKey((event.target as HTMLElement).closest<HTMLElement>('[data-scene-row-key]')?.dataset.sceneRowKey); }}>
    {content}{offsets[rows.length]! > offsets[cursor]! && <div aria-hidden="true" style={{ height: offsets[rows.length]! - offsets[cursor]! }} />}
  </div>;
}

const MeasuredRow = memo(function MeasuredRow({ row, bind }: { row: SceneRow; bind: (key: string, element: HTMLDivElement | null) => void }) {
  const ref = useCallback((element: HTMLDivElement | null) => bind(row.key, element), [bind, row.key]);
  return <div ref={ref} data-scene-row-key={row.key} className="windowed-scene-row">{row.render()}</div>;
});
