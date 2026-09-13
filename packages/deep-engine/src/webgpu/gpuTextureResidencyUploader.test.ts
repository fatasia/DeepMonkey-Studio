import { describe, expect, it, vi } from "vitest";
import type { DecodedTexture, PreparedTexture } from "../textures/decodedTexture.js";
import type { DeviceSession } from "./deviceSession.js";
import { GpuTextureResidencyUploader } from "./gpuTextureResidencyUploader.js";

const sampler = Object.freeze({ addressModeU: "repeat", addressModeV: "repeat", magFilter: "linear",
  minFilter: "linear", mipmapFilter: "linear", maxAnisotropy: 1 } as const);

function prepared(overrides: Partial<PreparedTexture> = {}): PreparedTexture {
  const levels = overrides.levels ?? [
    { width: 2, height: 2, bytesPerRow: 8, byteLength: 16, data: new Uint8Array(16) },
    { width: 1, height: 1, bytesPerRow: 4, byteLength: 4, data: new Uint8Array(4) },
  ];
  return { id: "texture", revision: 3, semantic: "baseColor", format: "rgba8unorm-srgb",
    levels, sampler, samplerKey: "linear", byteLength: levels.reduce((sum, mip) => sum + mip.byteLength, 0),
    ...overrides };
}

function request(overrides: Partial<{
  id: string; revision: number; level: number; kind: "geometry" | "texture";
  expectedByteLength: number; signal: AbortSignal;
}> = {}) {
  return { id: "texture", revision: 3, level: 1, kind: "texture" as const,
    expectedByteLength: 20, signal: new AbortController().signal, ...overrides };
}

function source(texture: PreparedTexture | DecodedTexture = prepared(), level = 1) {
  return { level, texture };
}

function fixture() {
  const owned = new Set<object>();
  const controls: { viewError?: Error; samplerError?: Error } = {};
  const textures: Array<{ descriptor: GPUTextureDescriptor; destroy: ReturnType<typeof vi.fn>;
    createView: ReturnType<typeof vi.fn> }> = [];
  const device = {
    features: new Set<GPUFeatureName>(), limits: { maxTextureDimension2D: 4096 },
    createTexture: vi.fn((descriptor: GPUTextureDescriptor) => {
      const texture = { descriptor, destroy: vi.fn(), createView: vi.fn(() => {
        if (controls.viewError) throw controls.viewError;
        return Object.freeze({ texture: descriptor.label });
      }) };
      textures.push(texture); return texture as unknown as GPUTexture;
    }),
    createSampler: vi.fn((descriptor: GPUSamplerDescriptor) => {
      if (controls.samplerError) throw controls.samplerError;
      return Object.freeze({ descriptor }) as unknown as GPUSampler;
    }),
    pushErrorScope: vi.fn(), popErrorScope: vi.fn(async () => null as GPUError | null),
    queue: { writeTexture: vi.fn() },
  };
  const session = { state: "ready", device,
    own<T extends { destroy(): void }>(resource: T): T { owned.add(resource); return resource; },
    release(resource: { destroy(): void }): void { if (owned.delete(resource)) resource.destroy(); },
  } as unknown as DeviceSession;
  return { controls, device, owned, session, textures };
}

