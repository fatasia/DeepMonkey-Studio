import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

interface DragPosition {
  x: number;
  y: number;
}

interface DragState extends DragPosition {
  pointerId: number;
  offsetX: number;
  offsetY: number;
}

/**
 * Keeps floating workbench panels in the current viewport while preserving
 * their authored dock position until the user starts dragging.
 */
export function useFloatingPanelDrag<T extends HTMLElement>(): {
  panelRef: RefObject<T | null>;
  style: CSSProperties | undefined;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
  reset: () => void;
} {
  const panelRef = useRef<T | null>(null);
  const dragRef = useRef<DragState | undefined>(undefined);
  const previousUserSelectRef = useRef<string | undefined>(undefined);
  const [position, setPosition] = useState<DragPosition | undefined>(undefined);

  useEffect(() => () => {
    if (previousUserSelectRef.current !== undefined) {
      document.body.style.userSelect = previousUserSelectRef.current;
      previousUserSelectRef.current = undefined;
    }
  }, []);

  function bounds() {
    const panel = panelRef.current;
    const parent = panel?.offsetParent as HTMLElement | null;
    const rect = parent?.getBoundingClientRect();
    return rect
      ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
      : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  }

  function onPointerDown(event: ReactPointerEvent<HTMLElement>) {
    if ((event.target as HTMLElement).closest("button, input, textarea, select, a")) return;
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const parent = bounds();
    dragRef.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      x: Math.max(8, rect.left - parent.left),
      y: Math.max(8, rect.top - parent.top),
    };
    previousUserSelectRef.current = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    event.currentTarget.setPointerCapture(event.pointerId);
    setPosition({ x: dragRef.current.x, y: dragRef.current.y });
  }

  function onPointerMove(event: ReactPointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    const panel = panelRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !panel) return;
    const parent = bounds();
    const rect = panel.getBoundingClientRect();
    const maxX = Math.max(8, parent.width - rect.width - 8);
    const maxY = Math.max(8, parent.height - rect.height - 8);
    setPosition({
      x: Math.min(maxX, Math.max(8, event.clientX - parent.left - drag.offsetX)),
      y: Math.min(maxY, Math.max(8, event.clientY - parent.top - drag.offsetY)),
    });
  }

  function endDrag(event: ReactPointerEvent<HTMLElement>) {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    dragRef.current = undefined;
    if (previousUserSelectRef.current !== undefined) {
      document.body.style.userSelect = previousUserSelectRef.current;
      previousUserSelectRef.current = undefined;
    }
  }

  return {
    panelRef,
    style: position
      ? { left: `${position.x}px`, top: `${position.y}px`, right: "auto", bottom: "auto", transform: "none" }
      : undefined,
    onPointerDown,
    onPointerMove,
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
    reset: () => {
      dragRef.current = undefined;
      setPosition(undefined);
    },
  };
}
