import { describe, expect, it } from "vitest";
import type { SceneSnapshot } from "@bim-studio/contracts";
import type { DeepRuntimePackage } from "@bim-studio/deep-engine/runtime-package";
import { compileSceneDynamicRuntimePackage, startSceneViewerDynamicPlayback } from "./sceneViewerDynamicPlayback";

function scene(): SceneSnapshot {
  return { schemaVersion: 1, id: "source", projectId: "project", name: "fixture", primitives: [], models: [], measurements: [],
    camera: { mode: "orbit", position: { x: 0, y: 1, z: 5 }, target: { x: 0, y: 0, z: 0 } }, createdAt: "", updatedAt: "" };
}
function animated(): SceneSnapshot {
  return { ...scene(), primitives: [{ modelId: "pump", name: "pump", kind: "box", color: "#808080", visible: true, opacity: 1,
    transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } }],
    animation: { duration: 1, loop: true, camera: [], models: [
      { id: "frame-0", time: 0, modelId: "pump", transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } },
      { id: "frame-1", time: 1, modelId: "pump", transform: { position: { x: 4, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } },
    ] } } as SceneSnapshot;
}

describe("scene viewer dynamic playback wiring", () => {
  it("builds a v7 carrier package from the real TRS lowering", () => {
    const runtimePackage = compileSceneDynamicRuntimePackage(animated(), { packageId: "viewer.dynamic", packageVersion: "1.0.0" });
    expect(runtimePackage.schemaVersion).toBe(7);
    expect(runtimePackage.entrypoints.dynamicRuntime).toBe("scene.dynamic");
    const dynamic = runtimePackage.payloads["scene.dynamic"] as { animation: { durationMs: number; tracks: unknown[] } };
    expect(dynamic.animation.durationMs).toBe(1000);
    expect(dynamic.animation.tracks).toHaveLength(3);
    expect(runtimePackage.resources.find(resource => resource.kind === "dynamic-runtime")).toBeTruthy();
  });
  it("rejects snapshots without a playable dynamic channel", () => {
    expect(() => compileSceneDynamicRuntimePackage(scene(), { packageId: "viewer.dynamic", packageVersion: "1.0.0" })).toThrow(/TRS 动画/);
  });
  it("starts engine playback on the presentation scheduler for animated snapshots", () => {
    const calls: Array<{ runtimePackage: DeepRuntimePackage; options: Record<string, unknown> | undefined }> = [];
    let stopped = false;
    const host = { startDynamicRuntimePlayback: (runtimePackage: DeepRuntimePackage, options?: Record<string, unknown>) => {
      calls.push({ runtimePackage, options });
      return () => { stopped = true; };
    } };
    const presented: number[] = [];
    const stop = startSceneViewerDynamicPlayback(host, animated(), {
      packageId: "viewer.dynamic", packageVersion: "1.0.0",
      onFramePresented: frame => presented.push(frame.timeMs),
    });
    expect(stop).toBeTypeOf("function");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.runtimePackage.entrypoints.dynamicRuntime).toBe("scene.dynamic");
    expect(calls[0]!.options).toMatchObject({ loop: true });
    expect((calls[0]!.options as { onFramePresented?: unknown }).onFramePresented).toBeTypeOf("function");
    stop?.();
    expect(stopped).toBe(true);
  });
  it("stays silent for static snapshots instead of faking playback", () => {
    const host = { startDynamicRuntimePlayback: () => { throw new Error("must not start"); } };
    expect(startSceneViewerDynamicPlayback(host, scene(), { packageId: "viewer.dynamic", packageVersion: "1.0.0" })).toBeUndefined();
  });
});