describe("GpuTextureResidencyUploader", () => {
  it("uploads one prepared texture LOD with its complete mip chain and session ownership", async () => {
    vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 4, COPY_DST: 2 });
    try {
      const f = fixture(), texture = prepared();
      const uploader = new GpuTextureResidencyUploader(f.session, () => source(texture), 16);
      const result = await uploader.upload(request());
      expect(f.device.createTexture).toHaveBeenCalledWith({
        label: "Deep streamed texture texture LOD 1",
        size: { width: 2, height: 2, depthOrArrayLayers: 1 }, format: "rgba8unorm-srgb",
        mipLevelCount: 2, dimension: "2d", usage: 18,
      });
      expect(f.device.queue.writeTexture).toHaveBeenNthCalledWith(1,
        { texture: result.handle.texture, mipLevel: 0 }, texture.levels[0]!.data,
        { bytesPerRow: 8, rowsPerImage: 2 }, { width: 2, height: 2, depthOrArrayLayers: 1 });
      expect(f.device.queue.writeTexture).toHaveBeenNthCalledWith(2,
        { texture: result.handle.texture, mipLevel: 1 }, texture.levels[1]!.data,
        { bytesPerRow: 4, rowsPerImage: 1 }, { width: 1, height: 1, depthOrArrayLayers: 1 });
      expect(f.device.createSampler).toHaveBeenCalledWith({ label: "Deep streamed sampler texture",
        ...sampler, lodMinClamp: 0, lodMaxClamp: 1 });
      expect(result).toMatchObject({ byteLength: 20, handle: { kind: "texture", id: "texture", revision: 3, level: 1,
        byteLength: 20, semantic: "baseColor", format: "rgba8unorm-srgb", width: 2, height: 2,
        mipLevelCount: 2 } });
      expect(Object.isFrozen(result.handle)).toBe(true); expect(f.owned.has(result.handle.texture)).toBe(true);
      uploader.release(result.handle); uploader.release(result.handle);
      expect(f.textures[0]!.destroy).toHaveBeenCalledOnce(); expect(f.owned.size).toBe(0);
    } finally { vi.unstubAllGlobals(); }
  });

  it("prepares a decoded texture and preserves the request revision and LOD metadata", async () => {
    vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 4, COPY_DST: 2 });
    try {
      const f = fixture();
      const decoded: DecodedTexture = { id: "texture", revision: 3, semantic: "baseColor",
        width: 2, height: 1, data: new Uint8Array(8), sampler: { addressModeU: "clamp-to-edge" } };
      const uploader = new GpuTextureResidencyUploader(f.session, async () => source(decoded, 4));
      const result = await uploader.upload(request({ level: 4, expectedByteLength: 8 }));
      expect(result.handle).toMatchObject({ level: 4, format: "rgba8unorm-srgb", width: 2,
        height: 1, mipLevelCount: 1 });
      expect(f.device.queue.writeTexture).toHaveBeenCalledWith(expect.anything(), expect.any(Uint8Array),
        { bytesPerRow: 8, rowsPerImage: 1 }, { width: 2, height: 1, depthOrArrayLayers: 1 });
      uploader.release(result.handle);
    } finally { vi.unstubAllGlobals(); }
  });

  it("rejects kind, identity and planned byte mismatches before allocating GPU memory", async () => {
    vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 4, COPY_DST: 2 });
    try {
      const f = fixture(), provider = vi.fn(() => source());
      const uploader = new GpuTextureResidencyUploader(f.session, provider);
      await expect(uploader.upload(request({ kind: "geometry" }))).rejects.toThrow("non-texture");
      expect(provider).not.toHaveBeenCalled();
      await expect(uploader.upload(request({ id: "other" }))).rejects.toThrow("identity differs");
      await expect(uploader.upload(request({ expectedByteLength: 19 }))).rejects.toThrow("differs from plan");
      expect(f.device.createTexture).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it("hard-rejects a same-byte source from the wrong LOD before GPU allocation", async () => {
    vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 4, COPY_DST: 2 });
    try {
      const f = fixture(), texture = prepared();
      const uploader = new GpuTextureResidencyUploader(f.session, () => source(texture, 0));
      await expect(uploader.upload(request({ level: 1, expectedByteLength: texture.byteLength })))
        .rejects.toThrow("source level differs from request");
      expect(f.device.createTexture).not.toHaveBeenCalled();
      expect(f.device.pushErrorScope).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it("validates compressed formats, required device features and dimensions before allocation", async () => {
    vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 4, COPY_DST: 2 });
    try {
      const compressed = prepared({ format: "bc1-rgba-unorm-srgb", requiredFeature: "texture-compression-bc",
        levels: [{ width: 4, height: 4, bytesPerRow: 8, byteLength: 8, data: new Uint8Array(8) }], byteLength: 8 });
      const f = fixture();
      const invalidSemantic = { ...prepared(), semantic: "height" } as unknown as PreparedTexture;
      await expect(new GpuTextureResidencyUploader(f.session, () => source(invalidSemantic))
        .upload(request())).rejects.toThrow("semantic");
      const invalidSampler = { ...prepared(), sampler: { ...sampler, maxAnisotropy: 2,
        minFilter: "nearest" as const } };
      await expect(new GpuTextureResidencyUploader(f.session, () => source(invalidSampler))
        .upload(request())).rejects.toThrow("sampler");
      await expect(new GpuTextureResidencyUploader(f.session, () => source(compressed))
        .upload(request({ expectedByteLength: 8 }))).rejects.toThrow("unavailable device feature");
      const mislabeled = { ...compressed, requiredFeature: "texture-compression-etc2" } as PreparedTexture;
      await expect(new GpuTextureResidencyUploader(f.session, () => source(mislabeled))
        .upload(request({ expectedByteLength: 8 }))).rejects.toThrow("feature declaration");
      f.device.features.add("texture-compression-bc");
      const result = await new GpuTextureResidencyUploader(f.session, () => source(compressed))
        .upload(request({ expectedByteLength: 8 }));
      expect(result.handle.requiredFeature).toBe("texture-compression-bc");
      expect(f.device.queue.writeTexture).toHaveBeenLastCalledWith(expect.anything(), expect.any(Uint8Array),
        { bytesPerRow: 8, rowsPerImage: 1 }, { width: 4, height: 4, depthOrArrayLayers: 1 });
      new GpuTextureResidencyUploader(f.session, () => source(compressed)).release(result.handle);
      f.device.limits.maxTextureDimension2D = 1;
      await expect(new GpuTextureResidencyUploader(f.session, () => source())
        .upload(request())).rejects.toThrow("dimension limit");
      expect(f.device.createTexture).toHaveBeenCalledTimes(1);
    } finally { vi.unstubAllGlobals(); }
  });

  it("releases the texture when cancellation arrives during queue upload", async () => {
    vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 4, COPY_DST: 2 });
    try {
      const f = fixture(), controller = new AbortController();
      f.device.queue.writeTexture.mockImplementationOnce(() => controller.abort());
      const uploader = new GpuTextureResidencyUploader(f.session, () => source());
      await expect(uploader.upload(request({ signal: controller.signal }))).rejects.toMatchObject({ name: "AbortError" });
      expect(f.textures[0]!.destroy).toHaveBeenCalledOnce(); expect(f.owned.size).toBe(0);
      expect(f.device.createSampler).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it.each(["write", "view", "sampler"] as const)("releases the texture after a %s failure", async failure => {
    vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 4, COPY_DST: 2 });
    try {
      const f = fixture();
      if (failure === "write") f.device.queue.writeTexture.mockImplementationOnce(() => { throw new Error("write failed"); });
      if (failure === "view") f.controls.viewError = new Error("view failed");
      if (failure === "sampler") f.controls.samplerError = new Error("sampler failed");
      const uploader = new GpuTextureResidencyUploader(f.session, () => source());
      await expect(uploader.upload(request())).rejects.toThrow(`${failure} failed`);
      expect(f.textures[0]!.destroy).toHaveBeenCalledOnce(); expect(f.owned.size).toBe(0);
    } finally { vi.unstubAllGlobals(); }
  });

  it("waits for GPU error scopes and releases a driver-rejected texture", async () => {
    vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 4, COPY_DST: 2 });
    try {
      const f = fixture();
      f.device.popErrorScope.mockResolvedValueOnce({ message: "invalid compressed copy" } as GPUError);
      const uploader = new GpuTextureResidencyUploader(f.session, () => source());
      await expect(uploader.upload(request())).rejects.toThrow("GPU texture residency upload failed: invalid compressed copy");
      expect(f.device.pushErrorScope.mock.calls.map(call => call[0])).toEqual(["validation", "out-of-memory", "internal"]);
      expect(f.device.popErrorScope).toHaveBeenCalledTimes(3);
      expect(f.textures[0]!.destroy).toHaveBeenCalledOnce(); expect(f.owned.size).toBe(0);
    } finally { vi.unstubAllGlobals(); }
  });

  it("does no source or GPU work for an already-cancelled request", async () => {
    vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 4, COPY_DST: 2 });
    try {
      const f = fixture(), provider = vi.fn(() => source()), controller = new AbortController(); controller.abort();
      const uploader = new GpuTextureResidencyUploader(f.session, provider);
      await expect(uploader.upload(request({ signal: controller.signal }))).rejects.toMatchObject({ name: "AbortError" });
      expect(provider).not.toHaveBeenCalled(); expect(f.device.createTexture).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it("honors cancellation that arrives while the source provider is pending", async () => {
    vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 4, COPY_DST: 2 });
    try {
      const f = fixture(), controller = new AbortController();
      let resolve!: (value: PreparedTexture) => void;
      const pending = new Promise<ReturnType<typeof source>>(done => { resolve = value => done(source(value)); });
      const uploader = new GpuTextureResidencyUploader(f.session, () => pending);
      const upload = uploader.upload(request({ signal: controller.signal }));
      controller.abort(); resolve(prepared());
      await expect(upload).rejects.toMatchObject({ name: "AbortError" });
      expect(f.device.createTexture).not.toHaveBeenCalled(); expect(f.owned.size).toBe(0);
    } finally { vi.unstubAllGlobals(); }
  });
});
