import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelRecord } from "@bim-studio/contracts";
import { convertProjectModelToGlb, isDirectOptimizerInput, optimizedAssetFile } from "./modelOptimizerAssets";

afterEach(() => vi.unstubAllGlobals());

describe("model optimizer asset pipeline", () => {
  it("keeps GLB and glTF local while routing other formats through conversion", () => {
    expect(isDirectOptimizerInput(new File([], "line.GLB"))).toBe(true);
    expect(isDirectOptimizerInput(new File([], "plant.ifc"))).toBe(false);
  });

  it("creates a stable optimized project asset name", () => {
    expect(optimizedAssetFile("assembly.step", new Uint8Array([1])).name).toBe("assembly.optimized.glb");
  });
  it.each(["urdf", "zip"])("rejects flattening %s robot resources before any download", async format => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const model = { name: "robot", format, status: "ready", sourceUrl: "/assets/robot", manifest: { viewerKind: "urdf", geometryUrl: "/assets/robot" } } as ModelRecord;
    await expect(convertProjectModelToGlb(model)).rejects.toThrow("无损压缩");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("passes project GLB bytes through without a lossy viewer re-export", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const fetcher = vi.fn(async () => new Response(bytes)); vi.stubGlobal("fetch", fetcher);
    const model = { name: "animated.glb", format: "glb", status: "ready", sourceUrl: "/assets/original.glb", manifest: { viewerKind: "gltf", geometryUrl: "/assets/converted.glb" } } as ModelRecord;
    const file = await convertProjectModelToGlb(model);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
    expect(file.name).toBe(model.name);
    expect(fetcher).toHaveBeenCalledWith(model.sourceUrl, expect.objectContaining({ credentials: "same-origin", signal: expect.any(AbortSignal) }));
    const renamed = await convertProjectModelToGlb({ ...model, name: "平行机械夹爪" });
    expect(renamed.name).toBe("平行机械夹爪.glb");
  });
});
