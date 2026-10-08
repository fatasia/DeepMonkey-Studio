import { afterEach, beforeEach, expect, it, vi } from "vitest";

const codecs = vi.hoisted(() => ({
  encoder: vi.fn(async () => ({ codec: "encoder" })),
  decoder: vi.fn(async () => ({ codec: "decoder" })),
  meshoptImport: vi.fn(),
}));
vi.mock("draco3dgltf", () => ({ default: {
  createEncoderModule: codecs.encoder, createDecoderModule: codecs.decoder,
} }));
vi.mock("meshoptimizer", () => {
  codecs.meshoptImport();
  return { MeshoptDecoder: { ready: Promise.resolve(), codec: "meshopt" } };
});

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1, 2]))));
});
afterEach(() => vi.unstubAllGlobals());

it("creates only one Draco decoder for repeated decompression and never loads encoder or Meshopt", async () => {
  const { modelDecoderIO } = await import("./modelOptimizerIO");
  const first = modelDecoderIO(false), second = modelDecoderIO(false);
  expect(await first).toBe(await second);
  expect(codecs.decoder).toHaveBeenCalledOnce();
  expect(codecs.encoder).not.toHaveBeenCalled(); expect(codecs.meshoptImport).not.toHaveBeenCalled();
  expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual(["/draco/draco_decoder_gltf.wasm"]);
});

it("loads Meshopt only when declared and shares the decoder with full optimizer compression", async () => {
  const { modelDecoderIO, optimizerIO } = await import("./modelOptimizerIO");
  await modelDecoderIO(false); await modelDecoderIO(true); await optimizerIO(); await optimizerIO();
  expect(codecs.decoder).toHaveBeenCalledOnce(); expect(codecs.encoder).toHaveBeenCalledOnce();
  expect(codecs.meshoptImport).toHaveBeenCalledOnce();
  expect(vi.mocked(fetch).mock.calls.map(([url]) => url))
    .toEqual(["/draco/draco_decoder_gltf.wasm", "/draco/draco_encoder.wasm"]);
});

it("evicts a rejected decoder and retries without loading an encoder", async () => {
  codecs.decoder.mockRejectedValueOnce(new Error("decoder allocation failed"));
  const { modelDecoderIO } = await import("./modelOptimizerIO");
  await expect(modelDecoderIO(false)).rejects.toThrow("decoder allocation failed");
  await expect(modelDecoderIO(false)).resolves.toBeDefined();
  expect(codecs.decoder).toHaveBeenCalledTimes(2); expect(codecs.encoder).not.toHaveBeenCalled();
});

it("rejects an unsuccessful asset fetch before instantiating any codec", async () => {
  vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 503 }));
  const { modelDecoderIO } = await import("./modelOptimizerIO");
  await expect(modelDecoderIO(false)).rejects.toThrow("Draco 资源加载失败");
  expect(codecs.decoder).not.toHaveBeenCalled(); expect(codecs.encoder).not.toHaveBeenCalled();
});
