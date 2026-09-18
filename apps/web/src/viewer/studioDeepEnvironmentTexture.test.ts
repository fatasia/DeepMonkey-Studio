import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { captureStudioEnvironmentTexture, isStudioEnvironmentTextureCurrent,
  prepareStudioEnvironmentTexture, prepareStudioEnvironmentTextureAsync } from "./studioDeepEnvironmentTexture";

function fixture() {
  const texture = new THREE.DataTexture(new Float32Array([2, 1, 0, 1, 0, 1, 3, 1]),
    1, 2, THREE.RGBAFormat, THREE.FloatType);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.LinearSRGBColorSpace;
  texture.flipY = true;
  return texture;
}
function rgb(texture: THREE.Texture) {
  const result = prepareStudioEnvironmentTexture(texture).source;
  if (result.kind !== "radiance-hdr") throw new Error("Expected author source");
  return result.image.data;
}
class TestCanvas {
  width = 0;
  height = 0;
  getContext(): unknown { return null; }
}
beforeEach(() => {
  vi.stubGlobal("HTMLCanvasElement", TestCanvas);
  vi.stubGlobal("document", { createElement: () => new TestCanvas() });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Studio environment texture conversion", () => {
  it("owns linear HDR pixels without clamping or mutating the source", () => {
    const texture = fixture(), data = rgb(texture);
    expect([...data]).toEqual([2, 1, 0, 0, 1, 3]);
    texture.image.data![0] = 7;
    expect(data[0]).toBe(2);
  });
  it("normalizes Three flipY=false into top-left Deep panorama rows", () => {
    const texture = fixture(); texture.flipY = false;
    expect([...rgb(texture)]).toEqual([0, 1, 3, 2, 1, 0]);
  });
  it("decodes HalfFloat through Three DataUtils", () => {
    const texture = fixture(); texture.type = THREE.HalfFloatType;
    texture.image.data = new Uint16Array([2, 1, 0, 1, 0, 1, 3, 1].map(THREE.DataUtils.toHalfFloat));
    expect([...rgb(texture)]).toEqual([2, 1, 0, 0, 1, 3]);
  });
  it("decodes sRGB bytes exactly once", () => {
    const texture = fixture(); texture.type = THREE.UnsignedByteType;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.image.data = new Uint8Array([128, 0, 255, 255, 0, 0, 0, 255]);
    expect(rgb(texture)[0]).toBeCloseTo(0.2158605, 6);
  });
  it("does not depend on global Three color management being enabled", () => {
    const texture = fixture(); texture.colorSpace = THREE.SRGBColorSpace;
    texture.image.data![0] = 0.5;
    const previous = THREE.ColorManagement.enabled;
    try {
      THREE.ColorManagement.enabled = false;
      expect(rgb(texture)[0]).toBeCloseTo(0.21404114, 6);
    } finally { THREE.ColorManagement.enabled = previous; }
  });
  it.each([NaN, Infinity, -1])("rejects invalid radiance %s", value => {
    const texture = fixture(); texture.image.data![0] = value;
    expect(() => rgb(texture)).toThrow("非法辐射");
  });
  it("rejects transparency", () => {
    const texture = fixture(); texture.image.data![3] = 0.5;
    expect(() => rgb(texture)).toThrow("非不透明");
  });
  it("rejects linear conversion overflowing RGB32F", () => {
    const texture = fixture(); texture.colorSpace = THREE.SRGBColorSpace;
    texture.image.data![0] = 1e30;
    expect(() => rgb(texture)).toThrow("RGB32F");
  });
  it("detects in-place source shape and pixel buffer replacements", () => {
    const texture = fixture(), identity = captureStudioEnvironmentTexture(texture);
    texture.image.width = 2;
    expect(isStudioEnvironmentTextureCurrent(identity)).toBe(false);
    texture.image.width = 1; texture.image.data = new Float32Array(8);
    expect(isStudioEnvironmentTextureCurrent(identity)).toBe(false);
  });
  it("rejects wrong mapping, color space, format and pixel declarations", () => {
    const texture = fixture(); texture.mapping = THREE.UVMapping;
    expect(() => rgb(texture)).toThrow("等距柱状");
    texture.mapping = THREE.EquirectangularReflectionMapping; texture.colorSpace = THREE.NoColorSpace;
    expect(() => rgb(texture)).toThrow("色彩空间");
    texture.colorSpace = THREE.LinearSRGBColorSpace; texture.format = THREE.RedFormat;
    expect(() => rgb(texture)).toThrow("RGBA");
    texture.format = THREE.RGBAFormat; texture.type = THREE.HalfFloatType;
    expect(() => rgb(texture)).toThrow("不匹配");
  });
  it("rejects partial data, dimensions and memory overruns before allocation", () => {
    const texture = fixture(); texture.image.width = 0;
    expect(() => rgb(texture)).toThrow("尺寸");
    texture.image.width = 2;
    expect(() => rgb(texture)).toThrow("完整");
    texture.image.width = 1;
    expect(() => prepareStudioEnvironmentTexture(texture, { maxBytes: 23 })).toThrow("内存");
    expect(() => prepareStudioEnvironmentTexture(texture, { maxDimension: 1 })).toThrow("尺寸");
    expect(() => prepareStudioEnvironmentTexture(texture, { maxBytes: NaN })).toThrow("预算无效");
  });
  it("checks cancellation before source access", () => {
    const controller = new AbortController(); controller.abort();
    expect(() => prepareStudioEnvironmentTexture(fixture(), { signal: controller.signal })).toThrow("已取消");
  });
  it.each(["version", "source", "image", "flipY"])("detects changed %s identity", key => {
    const texture = fixture(), identity = captureStudioEnvironmentTexture(texture);
    expect(isStudioEnvironmentTextureCurrent(identity)).toBe(true);
    if (key === "version") texture.needsUpdate = true;
    if (key === "source") texture.source.needsUpdate = true;
    if (key === "image") texture.image = { ...texture.image };
    if (key === "flipY") texture.flipY = false;
    expect(isStudioEnvironmentTextureCurrent(identity)).toBe(false);
  });
  function browserTexture(): THREE.Texture {
    const texture = new THREE.Texture(document.createElement("canvas"));
    texture.image.width = 1; texture.image.height = 1;
    texture.mapping = THREE.EquirectangularReflectionMapping; texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }
  it("reads canvas sRGB once and releases temporary canvas", () => {
    const texture = browserTexture();
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage,
      getImageData: () => ({ data: new Uint8ClampedArray([128, 255, 0, 255]) }) } as never);
    expect(rgb(texture)[0]).toBeCloseTo(0.2158605, 6);
    expect(drawImage).toHaveBeenCalledWith(texture.image, 0, 0, 1, 1);
  });
  it("redacts cross-origin canvas failures", () => {
    const texture = browserTexture();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: () => {
      throw new Error("https://secret.invalid/token"); } } as never);
    expect(() => rgb(texture)).toThrow("跨域读取权限");
    expect(() => rgb(texture)).not.toThrow("secret.invalid");
  });
  it("uses decoded image dimensions rather than CSS dimensions", () => {
    const texture = browserTexture();
    texture.image = { width: 400, height: 400, naturalWidth: 1, naturalHeight: 1 };
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage,
      getImageData: () => ({ data: new Uint8ClampedArray([255, 255, 255, 255]) }) } as never);
    expect([...rgb(texture)]).toEqual([1, 1, 1]);
    expect(drawImage).toHaveBeenCalledWith(texture.image, 0, 0, 1, 1);
    (texture.image as { naturalWidth: number }).naturalWidth = 0;
    expect(() => rgb(texture)).toThrow("未解码");
  });
  it("rejects cancellation and source replacement during readback", () => {
    const texture = browserTexture(), controller = new AbortController();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: () => {},
      getImageData: () => { controller.abort(); return { data: new Uint8ClampedArray([0, 0, 0, 255]) }; } } as never);
    expect(() => prepareStudioEnvironmentTexture(texture, { signal: controller.signal })).toThrow("已取消");
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: () => {},
      getImageData: () => { texture.needsUpdate = true; return { data: new Uint8ClampedArray([0, 0, 0, 255]) }; } } as never);
    expect(() => rgb(texture)).toThrow("转换期间变化");
  });
  it("keeps async pixels identical to synchronous conversion", async () => {
    const texture = fixture();
    expect(await prepareStudioEnvironmentTextureAsync(texture)).toEqual(prepareStudioEnvironmentTexture(texture));
  });
  function largeTexture() {
    const texture = fixture();
    const data = new Float32Array(256 * 256 * 4);
    for (let index = 3; index < data.length; index += 4) data[index] = 1;
    texture.image = { width: 256, height: 256, data };
    return texture;
  }
  it("accepts input cancellation between actual conversion batches", async () => {
    const texture = largeTexture(), controller = new AbortController();
    texture.type = THREE.HalfFloatType;
    texture.image.data = new Uint16Array(Array.from(texture.image.data!, THREE.DataUtils.toHalfFloat));
    texture.image.data[texture.image.data.length - 4] = 0x7e00;
    const decode = vi.spyOn(THREE.DataUtils, "fromHalfFloat");
    const pending = prepareStudioEnvironmentTextureAsync(texture, { signal: controller.signal });
    // The initial conversion timer runs first; this input must precede the last invalid pixel.
    setTimeout(() => controller.abort(), 0);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(decode).toHaveBeenCalledTimes(16_384 * 4);
  });
  it("rejects source changes between async batches", async () => {
    const texture = largeTexture();
    const pending = prepareStudioEnvironmentTextureAsync(texture);
    setTimeout(() => { texture.needsUpdate = true; }, 0);
    await expect(pending).rejects.toThrow("转换期间变化");
  });
  it("rejects replacement while waiting to start and supports a clean retry", async () => {
    const texture = fixture();
    const pending = prepareStudioEnvironmentTextureAsync(texture);
    texture.needsUpdate = true;
    await expect(pending).rejects.toThrow("转换期间变化");
    expect(await prepareStudioEnvironmentTextureAsync(texture)).toEqual(prepareStudioEnvironmentTexture(texture));
  });
  it("does not read a canvas cancelled before initial conversion", async () => {
    const texture = browserTexture(), controller = new AbortController();
    const read = vi.spyOn(HTMLCanvasElement.prototype, "getContext");
    const pending = prepareStudioEnvironmentTextureAsync(texture, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(read).not.toHaveBeenCalled();
  });
});
