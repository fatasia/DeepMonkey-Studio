import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { prepareStudioDeepEnvironmentSource, isStudioDeepEnvironmentSourceCurrent } from "./studioDeepEnvironmentSource";

function texture(rgb: readonly number[] = [2, 1, 0]): THREE.DataTexture {
  const result = new THREE.DataTexture(new Float32Array([...rgb, 1, ...rgb, 1]),
    2, 1, THREE.RGBAFormat, THREE.FloatType);
  result.mapping = THREE.EquirectangularReflectionMapping;
  result.colorSpace = THREE.LinearSRGBColorSpace;
  result.flipY = true;
  return result;
}

function scene(): THREE.Scene {
  const result = new THREE.Scene();
  result.background = new THREE.Color("#123456");
  return result;
}

const prepare = (value: THREE.Scene) => prepareStudioDeepEnvironmentSource(value, new AbortController().signal);

describe("Studio author environment source preparation", () => {
  it("uses a black IBL image when the author has no environment", async () => {
    const author = scene(); const result = await prepare(author);
    expect(result.source).toMatchObject({ kind: "radiance-hdr",
      image: { width: 2, height: 1, data: new Float32Array(6) } });
    expect(result.source).not.toHaveProperty("backgroundImage");
    expect(result.textures).toHaveLength(0);
    expect(result.environment).toBeNull();
    expect(result.background).toBe(author.background);
    expect(isStudioDeepEnvironmentSourceCurrent(author, result)).toBe(true);
  });

  it("converts a shared environment and sky texture once and shares the prepared image", async () => {
    const author = scene(); author.environment = author.background = texture();
    const result = await prepare(author);
    expect(result.textures).toHaveLength(1);
    if (result.source.kind !== "radiance-hdr") throw new Error("Expected HDR source");
    expect(Reflect.get(result.source, "backgroundImage")).toBe(result.source.image);
    expect([...result.source.image.data]).toEqual([2, 1, 0, 2, 1, 0]);
    expect(result.textures[0]?.identity.texture).toBe(author.environment);
  });

  it("preserves different IBL and background pixels without mixing their images", async () => {
    const author = scene(); author.environment = texture([4, 2, 1]); author.background = texture([0, 3, 7]);
    const result = await prepare(author);
    expect(result.textures).toHaveLength(2);
    expect(result.source).toMatchObject({ kind: "radiance-hdr",
      image: { data: new Float32Array([4, 2, 1, 4, 2, 1]) },
      backgroundImage: { data: new Float32Array([0, 3, 7, 0, 3, 7]) } });
    if (result.source.kind !== "radiance-hdr") throw new Error("Expected HDR source");
    expect(Reflect.get(result.source, "backgroundImage")).not.toBe(result.source.image);
  });

  it("keeps a textured background with black IBL when environment is absent", async () => {
    const author = scene(); author.background = texture([0, 3, 7]);
    const result = await prepare(author);
    expect(result.source).toMatchObject({ image: { data: new Float32Array(6) },
      backgroundImage: { data: new Float32Array([0, 3, 7, 0, 3, 7]) } });
    expect(result.textures).toHaveLength(1);
  });

  it.each(["version", "reference", "sourceVersion"] as const)("invalidates an environment %s change", async change => {
    const author = scene(); const original = texture(); author.environment = original;
    const result = await prepare(author);
    if (change === "version") original.needsUpdate = true;
    else if (change === "reference") author.environment = texture();
    else original.source.needsUpdate = true;
    expect(isStudioDeepEnvironmentSourceCurrent(author, result)).toBe(false);
  });

  it("permits Color replacement and intensity edits without requesting another texture upload", async () => {
    const author = scene(); author.environment = texture(); const result = await prepare(author);
    author.background = new THREE.Color("#abcdef");
    author.environmentIntensity = 0.2; author.backgroundIntensity = 0.4;
    expect(isStudioDeepEnvironmentSourceCurrent(author, result)).toBe(true);
    author.background = texture();
    expect(isStudioDeepEnvironmentSourceCurrent(author, result)).toBe(false);
  });

  it.each(["version", "reference"] as const)("invalidates a prepared background %s change", async change => {
    const author = scene(); const sky = texture(); author.background = sky;
    const result = await prepare(author);
    if (change === "version") sky.needsUpdate = true;
    else author.background = texture();
    expect(isStudioDeepEnvironmentSourceCurrent(author, result)).toBe(false);
  });

  it("rejects cancellation during the real asynchronous conversion yield", async () => {
    const author = scene(); author.environment = texture(); const controller = new AbortController();
    const pending = prepareStudioDeepEnvironmentSource(author, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it.each(["version", "reference", "background"] as const)("does not return a stale snapshot after pending %s change", async change => {
    const author = scene(); const original = texture(); author.environment = original;
    const pending = prepare(author);
    if (change === "version") original.needsUpdate = true;
    else if (change === "reference") author.environment = texture();
    else author.background = texture();
    await expect(pending).rejects.toThrow(/改变|变化/);
  });

  it("rejects an already cancelled preparation even without textures", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(prepareStudioDeepEnvironmentSource(scene(), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects transparent null background", async () => {
    const author = scene(); author.background = null;
    await expect(prepare(author)).rejects.toThrow("透明场景背景");
  });

  it.each(["environment", "background"] as const)("rejects unsupported cube %s", async slot => {
    const author = scene(); author[slot] = new THREE.CubeTexture();
    await expect(prepare(author)).rejects.toThrow("等距柱状反射贴图");
  });
});
