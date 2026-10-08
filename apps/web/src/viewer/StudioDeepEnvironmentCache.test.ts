import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { StudioDeepEnvironmentCache } from "./StudioDeepEnvironmentCache";
import { setStudioDeepEnvironmentMips } from "./studioDeepEnvironmentMips";

function fixture() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#123456");
  const texture = new THREE.DataTexture(new Float32Array([2, 1, 0, 1, 2, 1, 0, 1]),
    2, 1, THREE.RGBAFormat, THREE.FloatType);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.LinearSRGBColorSpace;
  scene.environment = texture;
  const cache = new StudioDeepEnvironmentCache();
  const prepare = () => cache.prepare(scene, new AbortController().signal);
  return { scene, texture, cache, prepare };
}

describe("bridge CPU environment cache", () => {
  it("reuses pixel arrays through intensity and solid-background edits", async () => {
    const { scene, cache, prepare } = fixture();
    const first = await prepare();
    scene.environmentIntensity = 0.5;
    scene.background = new THREE.Color("#ffffff");
    expect(await prepare()).toBe(first);
    cache.clear();
    expect(await prepare()).not.toBe(first);
  });

  it.each(["version", "dispose", "mips"] as const)("invalidates %s before the next switch", async (change) => {
    const { scene, texture, cache, prepare } = fixture();
    const first = await prepare();
    if (change === "version") texture.needsUpdate = true;
    else if (change === "dispose") texture.dispose();
    else setStudioDeepEnvironmentMips(scene, 3);
    const second = await prepare();
    expect(second).not.toBe(first);
    expect(second.source).toMatchObject({ kind: "radiance-hdr" });
    cache.clear();
  });

  it("does not cache cancelled conversions or serve a cancelled cache hit", async () => {
    const { scene, cache, prepare } = fixture();
    const controller = new AbortController();
    const pending = cache.prepare(scene, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    const ready = await prepare();
    await expect(cache.prepare(scene, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(await prepare()).toBe(ready);
    cache.clear();
  });

  it("clearing during preparation prevents late retention", async () => {
    const { scene, cache, prepare } = fixture();
    const pending = prepare();
    cache.clear();
    const first = await pending;
    expect(await cache.prepare(scene, new AbortController().signal)).not.toBe(first);
    cache.clear();
  });
});
