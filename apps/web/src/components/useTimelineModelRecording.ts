import { useEffect, useRef } from "react";
import type { ViewerEngine } from "../viewer/ViewerEngine";

/** 在变换手柄的一次完整拖动结束后提交一次 Auto Key，避免 objectChange 高频写 React 状态。 */
export function useTimelineModelRecording(
  engine: ViewerEngine | undefined,
  recordingKey: string | undefined,
  onRecord: (modelId: string) => void,
) {
  const callback = useRef(onRecord);
  callback.current = onRecord;
  useEffect(() => {
    if (!engine || !recordingKey) return;
    let modelId: string | undefined;
    let initial = "";
    const onDraggingChanged = (event: { value: unknown }) => {
      if (event.value === true) {
        const selected = engine.getSelected();
        modelId = selected && !engine.isModelLocked(selected.id) ? selected.id : undefined;
        initial = modelId ? JSON.stringify(engine.getModelTransform(modelId)) : "";
        return;
      }
      if (!modelId) return;
      const changedId = modelId;
      modelId = undefined;
      if (JSON.stringify(engine.getModelTransform(changedId)) !== initial) callback.current(changedId);
    };
    engine.transform.addEventListener("dragging-changed", onDraggingChanged);
    return () => engine.transform.removeEventListener("dragging-changed", onDraggingChanged);
  }, [engine, recordingKey]);
}
