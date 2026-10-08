import { useEffect, useRef } from "react";
import { getNodesBounds, getViewportForBounds, type Node, type ReactFlowInstance } from "@xyflow/react";

/** Fit explicit positions, avoiding a frame of stale internal bounds after arrange. */
export function useWorkbenchGraphViewport<N extends Node>(nodes: N[], size: { width: number; height: number }) {
  const container = useRef<HTMLDivElement>(null);
  const instance = useRef<ReactFlowInstance<N> | null>(null);
  const current = useRef(nodes);
  current.current = nodes;
  const nodeIds = JSON.stringify(nodes.map(node => node.id).sort());
  function fit(next = current.current) {
    const element = container.current, flow = instance.current;
    if (!element || !flow || !next.length || element.clientWidth < 1 || element.clientHeight < 1) return;
    const bounds = getNodesBounds(next.map(node => ({ ...node, measured: { ...size } })));
    void flow.setViewport(getViewportForBounds(bounds, element.clientWidth, element.clientHeight, .08, 1, .18));
  }
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(() => fit());
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // Query results can arrive after mount without changing the canvas size.
  // Refit membership changes, while keeping the user's view during node dragging.
  useEffect(() => { fit(); }, [nodeIds]);
  return { container, instance, fit };
}
