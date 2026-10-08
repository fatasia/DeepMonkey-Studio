import { describe, expect, it, vi } from "vitest";
import { GltfImportError } from "@bim-studio/deep-engine/gltf";
import * as THREE from "three";
import { applyMaterialTextureTransform } from "../viewer/materialTextureTransform";
import { AuthorTextureResolver, authorTextureId, authorTextureTransform, ensureGeometryTangents,
  packAuthorMetallicRoughness } from "./sceneTextureOverrides";

const decodeWithSharp = async (image: { data: Uint8Array }) => {
  const sharp = (await import("sharp")).default;
  const decoded = await sharp(image.data).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: decoded.info.width, height: decoded.info.height, data: new Uint8Array(decoded.data) };
};

const png = async (size: number, red: number): Promise<Uint8Array<ArrayBuffer>> => {
  const sharp = (await import("sharp")).default;
  return new Uint8Array(await sharp({ create: { width: size, height: size, channels: 4,
    background: { r: red, g: 30, b: 40, alpha: 1 } } }).png().toBuffer());
};

/** 按 three 语义重建 Deep 槽矩阵 [c*sx, -s*sy, tx, s*sx, c*sy, ty](行主序 2x3)。 */
function deepMatrix(slot: { readonly offset: readonly [number, number]; readonly scale: readonly [number, number];
  readonly rotation: number }): readonly number[] {
  const c = Math.cos(slot.rotation), s = Math.sin(slot.rotation);
  return [c * slot.scale[0], -s * slot.scale[1], slot.offset[0], s * slot.scale[0], c * slot.scale[1], slot.offset[1]];
}

describe("author texture transform", () => {
  const applyAndDecompose = (state: Parameters<typeof authorTextureTransform>[0]) => {
    const texture = new THREE.Texture();
    applyMaterialTextureTransform(texture, {
      repeatX: state.textureRepeatX ?? 1, repeatY: state.textureRepeatY ?? 1,
      offsetX: state.textureOffsetX ?? 0, offsetY: state.textureOffsetY ?? 0, rotation: state.textureRotation ?? 0,
    });
    texture.updateMatrix();
    const matrix = texture.matrix.elements;
    // three Matrix3 列主序;行主序 2x3 = [e0, e3, e6, e1, e4, e7]。
    return { three: [matrix[0]!, matrix[3]!, matrix[6]!, matrix[1]!, matrix[4]!, matrix[7]!] as const,
      slot: authorTextureTransform(state) };
  };

  it("keeps the default state neutral", () => {
    const { three, slot } = applyAndDecompose({});
    expect(slot).toEqual({ offset: [0, 0], scale: [1, 1], rotation: 0 });
    // -0 与 +0 在引擎 prepareTextureSlot 处归一,按数值比较。
    deepMatrix(slot).forEach((value, index) => expect(value).toBeCloseTo(three[index]!, 12));
  });

  it("reproduces the author canvas matrix for repeat, offset and rotation", () => {
    for (const rotation of [0, 0.35, -1.2, Math.PI / 3]) {
      const { three, slot } = applyAndDecompose({ textureRepeatX: 2, textureRepeatY: 2, textureOffsetX: 0.1,
        textureOffsetY: -0.2, textureRotation: rotation });
      const rebuilt = deepMatrix(slot);
      rebuilt.forEach((value, index) => expect(value).toBeCloseTo(three[index]!, 5));
    }
    // 各向异性重复(无旋转)可分解,与作者画布一致。
    const anisotropic = applyAndDecompose({ textureRepeatX: 2, textureRepeatY: 3, textureOffsetX: 0.05 });
    deepMatrix(anisotropic.slot).forEach((value, index) => expect(value).toBeCloseTo(anisotropic.three[index]!, 5));
  });

  it("fail-closes anisotropic repeat combined with rotation", () => {
    const attempt = (): unknown => authorTextureTransform({ textureRepeatX: 2, textureRepeatY: 3, textureRotation: 0.5 });
    expect(attempt).toThrow(/贴图 UV 变换/);
    let error: unknown;
    try { attempt(); } catch (reason) { error = reason; }
    expect((error as Error).name).toBe("SceneAppearanceUnsupported");
  });
});

describe("author metallicRoughness packing", () => {
  const image = (r: number, g: number, b: number): { width: 2; height: 2; data: Uint8Array } => ({
    width: 2, height: 2, data: new Uint8Array([r, g, b, 255, r, g, b, 255, r, g, b, 255, r, g, b, 255]) });

  it("packs roughness into G and metalness into B with scalar passthrough channels", () => {
    const packed = packAuthorMetallicRoughness(image(10, 90, 20), image(30, 40, 70))!;
    expect(packed.width).toBe(2);
    expect([...packed.data.slice(0, 4)]).toEqual([255, 90, 70, 255]);
  });

  it("defaults missing channels to 1 for scalar passthrough", () => {
    const roughOnly = packAuthorMetallicRoughness(image(0, 120, 0), undefined)!;
    expect([...roughOnly.data.slice(0, 4)]).toEqual([255, 120, 255, 255]);
    const metalOnly = packAuthorMetallicRoughness(undefined, image(0, 0, 60))!;
    expect([...metalOnly.data.slice(0, 4)]).toEqual([255, 255, 60, 255]);
    expect(packAuthorMetallicRoughness(undefined, undefined)).toBeUndefined();
  });

  it("rejects mismatched dimensions", () => {
    expect(() => packAuthorMetallicRoughness({ width: 2, height: 2, data: new Uint8Array(16) },
      { width: 4, height: 4, data: new Uint8Array(64) })).toThrow();
  });
});

