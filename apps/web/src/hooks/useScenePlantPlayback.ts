import { useEffect, useRef } from "react";
import type { PlantLiteModel } from "@bim-studio/contracts";
import type { PlantLitePlaybackFrame } from "../components/plantLitePlaybackModel";
import type { ViewerEngine } from "../viewer/ViewerEngine";
import { createScenePlantPlaybackOverlay } from "../viewer/scenePlantPlaybackOverlay";
import { Color } from "three";

export function useScenePlantPlayback(engine: ViewerEngine | undefined, model: PlantLiteModel | undefined, frame: PlantLitePlaybackFrame | null) {
  const overlay = useRef<ReturnType<typeof createScenePlantPlaybackOverlay> | undefined>(undefined);
  useEffect(() => {
    if (!engine || !model?.sceneBinding) return;
    const readPalette = () => {
      const style = getComputedStyle(document.documentElement);
      const color = (token: string) => new Color(style.getPropertyValue(token).trim() || style.color);
      return { waiting: color("--warning"), moving: color("--accent"), completed: color("--success") };
    };
    const adapter = createScenePlantPlaybackOverlay(engine.scene, model, readPalette());
    const observer = new MutationObserver(() => adapter.setPalette(readPalette()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class", "data-theme"] });
    overlay.current = adapter;
    return () => { observer.disconnect(); adapter.dispose(); if (overlay.current === adapter) overlay.current = undefined; };
  }, [engine, model]);
  useEffect(() => { overlay.current?.update(frame); }, [engine, frame, model]);
}
