import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { bridge, mesh } from "./testFixture.js";
import type { InstanceUpdate, RenderPacket } from "../renderPacket.js";
import type { FrameMetrics, RenderView } from "../webgpu/pbrRenderer.js";
import { DeepWebGpuBackend, type DeepWebGpuRenderRuntime,
  type DeepWebGpuRuntimeFactory } from "./DeepWebGpuBackend.js";
import { BackendSwitchCoordinator, type SwitchableBackend } from "../backendSwitch.js";
import { CASCADED_SHADOW_QUALITY_PROFILES } from "../shadows/shadowQuality.js";

const view: RenderView = { width: 100, height: 50, pixelRatio: 1, eye: [0, 0, 4], target: [0, 0, 0],
  extent: 2, background: [0, 0, 0], floor: [0, 0, 0], exposure: 1, roughness: 0.5 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function runtime(shadowTier = "high", shadowDepthBytes = 64 * 1024 * 1024):
DeepWebGpuRenderRuntime & { packets: RenderPacket[]; updates: InstanceUpdate[] } {
  const packets: RenderPacket[] = [], updates: InstanceUpdate[] = [];
  return {
    id: "deep-webgpu",
    packets,
    updates,
    setPacketValidated: vi.fn(async (packet: RenderPacket) => { packets.push(packet); }),
    updateInstances: vi.fn((update: InstanceUpdate) => { updates.push(update); }),
    render: vi.fn((_view: RenderView): FrameMetrics | undefined => undefined),
    validateFrame: vi.fn(async (_view: RenderView): Promise<FrameMetrics> =>
      ({ frame: 1, shadowTier, shadowDepthBytes } as FrameMetrics)),
    dispose: vi.fn(),
  };
}

describe("DeepWebGpuBackend", () => {
  it("commits a full projection, then transform-only instance updates", async () => {
    const target = runtime(), backend = new DeepWebGpuBackend(target, bridge()), author = mesh();
    const first = await backend.sync(author);
    expect(first.status).toBe("committed");
    expect(first.update).toBe("full");
    expect(target.packets).toHaveLength(1);
    author.position.x = 4;
    author.updateWorldMatrix(true, true);
    const second = await backend.sync(author);
    expect(second).toMatchObject({ status: "committed", update: "instances" });
    expect(target.updates).toHaveLength(1);
    expect(target.packets).toHaveLength(1);
    expect(target.updates[0]!.instances[0]!.transform[12]).toBe(4);
  });

  it("rejects unsupported author features before touching GPU state", async () => {
    const target = runtime(), backend = new DeepWebGpuBackend(target, bridge());
    const author = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    author.updateWorldMatrix(true, true);
    const result = await backend.sync(author);
    expect(result.status).toBe("rejected");
    expect(target.packets).toHaveLength(0);
    expect(target.updates).toHaveLength(0);
  });

  it("reports an older asynchronous full projection as superseded", async () => {
    const gate = deferred<void>(), target = runtime(), projection = bridge();
    target.setPacketValidated = vi.fn(async () => gate.promise);
    const backend = new DeepWebGpuBackend(target, projection), first = mesh(), second = mesh();
    first.updateWorldMatrix(true, true);
    second.updateWorldMatrix(true, true);
    const oldSync = backend.sync(first);
    projection.project(second, { cameraLayerMask: 1 });
    gate.resolve();
    await expect(oldSync).resolves.toMatchObject({ status: "superseded", update: "full" });
  });

  it("publishes switch candidates only after a projected GPU frame validates", async () => {
    const target = runtime(), backend = new DeepWebGpuBackend(target, bridge()), author = mesh();
    const frame = await backend.prepareScene(author, view);
    expect(frame.frame).toBe(1);
    expect(target.setPacketValidated).toHaveBeenCalledTimes(1);
    expect(target.validateFrame).toHaveBeenCalledWith(view);
    expect(backend.shadowSelection).toEqual({ selectedTier: "high", estimatedDepthTextureBytes: 64 * 1024 * 1024 });
  });

  it("creates the PBR runtime from a frozen renderer-settings snapshot", async () => {
    const target = runtime("performance", 8 * 1024 * 1024), createRuntime = vi.fn(async () => target);
    const factory: DeepWebGpuRuntimeFactory = { create: createRuntime };
    const renderer = { shadows: { requestedTier: "performance" as const, maxDepthTextureBytes: 16 * 1024 * 1024 } };
    const preparing = DeepWebGpuBackend.create({ canvas: {} as HTMLCanvasElement, gpu: {} as GPU,
      projection: bridge(), root: mesh(), view, renderer }, factory);
    renderer.shadows.maxDepthTextureBytes = 32 * 1024 * 1024;
    const backend = await preparing;
    const supplied = createRuntime.mock.calls[0]![3]!;
    expect(supplied).toEqual({ shadows: { requestedTier: "performance", maxDepthTextureBytes: 16 * 1024 * 1024 } });
    expect(Object.isFrozen(supplied)).toBe(true); expect(Object.isFrozen(supplied.shadows)).toBe(true);
    expect(backend.shadowSelection).toEqual({ selectedTier: "performance", estimatedDepthTextureBytes: 8 * 1024 * 1024 });
  });

  it("keeps the legacy high-quality default when creation options are omitted", async () => {
    const target = runtime(), createRuntime = vi.fn(async () => target);
    const backend = await DeepWebGpuBackend.create({ canvas: {} as HTMLCanvasElement, gpu: undefined,
      projection: bridge(), root: mesh(), view }, { create: createRuntime });
    expect(createRuntime.mock.calls[0]![3]).toEqual({});
    expect(backend.shadowSelection?.selectedTier).toBe("high");
  });

  it("snapshots feature and environment policy for a bridge-created runtime", async () => {
    const target = runtime(), createRuntime = vi.fn(async () => target);
    const backend = await DeepWebGpuBackend.create({ canvas: {} as HTMLCanvasElement, gpu: undefined,
      projection: bridge(), root: mesh(), view, renderer: {
        features: { environment: false, bloom: false, toneMapping: "three-aces-r185" },
        environment: { kind: "studio" },
      } }, { create: createRuntime });
    const supplied = createRuntime.mock.calls[0]![3]!;
    expect(supplied.features).toMatchObject({ environment: false, bloom: false, toneMapping: "three-aces-r185" });
    expect(supplied.environment).toEqual({ kind: "studio" });
    expect(Object.isFrozen(supplied.features)).toBe(true);
    expect(Object.isFrozen(supplied.environment)).toBe(true);
    backend.dispose();
  });

  it.each(["performance", "balanced", "high", "ultra"] as const)("forwards the %s shadow setting", async (tier) => {
    const bytes = CASCADED_SHADOW_QUALITY_PROFILES[tier].estimatedDepthTextureBytes;
    const target = runtime(tier, bytes), createRuntime = vi.fn(async () => target);
    const backend = await DeepWebGpuBackend.create({ canvas: {} as HTMLCanvasElement, gpu: undefined,
      projection: bridge(), root: mesh(), view, renderer: { shadows: { requestedTier: tier,
        maxDepthTextureBytes: 300 * 1024 * 1024 } } }, { create: createRuntime });
    expect(createRuntime.mock.calls[0]![3]).toEqual({ shadows: {
      requestedTier: tier, maxDepthTextureBytes: 300 * 1024 * 1024,
    } });
    expect(backend.shadowSelection?.selectedTier).toBe(tier);
  });

  it("rejects malformed settings before requesting a GPU runtime", async () => {
    const createRuntime = vi.fn(async () => runtime()), request = {
      canvas: {} as HTMLCanvasElement, gpu: undefined, projection: bridge(), root: mesh(), view,
    };
    await expect(DeepWebGpuBackend.create({ ...request,
      renderer: { shadows: { requestedTier: "cinematic" as "high" } } }, { create: createRuntime }))
      .rejects.toThrow("Unknown cascaded shadow quality tier");
    await expect(DeepWebGpuBackend.create({ ...request,
      renderer: { shadows: { maxDepthTextureBytes: 0 } } }, { create: createRuntime }))
      .rejects.toThrow("Invalid maximum shadow depth bytes");
    await expect(DeepWebGpuBackend.create({ ...request,
      renderer: { typo: true } as never }, { create: createRuntime })).rejects.toThrow("Unknown Deep WebGPU renderer option");
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it("retires a runtime that arrives after creation was cancelled", async () => {
    const gate = deferred<DeepWebGpuRenderRuntime>(), target = runtime(), controller = new AbortController();
    const preparing = DeepWebGpuBackend.create({ canvas: {} as HTMLCanvasElement, gpu: undefined,
      projection: bridge(), root: mesh(), view, signal: controller.signal }, { create: vi.fn(async () => gate.promise) });
    controller.abort(); gate.resolve(target);
    await expect(preparing).rejects.toMatchObject({ name: "AbortError" });
    expect(target.dispose).toHaveBeenCalledOnce(); expect(target.setPacketValidated).not.toHaveBeenCalled();
  });

  it("retires a factory runtime whose identity violates the backend contract", async () => {
    const target = runtime(); Object.defineProperty(target, "id", { value: "other" });
    await expect(DeepWebGpuBackend.create({ canvas: {} as HTMLCanvasElement, gpu: undefined,
      projection: bridge(), root: mesh(), view }, { create: vi.fn(async () => target) })).rejects.toThrow("runtime id");
    expect(target.dispose).toHaveBeenCalledOnce();
  });

  it("retires a runtime that reports an inconsistent shadow selection", async () => {
    const target = runtime("high", CASCADED_SHADOW_QUALITY_PROFILES.performance.estimatedDepthTextureBytes);
    await expect(DeepWebGpuBackend.create({ canvas: {} as HTMLCanvasElement, gpu: undefined,
      projection: bridge(), root: mesh(), view }, { create: vi.fn(async () => target) })).rejects.toThrow("expected");
    expect(target.dispose).toHaveBeenCalledOnce();
  });

  it("does not render a rejected author scene during switch preparation", async () => {
    const target = runtime(), backend = new DeepWebGpuBackend(target, bridge());
    const author = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    author.updateWorldMatrix(true, true);
    await expect(backend.prepareScene(author, view)).rejects.toMatchObject({ name: "DeepWebGpuProjectionError" });
    expect(target.validateFrame).not.toHaveBeenCalled();
  });

  it("retires a candidate automatically when switch preparation fails", async () => {
    const target = runtime(), author = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    author.updateWorldMatrix(true, true);
    await expect(DeepWebGpuBackend.prepare(target, bridge(), author, view)).rejects
      .toMatchObject({ name: "DeepWebGpuProjectionError" });
    expect(target.dispose).toHaveBeenCalledTimes(1);
  });

  it("invalidates a late projection and releases runtime exactly once", async () => {
    const target = runtime(), projection = bridge(), backend = new DeepWebGpuBackend(target, projection), first = mesh();
    const stale = projection.project(first, { cameraLayerMask: 1 });
    expect(stale.ok).toBe(true);
    projection.project(mesh(), { cameraLayerMask: 1 });
    if (!stale.ok) throw new Error("expected accepted projection");
    expect(stale.acknowledge()).toBe(false);
    backend.dispose();
    backend.dispose();
    expect(target.dispose).toHaveBeenCalledTimes(1);
    expect(() => backend.render(view)).toThrow("disposed");
  });

  it("publishes a validated Deep candidate at the coordinator frame boundary", async () => {
    const target = runtime(), author = mesh();
    const three = { id: "three", dispose: vi.fn() } satisfies SwitchableBackend;
    const coordinator = new BackendSwitchCoordinator<{}, SwitchableBackend>(three, { state: {},
      prepare: async (id) => {
        if (id !== "deep-webgpu") throw new Error("unsupported backend");
        return DeepWebGpuBackend.prepare(target, bridge(), author, view);
      },
      atFrameBoundary: async publish => publish(),
    });
    await expect(coordinator.switchTo("deep-webgpu")).resolves.toMatchObject({
      status: "switched", activeId: "deep-webgpu",
    });
    expect(target.validateFrame).toHaveBeenCalledOnce();
    expect(three.dispose).toHaveBeenCalledOnce();
    expect(author.parent).toBeNull();
  });

  it("keeps Three active when a Deep candidate cannot project the author scene", async () => {
    const target = runtime(), three = { id: "three", dispose: vi.fn() } satisfies SwitchableBackend;
    const unsupported = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    unsupported.updateWorldMatrix(true, true);
    const coordinator = new BackendSwitchCoordinator<{}, SwitchableBackend>(three, { state: {},
      prepare: async () => DeepWebGpuBackend.prepare(target, bridge(), unsupported, view),
      atFrameBoundary: async publish => publish(),
    });
    await expect(coordinator.switchTo("deep-webgpu")).resolves.toMatchObject({ status: "failed", activeId: "three" });
    expect(target.dispose).toHaveBeenCalledOnce(); expect(three.dispose).not.toHaveBeenCalled();
    expect(unsupported.geometry.attributes.position).toBeDefined();
  });

  it("catches up a changed author scene before publication without restarting script state", async () => {
    const target = runtime(), author = mesh(), projection = bridge();
    const three = { id: "three", dispose: vi.fn() } satisfies SwitchableBackend;
    const state = { revision: 5, root: author, script: { ticks: 40 } };
    let boundaries = 0;
    const coordinator = new BackendSwitchCoordinator<typeof state, SwitchableBackend>(three, {
      state,
      prepare: async () => DeepWebGpuBackend.prepare(target, projection, author, view),
      revisionBarrier: {
        read: current => current.revision,
        catchUp: async (candidate, current, revision, signal) => {
          const synced = await (candidate as DeepWebGpuBackend).sync(current.root, 1, signal);
          if (synced.status !== "committed") throw new Error(`Deep catch-up ${synced.status}.`);
          return revision;
        },
      },
      atFrameBoundary: async publish => {
        boundaries++;
        if (boundaries === 1) {
          state.script.ticks++;
          author.position.x = 6;
          author.updateWorldMatrix(true, true);
          state.revision++;
        }
        publish();
      },
    });
    await expect(coordinator.switchTo("deep-webgpu")).resolves.toMatchObject({
      status: "switched", activeId: "deep-webgpu",
    });
    expect(boundaries).toBe(2);
    expect(coordinator.state).toBe(state);
    expect(state).toMatchObject({ revision: 6, root: author, script: { ticks: 41 } });
    expect(target.updates.at(-1)!.instances[0]!.transform[12]).toBe(6);
    expect(target.validateFrame).toHaveBeenCalledOnce();
    expect(three.dispose).toHaveBeenCalledOnce();
  });
});
