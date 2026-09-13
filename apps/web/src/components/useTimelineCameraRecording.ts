import { useEffect, useRef } from "react";
import type { CameraState } from "@bim-studio/contracts";
import type { ViewerEngine } from "../viewer/ViewerEngine";

/** 只记录用户操控产生的镜头变化；定位播放头和播放动画不参与 Auto Key。 */
export function useTimelineCameraRecording(engine: ViewerEngine | undefined, recordingKey: string | undefined, onRecord: (camera: CameraState) => void) {
  const callback = useRef(onRecord);
  callback.current = onRecord;
  useEffect(() => {
    if (!engine || !recordingKey) return;
    let active = false;
    let ended = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let initial = "";
    const start = () => { clearTimeout(timer); active = true; ended = false; initial = JSON.stringify(engine.getCameraState()); };
    const record = () => {
      if (!active) return;
      active = false;
      const camera = engine.getCameraState();
      if (JSON.stringify(camera) !== initial) callback.current(camera);
    };
    const settle = () => { if (active && ended) { clearTimeout(timer); timer = setTimeout(record, 160); } };
    const end = () => { ended = true; settle(); };
    engine.orbit.addEventListener("start", start);
    engine.orbit.addEventListener("change", settle);
    engine.orbit.addEventListener("end", end);
    return () => {
      clearTimeout(timer);
      engine.orbit.removeEventListener("start", start);
      engine.orbit.removeEventListener("change", settle);
      engine.orbit.removeEventListener("end", end);
    };
  }, [engine, recordingKey]);
}