describe("author texture resolver", () => {
  it("matches TextureLoader flipY for asymmetric images without mutating decoder bytes", async () => {
    const pixels = new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]);
    const instance = new AuthorTextureResolver({ loadTexture: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]),
      imageDecoder: { decode: async () => ({ width: 1, height: 2, data: pixels }) } }, undefined, new AbortController().signal);
    await instance.resolve("/asymmetric.png", "baseColor");
    expect(Array.from(instance.registered()[0]!.data)).toEqual([0, 0, 255, 255, 255, 0, 0, 255]);
    expect(Array.from(pixels)).toEqual([255, 0, 0, 255, 0, 0, 255, 255]);
  });
  const resolver = (loadTexture: (url: string) => Promise<Uint8Array<ArrayBuffer>>, budgetBytes?: number) =>
    new AuthorTextureResolver({ loadTexture: async (url, signal) => {
      signal.throwIfAborted();
      return loadTexture(url);
    }, imageDecoder: { decode: decodeWithSharp } }, budgetBytes, new AbortController().signal);

  it("decodes PNG bytes and deduplicates by url and semantic", async () => {
    const loadTexture = vi.fn(async () => png(8, 200));
    const instance = resolver(loadTexture);
    const baseId = await instance.resolve("/t/base.png", "baseColor");
    expect(baseId).toBe(authorTextureId("/t/base.png", "baseColor"));
    expect((await instance.resolve("/t/base.png", "baseColor"))).toBe(baseId);
    expect(loadTexture).toHaveBeenCalledTimes(1);
    // 同 URL 不同语义 = 独立纹理条目(GPU 格式随语义不同)。
    const occlusionId = await instance.resolve("/t/base.png", "occlusion");
    expect(occlusionId).not.toBe(baseId);
    expect(instance.registered()).toHaveLength(2);
    for (const texture of instance.registered()) {
      expect(texture.width).toBe(8);
      expect(texture.data.byteLength).toBe(8 * 8 * 4);
    }
  });

  it("fail-closes unsupported image formats", async () => {
    const instance = resolver(async () => new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]));
    await expect(instance.resolve("/t/tex.webp", "baseColor")).rejects.toThrow(/仅支持 PNG\/JPEG/);
  });

  it("downscales over-budget images on the same ladder as embedded GLB textures", async () => {
    // 1024²(4MB)在 512KB 预算下按梯子降到 256²(256KB);梯子按边长降采样,小图不受影响。
    const instance = resolver(async () => png(1024, 10), 512 * 1024);
    const id = await instance.resolve("/t/big.png", "baseColor");
    const texture = instance.registered().find(item => item.id === id)!;
    expect(texture.width).toBe(256);
  }, 30_000);

  it("throws SceneAppearanceUnsupported when even the coarsest rung exceeds the budget", async () => {
    const instance = resolver(async () => png(32, 10), 8);
    const error = await instance.resolve("/t/big.png", "baseColor").then(() => undefined, (reason: unknown) => reason);
    expect((error as Error).name).toBe("SceneAppearanceUnsupported");
    expect((error as Error).message).toMatch(/超出 Deep 纹理解码预算/);
  });
});

describe("ensureGeometryTangents", () => {
  const quad = (): { vertices: Float32Array<ArrayBuffer>; uv0: Float32Array<ArrayBuffer>; indices: Uint32Array<ArrayBuffer> } => ({
    vertices: new Float32Array([
      0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1,
    ]),
    uv0: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  });

  it("generates a unit tangent basis for a flat quad", () => {
    const upgraded = ensureGeometryTangents(quad(), "quad");
    expect(upgraded.tangents).toHaveLength(16);
    for (let vertex = 0; vertex < 4; vertex++) {
      const tangent = [upgraded.tangents![vertex * 4]!, upgraded.tangents![vertex * 4 + 1]!, upgraded.tangents![vertex * 4 + 2]!];
      expect(Math.hypot(...tangent)).toBeCloseTo(1, 5);
      expect(upgraded.tangents![vertex * 4 + 3]!).toBe(1);
    }
  });

  it("keeps existing tangents untouched", () => {
    const geometry = { ...quad(), tangents: new Float32Array(16) };
    expect(ensureGeometryTangents(geometry, "quad")).toBe(geometry);
  });

  it("refuses geometries without UV0 and mirrored UV charts", () => {
    const { uv0: _omitted, ...withoutUv } = quad();
    expect(() => ensureGeometryTangents(withoutUv, "no-uv")).toThrow(GltfImportError);
    const mirrored = quad();
    mirrored.uv0.set([0, 0, -1, 0, 1, 1, 0, 1]);
    expect(() => ensureGeometryTangents(mirrored, "mirrored")).toThrow(GltfImportError);
  });
});
