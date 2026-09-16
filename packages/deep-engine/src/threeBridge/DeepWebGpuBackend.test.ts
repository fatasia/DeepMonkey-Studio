import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { bridge, mesh } from "./testFixture.js";
import { view, deferred, runtime } from "./DeepWebGpuBackend.testUtils.js";
import { DeepWebGpuBackend } from "./DeepWebGpuBackend.js";
import { BackendSwitchCoordinator, type SwitchableBackend } from "../backendSwitch.js";
import { deformationBridge, morphMesh } from "./deformation.testUtils.js";

describe("DeepWebGpuBackend", () => {
  it("forwards changed author poses on the incremental path", async () => {
    const target = runtime(), author = morphMesh();
    const backend = new DeepWebGpuBackend(target, deformationBridge());
    expect(await backend.sync(author)).toMatchObject({ status: "committed", update: "full" });
    author.morphTargetInfluences![0] = 0.75;
    expect(await backend.sync(author)).toMatchObject({ status: "committed", update: "instances" });
    expect(target.updates[0]!.poses?.[0]!.morphWeights!.values[0]).toBe(0.75);
    expect(target.packets).toHaveLength(1);
  });

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
    const author = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshLambertMaterial());
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

  it("does not render a rejected author scene during switch preparation", async () => {
    const target = runtime(), backend = new DeepWebGpuBackend(target, bridge());
    const author = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshLambertMaterial());
    author.updateWorldMatrix(true, true);
    await expect(backend.prepareScene(author, view)).rejects.toMatchObject({ name: "DeepWebGpuProjectionError" });
    expect(target.validateFrame).not.toHaveBeenCalled();
  });

  it("retires a candidate automatically when switch preparation fails", async () => {
    const target = runtime(), author = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshLambertMaterial());
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
    const unsupported = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshLambertMaterial());
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
