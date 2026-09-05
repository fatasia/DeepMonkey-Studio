import { useEffect, useRef } from "react";
import type { PlantLiteModel } from "@bim-studio/contracts";
import type { PlantLitePlaybackFrame } from "../components/plantLitePlaybackModel";
import type { ViewerEngine } from "../viewer/ViewerEngine";
import { createScenePlantPlaybackOverlay } from "../viewer/scenePlantPlaybackOverlay";

export function useScenePlantPlayback(engine: ViewerEngine | undefined, model: PlantLiteModel | undefined, frame: PlantLitePlaybackFrame | null) {
  const overlay = useRef<ReturnType<typeof createScenePlantPlaybackOverlay> | undefined>(undefined);
  useEffect(() => {
    if (!engine || !model?.sceneBinding) return;
    const adapter = createScenePlantPlaybackOverlay(engine.scene, model);
    overlay.current = adapter;
    return () => { adapter.dispose(); if (overlay.current === adapter) overlay.current = undefined; };
  }, [engine, model]);
  useEffect(() => { overlay.current?.update(frame); }, [engine, frame, model]);
}
