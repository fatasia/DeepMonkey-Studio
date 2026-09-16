import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimePackageLodInput } from "../../scripts/runtimePackageLodFixture.mjs";
import { buildDeepRuntimePackage } from "../runtimePackage/builder.js";
import { RuntimePackagePrewarmExecutor } from "../runtimePackage/prewarmExecutor.js";
import type { BuildDeepRuntimePackageInput } from "../runtimePackage/types.js";
import type { DeviceSession } from "./deviceSession.js";
import type { RuntimeSceneCamera } from "../runtimePackage/camera.js";
import { createRuntimePackageWebGpuPrewarmAdapter } from "./runtimePackagePrewarmAdapter.js";

function gpuFixture(onRelease?: () => void) {
  const owned = new Set<{ destroy(): void }>();
  const destroyable = () => ({ destroy: vi.fn() });
  const device = { lost: new Promise<void>(() => {}), features: new Set<GPUFeatureName>(),
    limits: { maxTextureDimension2D: 8192, maxBufferSize: 1_000_000 },
    pushErrorScope: vi.fn(), popErrorScope: vi.fn(() => Promise.resolve<GPUError | null>(null)),
    createBuffer: vi.fn(() => destroyable() as unknown as GPUBuffer),
    createTexture: vi.fn(() => ({ ...destroyable(), createView: vi.fn(() => ({})) }) as unknown as GPUTexture),
    createSampler: vi.fn(() => ({} as GPUSampler)),
    queue: { writeBuffer: vi.fn(), writeTexture: vi.fn() } };
  const session = { state: "ready", device,
    own<T extends { destroy(): void }>(resource: T): T { owned.add(resource); return resource; },
    release(resource: { destroy(): void }) {
      if (!owned.delete(resource)) return;
      resource.destroy(); onRelease?.();
    },
  } as unknown as DeviceSession;
  return { session, device, owned };
}

const runtime = (revision = 1) => {
  const input = createRuntimePackageLodInput() as BuildDeepRuntimePackageInput;
  return buildDeepRuntimePackage({ ...input, renderPacket: { ...input.renderPacket, revision } });
};

it("publishes camera and geometry together, retaining both when a replacement rejects", async () => {
  const fixture = gpuFixture();
  const camera: RuntimeSceneCamera = { schema: "deep-engine.scene-camera", schemaVersion: 1, id: "camera", revision: 1,
    position: [12, 8, 16], target: [0, 0, 0], verticalFovDegrees: 50, near: 0.05, far: 100000 };
  let reject = false;
  const publications: import("./runtimePackagePrewarmAdapter.js").RuntimePackageWebGpuRenderPublication[] = [];
  const adapter = createRuntimePackageWebGpuPrewarmAdapter({ session: fixture.session,
    budgets: { maxResidentBytes: 16_384, maxUploadBytesPerFrame: 16_384 }, nextFrame: () => 0,
    commit: (_plan, publication) => { if (reject) throw new Error("camera commit rejected"); publications.push(publication); },
  });
  const executor = new RuntimePackagePrewarmExecutor(adapter);
  const input = createRuntimePackageLodInput() as BuildDeepRuntimePackageInput;
  expect((await executor.publish(buildDeepRuntimePackage({ ...input, camera }))).status).toBe("committed");
  expect(publications[0]!.camera).toEqual(camera);
  expect(publications[0]!.projection.geometry("lod.high")).toBeDefined();
  const owned = fixture.owned.size;
  reject = true;
  const changed = { ...camera, revision: 2, position: [1, 2, 3] as const };
  expect((await executor.publish(buildDeepRuntimePackage({ ...input, camera: changed }))).status).toBe("failed");
  expect(publications).toHaveLength(1); expect(fixture.owned.size).toBe(owned);
  reject = false;
  expect((await executor.publish(buildDeepRuntimePackage({ ...input, camera: changed }))).status).toBe("committed");
  expect(publications[1]!.camera).toEqual(changed);
  expect((await executor.publish(runtime())).status).toBe("committed");
  expect(publications[2]!.camera).toBeNull();
  executor.dispose(); expect(fixture.owned.size).toBe(0);
});

beforeEach(() => {
  vi.stubGlobal("GPUBufferUsage", { VERTEX: 32, INDEX: 16, COPY_DST: 8 });
  vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 4, COPY_DST: 2 });
});
afterEach(() => vi.unstubAllGlobals());

