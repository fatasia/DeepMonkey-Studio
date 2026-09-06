import { useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { constrainDockWidth, constrainPanelLayout, defaultPanelLayout, readSimulationLayout, writeSimulationLayout,
  type SimulationDockReservation, type SimulationPanelPlacement, type SimulationPanelPreference } from "./sceneSimulationLayout";

interface PointerOperation { kind: "move" | "resize"; pointerId: number; x: number; y: number; preference: SimulationPanelPreference }

/** 布局偏好与仿真输入 / 运行严格分离；改变停靠仅调整同一已挂载宿主的几何。 */
export function useSceneSimulationLayout(onDockChange?: (reservation: SimulationDockReservation) => void) {
  const panelRef = useRef<HTMLElement>(null);
  const [preference, setPreference] = useState(readSimulationLayout);
  const latest = useRef(preference);
  const operation = useRef<PointerOperation | undefined>(undefined);
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  const docked = preference.placement !== "float";
  const narrow = docked && bounds.width > 0 && bounds.width < 640;
  const collapsed = preference.collapsed || narrow;
  const dockWidth = collapsed ? 44 : constrainDockWidth(preference.dockWidth, bounds.width);

  function update(value: SimulationPanelPreference, persist = false) {
    latest.current = value; setPreference(value);
    if (persist) writeSimulationLayout(value);
  }

  useLayoutEffect(() => {
    const container = panelRef.current?.parentElement;
    if (!container) return;
    const measure = () => {
      const next = container.getBoundingClientRect();
      setBounds(current => current.width === next.width && current.height === next.height ? current : { width: next.width, height: next.height });
    };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    onDockChange?.({ placement: preference.placement, collapsed, width: docked ? dockWidth : 0 });
  }, [onDockChange, preference.placement, collapsed, docked, dockWidth]);

  const floating = constrainPanelLayout(preference.floating ?? defaultPanelLayout(bounds.width, bounds.height), bounds.width, bounds.height, collapsed);
  const style: CSSProperties = docked
    ? { width: dockWidth, ...(preference.placement === "left" ? { left: 0, right: "auto" } : { left: "auto", right: 0 }) }
    : { left: floating.left, top: floating.top, width: collapsed ? Math.min(320, floating.width) : floating.width, height: collapsed ? Math.min(48, floating.height) : floating.height };

  function place(placement: SimulationPanelPlacement) {
    operation.current = undefined;
    update({ ...latest.current, placement, floating: latest.current.floating ?? floating }, true);
  }

  function collapse(value: boolean) { update({ ...latest.current, collapsed: value }, true); }

  function begin(kind: PointerOperation["kind"], event: PointerEvent<HTMLElement>) {
    if (event.button !== 0 || (kind === "move" && (docked || (event.target as Element).closest("button")))) return;
    operation.current = { kind, pointerId: event.pointerId, x: event.clientX, y: event.clientY, preference: docked ? { ...latest.current, dockWidth } : { ...latest.current, floating } };
    event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault();
  }

  function move(event: PointerEvent<HTMLElement>) {
    const active = operation.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const dx = event.clientX - active.x, dy = event.clientY - active.y;
    if (docked) {
      const direction = preference.placement === "left" ? 1 : -1;
      update({ ...active.preference, dockWidth: constrainDockWidth(active.preference.dockWidth + dx * direction, bounds.width) });
      return;
    }
    const start = active.preference.floating!;
    const changed = active.kind === "move" ? { ...start, left: start.left + dx, top: start.top + dy } : { ...start, width: start.width + dx, height: start.height + dy };
    update({ ...active.preference, floating: constrainPanelLayout(changed, bounds.width, bounds.height, collapsed) });
  }

  function finish(event: PointerEvent<HTMLElement>) {
    if (operation.current?.pointerId !== event.pointerId) return;
    operation.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    writeSimulationLayout(latest.current);
  }

  function resizeByKey(event: KeyboardEvent<HTMLElement>) {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const dx = event.key === "ArrowLeft" ? -24 : event.key === "ArrowRight" ? 24 : 0;
    const dy = event.key === "ArrowUp" ? -24 : event.key === "ArrowDown" ? 24 : 0;
    if (docked) update({ ...latest.current, dockWidth: constrainDockWidth(dockWidth + dx * (preference.placement === "left" ? 1 : -1), bounds.width) }, true);
    else update({ ...latest.current, floating: constrainPanelLayout({ ...floating, width: floating.width + dx, height: floating.height + dy }, bounds.width, bounds.height) }, true);
  }

  return { panelRef, placement: preference.placement, docked, collapsed, narrow, style, place, collapse, begin, move, finish, resizeByKey };
}
