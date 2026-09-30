import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { disposeStudioReflectionProbes, loadStudioReflectionProbes, readStudioReflectionProbes, writeStudioReflectionProbes } from "./studioReflectionProbeCarriers";
import { prepareStudioDeepEnvironmentSource, isStudioDeepEnvironmentSourceCurrent } from "./studioDeepEnvironmentSource";

const probe = { id: "p1", name: "Room", enabled: true, center: { x: 0, y: 2, z: 0 }, halfExtents: { x: 3, y: 2, z: 3 }, blendDistance: 1, influenceRadius: 2 };
function texture() {
  const result = new THREE.DataTexture(new Float32Array([3, 2, 1, 1, 3, 2, 1, 1]), 2, 1, THREE.RGBAFormat, THREE.FloatType);
  result.mapping = THREE.EquirectangularReflectionMapping; result.colorSpace = THREE.LinearSRGBColorSpace;
  vi.spyOn(result, "dispose"); return result;
}
describe("Studio local reflection author carriers", () => {
  it("shares each URL within the candidate and disposes only locally owned textures", async () => {
    const inherited = texture(), local = texture(), load = vi.fn(async () => local);
    const result = await loadStudioReflectionProbes([{ ...probe, environmentMapUrl: "local.hdr" },
      { ...probe, id: "p2", environmentMapUrl: "local.hdr" }], load, "global.hdr", inherited);
    expect(load).toHaveBeenCalledExactlyOnceWith("local.hdr"); expect(result.owned).toEqual([local]);
    const scene = new THREE.Scene(); writeStudioReflectionProbes(scene, result); disposeStudioReflectionProbes(scene); disposeStudioReflectionProbes(scene);
    expect(local.dispose).toHaveBeenCalledOnce(); expect(inherited.dispose).not.toHaveBeenCalled();
  });
  it("inherits a matching global source, skips disabled probes, and rejects failed local sources without leaking", async () => {
    const inherited = texture(), local = texture(), load = vi.fn(async (url: string) => {
      if (url === "bad.hdr") throw new Error("missing source"); return local;
    });
    const result = await loadStudioReflectionProbes([{ ...probe, environmentMapUrl: "global.hdr" }, { ...probe, id: "p2", enabled: false }], load, "global.hdr", inherited);
    expect(result.owned).toEqual([]); expect(result.probes).toHaveLength(1); expect(load).not.toHaveBeenCalled();
    await expect(loadStudioReflectionProbes([{ ...probe, environmentMapUrl: "local.hdr" }, { ...probe, id: "p2", environmentMapUrl: "bad.hdr" }], load)).rejects.toThrow("missing source");
    expect(local.dispose).toHaveBeenCalledOnce(); expect(inherited.dispose).not.toHaveBeenCalled();
  });
  it("converts actual published pixels once and invalidates the bridge candidate after author boxes change", async () => {
    const scene = new THREE.Scene(), image = texture(); scene.environment = image; scene.background = new THREE.Color("#123456");
    const carriers = await loadStudioReflectionProbes([probe, { ...probe, id: "p2" }], vi.fn(), undefined, image);
    writeStudioReflectionProbes(scene, carriers);
    const prepared = await prepareStudioDeepEnvironmentSource(scene, new AbortController().signal);
    expect(prepared.textures).toHaveLength(1); expect(prepared.source.reflectionProbes).toHaveLength(2);
    if (prepared.source.kind !== "radiance-hdr") throw new Error("Expected author HDR");
    expect(prepared.source.reflectionProbes?.[0]?.image).toBe(prepared.source.image);
    expect(prepared.source.reflectionProbes?.[1]?.image).toBe(prepared.source.image);
    expect(prepared.source.reflectionProbes?.[0]?.box.center).toEqual([0, 2, 0]);
    expect(isStudioDeepEnvironmentSourceCurrent(scene, prepared)).toBe(true);
    writeStudioReflectionProbes(scene, await loadStudioReflectionProbes([{ ...probe, center: { x: 1, y: 2, z: 0 } }], vi.fn(), undefined, image));
    expect(isStudioDeepEnvironmentSourceCurrent(scene, prepared)).toBe(false);
  });
  it("surfaces a missing probe source through the existing bridge failure path", async () => {
    const scene = new THREE.Scene(); scene.background = new THREE.Color("#123456");
    writeStudioReflectionProbes(scene, { ...readStudioReflectionProbes(scene), error: "反射探针环境加载失败" });
    await expect(prepareStudioDeepEnvironmentSource(scene, new AbortController().signal)).rejects.toThrow("反射探针环境加载失败");
  });
});
