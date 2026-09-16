import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { meshletFixture, meshletPacket } from "./packetMeshlet.testUtils.js";
import { GpuGeometryResidencyUploader } from "./gpuGeometryResidencyUploader.js";
import { geometryGpuByteLength } from "../renderPacketGeometry.js";
import { PacketMeshletSource, prepareNaniteLiteCandidate } from "./packetMeshletSource.js";
import { prepareRenderPacket } from "../renderPacket.js";
import { createPacketResidencyLoader } from "./packetResidencyLoader.js";
import { authorView } from "./authorLod.testUtils.js";
beforeEach(() => { vi.stubGlobal("GPUBufferUsage", { COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256 }); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("loader leases reach the formal draw consumer without reupload on transform changes", async () => {
  vi.stubGlobal("GPUShaderStage", { COMPUTE: 4 }); vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 4 });
  const f = meshletFixture(), packet = meshletPacket(), loader = createPacketResidencyLoader(prepareRenderPacket(packet));
  const runtime = loader.createRuntime(f.session, { maxResidentBytes: 2 ** 24, maxUploadBytesPerFrame: 2 ** 24 }, { meshlets: true });
  await f.cache.stageResidentProjectionValidated(await loader.loadInto(runtime, { frame: 1 }));
  f.cache.publishResidentProjection();
  expect(f.cache.encodeLod(f.encoder, authorView).meshletPasses).toBe(2); f.cache.commitLodFrame();
  const uploads = f.writes.filter(write => /Deep vertices|Deep indices|packet meshlet/.test(write.label)).length;
  const transform = [...packet.instances[0]!.transform]; transform[12] = 2;
  f.cache.updateInstances({ materials: packet.materials, instances: [{ ...packet.instances[0]!, transform }] });
  expect(f.cache.encodeLod(f.encoder, authorView).meshletPasses).toBe(2); f.cache.commitLodFrame();
  expect(f.writes.filter(write => /Deep vertices|Deep indices|packet meshlet/.test(write.label))).toHaveLength(uploads);
  // A new domain can reload the same geometry revision into different GPU buffers.
  const replacement = loader.createRuntime(f.session, { maxResidentBytes: 2 ** 24, maxUploadBytesPerFrame: 2 ** 24 }, { meshlets: true });
  await f.cache.stageResidentProjectionValidated(await loader.loadInto(replacement, { frame: 2 }));
  f.cache.publishResidentProjection();
  expect(f.cache.encodeLod(f.encoder, authorView).meshletPasses).toBe(2); f.cache.commitLodFrame();
  runtime.dispose(); expect(f.owned.size).toBeGreaterThan(0);
  replacement.dispose(); f.cache.dispose(); expect(f.owned.size).toBe(0);
});
it("resident upload owns static meshlets through validation failure, retry and final lease release", async () => {
  const f = meshletFixture(), geometry = meshletPacket().geometries[0]!;
  const uploader = new GpuGeometryResidencyUploader(f.session, () => geometry, true);
  const request = { id: geometry.id, revision: geometry.revision, level: 0, kind: "geometry" as const,
    expectedByteLength: geometryGpuByteLength(geometry), signal: new AbortController().signal };
  f.device.popErrorScope.mockResolvedValueOnce({ message: "reject candidate" } as GPUError);
  await expect(uploader.upload(request)).rejects.toThrow("reject candidate");
  expect(f.owned.size).toBe(0);
  const result = await uploader.upload(request);
  expect(result.handle.mesh.meshletSource?.count).toBe(64);
  expect(result.byteLength).toBe(request.expectedByteLength);
  uploader.release(result.handle); uploader.release(result.handle); expect(f.owned.size).toBe(0);
});
it("meshlet budget includes live owners and recovers exactly once on disposal", () => {
  const f = meshletFixture(), geometry = meshletPacket().geometries[0]!;
  const amount = geometry.vertices.byteLength + geometry.indices.byteLength + 512 * 80;
  const budget = { remainingBytes: amount };
  const first = PacketMeshletSource.prepare(f.session, geometry, budget).source!;
  expect(budget.remainingBytes).toBe(0);
  expect(PacketMeshletSource.prepare(f.session, geometry, budget).fallback).toBe("stage-memory-budget");
  first.dispose(); first.dispose(); expect(budget.remainingBytes).toBe(amount);
  const next = PacketMeshletSource.prepare(f.session, geometry, budget).source!;
  expect(next.count).toBe(64); next.dispose(); expect(f.owned.size).toBe(0);
});
it("Nanite Lite candidate entry is bounded and returns an explicit complete fallback", () => {
  const f = meshletFixture(), geometry = meshletPacket().geometries[0]!;
  const result = prepareNaniteLiteCandidate(f.session, geometry, { remainingBytes: 64 });
  expect(result.source).toBeUndefined(); expect(result.fallback).toBe("stage-memory-budget");
  expect(f.owned.size).toBe(0);
});