describe("RuntimePackage Browser WebGPU prewarm adapter", () => {
  it("uploads baked LOD geometry and texture resources before atomically publishing the projection", async () => {
    const fixture = gpuFixture(), publications: unknown[] = [];
    const adapter = createRuntimePackageWebGpuPrewarmAdapter({ session: fixture.session,
      budgets: { maxResidentBytes: 16_384, maxUploadBytesPerFrame: 16_384 }, nextFrame: (() => { let frame = 0; return () => frame++; })(),
      commit: (_plan, publication) => { publications.push(publication); },
    });
    const executor = new RuntimePackagePrewarmExecutor(adapter);
    const result = await executor.publish(runtime());

    expect(result).toMatchObject({ status: "committed", loadedItems: 2, preparedItems: 2 });
    expect(publications).toHaveLength(1);
    expect(fixture.device.createBuffer).toHaveBeenCalled();
    expect(fixture.device.createTexture).toHaveBeenCalled();
    const publication = publications[0] as { baked: { batches: readonly { fallbackGeometry: string }[] };
      projection: { geometry(id: string): unknown; texture(id: string): unknown } };
    expect(publication.baked.batches.every(batch => batch.fallbackGeometry === "lod.low")).toBe(true);
    expect(publication.projection.geometry("lod.high")).toBeDefined();
    expect(publication.projection.texture("mask.grid")).toBeDefined();

    executor.dispose();
    expect(fixture.owned.size).toBe(0);
  });

  it("rolls back staged Browser GPU resources when atomic publication rejects", async () => {
    const fixture = gpuFixture();
    const adapter = createRuntimePackageWebGpuPrewarmAdapter({ session: fixture.session,
      budgets: { maxResidentBytes: 16_384, maxUploadBytesPerFrame: 16_384 }, nextFrame: () => 0,
      commit: () => { throw new Error("publish rejected"); },
    });
    const result = await new RuntimePackagePrewarmExecutor(adapter).publish(runtime());

    expect(result).toMatchObject({ status: "failed", failure: "publish rejected", releasedItems: 2 });
    expect(fixture.owned.size).toBe(0);
  });

  it("attempts every GPU cleanup step even when one resource release fails", async () => {
    let failOnce = true;
    const fixture = gpuFixture(() => {
      if (failOnce) { failOnce = false; throw new Error("release failed"); }
    });
    const adapter = createRuntimePackageWebGpuPrewarmAdapter({ session: fixture.session,
      budgets: { maxResidentBytes: 16_384, maxUploadBytesPerFrame: 16_384 }, nextFrame: () => 0,
      commit: () => { throw new Error("publish rejected"); },
    });
    const result = await new RuntimePackagePrewarmExecutor(adapter).publish(runtime());

    expect(result).toMatchObject({ status: "failed", failure: "publish rejected", releasedItems: 2,
      releaseFailures: ["Runtime package Browser render prewarm release failed."] });
    expect(fixture.owned.size).toBe(0);
  });

  it("reloads a render projection when bake identity changes and publishes the current logical revision", async () => {
    const fixture = gpuFixture();
    const publications: Array<{ item: { revision: number }; projection: unknown }> = [];
    const adapter = createRuntimePackageWebGpuPrewarmAdapter({ session: fixture.session,
      budgets: { maxResidentBytes: 16_384, maxUploadBytesPerFrame: 16_384 },
      nextFrame: (() => { let frame = 0; return () => frame++; })(),
      commit: (_plan, publication) => { publications.push(publication); },
    });
    const executor = new RuntimePackagePrewarmExecutor(adapter);
    expect(await executor.publish(runtime(1))).toMatchObject({ status: "committed", loadedItems: 2 });
    const firstProjection = publications[0]!.projection;
    const uploadCount = fixture.device.createBuffer.mock.calls.length;

    expect(await executor.publish(runtime(2))).toMatchObject({ status: "committed", loadedItems: 0, reusedItems: 2 });
    expect(publications[1]).toMatchObject({ item: { revision: 2 }, projection: firstProjection });
    expect(await executor.publish(runtime(2), { bakeQuality: "quality" })).toMatchObject({ status: "committed",
      loadedItems: 1, reusedItems: 1, releasedItems: 1 });
    expect(fixture.device.createBuffer.mock.calls.length).toBeGreaterThan(uploadCount);
    expect(publications[2]!.projection).not.toBe(firstProjection);

    executor.dispose();
    expect(fixture.owned.size).toBe(0);
  });
});
