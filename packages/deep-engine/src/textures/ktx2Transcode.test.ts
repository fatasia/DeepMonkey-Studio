import { describe, expect, it, vi } from "vitest";
import { prepareTextures } from "./decodedTexture.js";
import {
  inspectKtx2Container,
  selectKtx2TranscodeTarget,
  transcodeKtx2Texture,
  type EncodedKtx2Texture,
  type Ktx2TranscodeResult,
  type Ktx2Transcoder,
} from "./ktx2Transcode.js";

function ktx2(profile: "uastc" | "etc1s" = "uastc", width = 4, height = 4, hasAlpha = true, levelCount = 1): Uint8Array<ArrayBuffer> {
  const sampleCount = profile === "etc1s" && hasAlpha ? 2 : 1, totalSize = 28 + sampleCount * 16;
  const dfdOffset = 80 + levelCount * 24, data = new Uint8Array(dfdOffset + totalSize), view = new DataView(data.buffer);
  data.set([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
  view.setUint32(20, width, true); view.setUint32(24, height, true);
  view.setUint32(36, 1, true); view.setUint32(40, levelCount, true);
  view.setUint32(48, dfdOffset, true); view.setUint32(52, totalSize, true);
  view.setUint32(dfdOffset, totalSize, true); view.setUint16(dfdOffset + 8, 2, true);
  view.setUint16(dfdOffset + 10, totalSize - 4, true); view.setUint8(dfdOffset + 12, profile === "uastc" ? 166 : 163);
  view.setUint8(dfdOffset + 31, profile === "uastc" && hasAlpha ? 3 : 0);
  return data;
}

const source = (changes: Partial<EncodedKtx2Texture> = {}): EncodedKtx2Texture => ({
  id: "asset/base", revision: 3, semantic: "baseColor", data: ktx2(),
  hasAlpha: true, sourceProfile: "uastc", ...changes,
});
const bc7 = (data = new Uint8Array(16).fill(7)): Ktx2TranscodeResult => ({
  target: "bc7-rgba", levels: [{ width: 4, height: 4, data }],
});

describe("KTX2 transcode boundary", () => {
  it("inspects bounded 2D container metadata and Basis source profile", () => {
    expect(inspectKtx2Container(ktx2("uastc", 8, 12))).toEqual({ width: 8, height: 12, levelCount: 1, sourceProfile: "uastc", hasAlpha: true });
    expect(inspectKtx2Container(ktx2("etc1s"))).toMatchObject({ sourceProfile: "etc1s", hasAlpha: true });
    expect(inspectKtx2Container(ktx2("etc1s", 4, 4, false))).toMatchObject({ sourceProfile: "etc1s", hasAlpha: false });
    expect(() => inspectKtx2Container(new Uint8Array(12))).toThrow("truncated");
    const cube = ktx2(); new DataView(cube.buffer).setUint32(36, 6, true);
    expect(() => inspectKtx2Container(cube)).toThrow("2D");
  });

  it("selects a quality-first portable target without silently dropping alpha", () => {
    expect(selectKtx2TranscodeTarget(["texture-compression-astc", "texture-compression-bc"], true, "quality", "uastc")).toBe("astc-4x4-rgba");
    expect(selectKtx2TranscodeTarget(["texture-compression-astc", "texture-compression-etc2"], true, "quality", "etc1s")).toBe("etc2-rgba8");
    expect(selectKtx2TranscodeTarget(["texture-compression-astc"], true, "quality", "unknown")).toBe("rgba8");
    expect(selectKtx2TranscodeTarget(["texture-compression-bc"], true, "memory")).toBe("bc7-rgba");
    expect(selectKtx2TranscodeTarget(["texture-compression-bc"], false, "memory")).toBe("bc1-rgba");
    expect(selectKtx2TranscodeTarget(["texture-compression-etc2"], true, "quality", "unknown")).toBe("etc2-rgba8");
    expect(selectKtx2TranscodeTarget([], true)).toBe("rgba8");
    expect(() => selectKtx2TranscodeTarget(["timestamp-query" as never], true)).toThrow("Unknown");
  });

  it("passes owned KTX2 bytes and semantic intent, then owns validated GPU blocks", async () => {
    const authorSampler = { addressModeU: "clamp-to-edge" as const };
    const encoded = source({ sampler: authorSampler }), original = encoded.data.slice();
    const output = new Uint8Array(16).fill(7), seen: number[][] = [];
    const transcode = vi.fn(async (data: Uint8Array<ArrayBuffer>, request: unknown) => {
      seen.push([...data]);
      expect(request).toEqual({ target: "bc7-rgba", sourceProfile: "uastc", hasAlpha: true, colorSpace: "srgb" });
      return bc7(output);
    });
    const pending = transcodeKtx2Texture(encoded, { transcode }, { supportedFeatures: ["texture-compression-bc"] });
    encoded.data.fill(0);
    (encoded as { id: string }).id = "mutated";
    authorSampler.addressModeU = "repeat" as "clamp-to-edge";
    const texture = await pending;
    output.fill(0);
    expect(seen).toEqual([[...original]]);
    expect(texture).toMatchObject({ id: "asset/base", revision: 3, semantic: "baseColor", width: 4, height: 4, compression: "bc7-rgba" });
    expect(texture.sampler?.addressModeU).toBe("clamp-to-edge");
    expect(texture.data).toEqual(new Uint8Array(16).fill(7));
    expect(prepareTextures([texture])[0]!.format).toBe("bc7-rgba-unorm-srgb");
  });

  it("accepts RGBA fallback and a complete mip chain", async () => {
    const result: Ktx2TranscodeResult = { target: "rgba8", levels: [
      { width: 2, height: 2, data: new Uint8Array(16).fill(3) },
      { width: 1, height: 1, data: new Uint8Array(4).fill(4) },
    ] };
    const texture = await transcodeKtx2Texture(source({ semantic: "normal", hasAlpha: false, data: ktx2("uastc", 2, 2, false, 2) }),
      { transcode: async (_data, request) => { expect(request.colorSpace).toBe("linear"); return result; } });
    expect(texture.compression).toBeUndefined();
    expect(texture.mipmaps).toHaveLength(1);
    expect(prepareTextures([texture])[0]!.format).toBe("rgba8unorm");
  });

  it("uses inspected UASTC for ASTC and falls back to RGBA8 when block dimensions are unsafe", async () => {
    const astc = await transcodeKtx2Texture(source({ sourceProfile: "unknown" }), {
      transcode: async (_data, received) => ({ target: received.target, levels: [{ width: 4, height: 4, data: new Uint8Array(16) }] }),
    }, { supportedFeatures: ["texture-compression-astc"] });
    expect(astc.compression).toBe("astc-4x4-rgba");
    const requests: string[] = [];
    const rgba = await transcodeKtx2Texture(source({ sourceProfile: "unknown", data: ktx2("uastc", 6, 5) }), {
      transcode: async (_data, received) => {
        requests.push(received.target);
        return { target: received.target, levels: [{ width: 6, height: 5, data: new Uint8Array(6 * 5 * 4) }] };
      },
    }, { supportedFeatures: ["texture-compression-bc"] });
    expect(requests).toEqual(["rgba8"]); expect(rgba.compression).toBeUndefined();
  });

  it("uses DFD alpha metadata for the memory-first BC1 target without discarding alpha", async () => {
    const targets: string[] = [];
    const texture = await transcodeKtx2Texture(source({ hasAlpha: true, sourceProfile: "unknown", data: ktx2("etc1s", 4, 4, false) }), {
      transcode: async (_data, received) => {
        targets.push(received.target);
        return { target: received.target, levels: [{ width: 4, height: 4, data: new Uint8Array(8) }] };
      },
    }, { preference: "memory", supportedFeatures: ["texture-compression-bc"] });
    expect(targets).toEqual(["bc1-rgba"]); expect(texture.compression).toBe("bc1-rgba");
    await expect(transcodeKtx2Texture(source({ hasAlpha: false, data: ktx2("uastc", 4, 4, true) }), {
      transcode: async () => { throw new Error("unreachable"); },
    })).rejects.toThrow("alpha cannot be discarded");
  });

  it("rejects backend target drift, malformed levels and byte-limit violations", async () => {
    await expect(transcodeKtx2Texture(source(), { transcode: async () => ({ ...bc7(), target: "rgba8" }) },
      { supportedFeatures: ["texture-compression-bc"] })).rejects.toThrow("honor");
    await expect(transcodeKtx2Texture(source(), { transcode: async () => ({ target: "rgba8", levels: [] }) }))
      .rejects.toThrow("no mip");
    await expect(transcodeKtx2Texture(source(), { transcode: async () => ({ target: "rgba8", levels: [
      { width: 2, height: 2, data: new Uint8Array(16) },
    ] }) })).rejects.toThrow("dimensions");
    await expect(transcodeKtx2Texture(source(), { transcode: async () => bc7(new Uint8Array(15)) },
      { supportedFeatures: ["texture-compression-bc"] })).rejects.toThrow("row layout");
    await expect(transcodeKtx2Texture(source(), { transcode: async () => bc7() }, { maxSourceBytes: 3 }))
      .rejects.toThrow("source byte budget");
  });

  it("fails before backend work for malformed or pre-aborted input", async () => {
    const backend: Ktx2Transcoder = { transcode: vi.fn(async () => bc7()) };
    await expect(transcodeKtx2Texture(source({ data: new Uint8Array(new SharedArrayBuffer(4)) }), backend)).rejects.toThrow("owned");
    await expect(transcodeKtx2Texture(source({ sourceProfile: "etc1s" }), backend)).rejects.toThrow("profile");
    await expect(transcodeKtx2Texture(source({ data: ktx2("uastc", 8, 8) }), backend, { maxDimension: 4 }))
      .rejects.toThrow("dimensions exceed");
    const controller = new AbortController(); controller.abort(new DOMException("stop", "AbortError"));
    await expect(transcodeKtx2Texture(source(), backend, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(backend.transcode).not.toHaveBeenCalled();
  });

  it("settles promptly when an injected backend ignores cancellation", async () => {
    const controller = new AbortController();
    let resolve!: (value: Ktx2TranscodeResult) => void;
    const late = new Promise<Ktx2TranscodeResult>(done => { resolve = done; });
    const pending = transcodeKtx2Texture(source(), { transcode: () => late }, {
      supportedFeatures: ["texture-compression-bc"], signal: controller.signal,
    });
    await vi.waitFor(() => expect(controller.signal.aborted).toBe(false));
    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    resolve(bc7()); await Promise.resolve();
  });
});
