import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RenderPacket } from "../renderPacketTypes.js";
import { createSoftBodyRuntimeSession } from "./softBodyRuntimeHost.js";
import type { DynamicPhysicsRuntime } from "../runtimePackage/dynamicSceneRuntime.js";
import { projectSoftBodyRenderPacket, type SoftBodyRenderBinding } from "./softBodyRenderProjection.js";
import { PacketBuffers } from "../webgpu/packetBuffers.js";
import type { DeviceSession } from "../webgpu/deviceSession.js";

const binding: SoftBodyRenderBinding = { bodyId: "flag", instanceId: "flag-instance", vertexParticles: [0,1,2,3] };
function scene(): { packet: RenderPacket; physics: DynamicPhysicsRuntime } {
  const transform = [1,0,0,0, 0,1,0,0, 0,0,1,0, 5,6,7,1];
  return {
    packet: { geometries: [{ id: "flag-geometry", revision: 0, vertices: new Float32Array([
      0,0,0,0,0,1, 1,0,0,0,0,1, 0,1,0,0,0,1, 1,1,0,0,0,1,
    ]), indices: new Uint32Array([0,1,2,1,3,2]), uv0: new Float32Array([0,0,1,0,0,1,1,1]) }],
    materials: [{ id: "cloth-material", baseColor: [.5,.6,.7], metallic: 0, roughness: .5 }],
    instances: [{ id: binding.instanceId, geometry: "flag-geometry", material: "cloth-material", transform }] },
    physics: { schema: "deep-engine.physics-runtime", schemaVersion: 1, enabled: true, playing: true,
      gravity: [0,-9.81,0], bodies: [], joints: [], softBodies: [{ kind: "cloth", id: "flag", columns: 2, rows: 2,
        spacing: 1, mass: .2, compliance: 0, damping: .01, substeps: 8, perturbation: 0, seed: 7,
        origin: [5,6,7], pinned: [2,3], wind: { direction: [0,0,-1], baseSpeed: 2,
          gustFrequency: .7, spatialScale: 1.5, seed: 11 } }] },
  };
}
function resourceConsumer() {
  const owned = new Set<GPUBuffer>(), allocated: GPUBuffer[] = [], contents = new Map<GPUBuffer, number[]>();
  const device = { limits: { maxBufferSize: 256*1024*1024 },
    createBuffer: vi.fn(({ label }: { label: string }) => {
      const buffer = { label, destroy: vi.fn() } as unknown as GPUBuffer; allocated.push(buffer); return buffer;
    }),
    queue: { writeBuffer: vi.fn((buffer: GPUBuffer, _offset: number, data: Float32Array | Uint32Array) => contents.set(buffer, Array.from(data))) },
  };
  const session = { state: "ready", device, own(buffer: GPUBuffer) { owned.add(buffer); return buffer; },
    release(buffer: GPUBuffer) { if (owned.delete(buffer)) buffer.destroy(); } };
  return { cache: new PacketBuffers(session as unknown as DeviceSession), owned, allocated, contents, device };
}
beforeEach(() => { vi.stubGlobal("GPUBufferUsage", { VERTEX:32, INDEX:16, COPY_DST:8, STORAGE:128, COPY_SRC:4, INDIRECT:256 }); vi.stubGlobal("GPUShaderStage", { COMPUTE:4 }); });
afterEach(() => vi.unstubAllGlobals());

describe("F6 explicit body-to-geometry projection into existing renderer resources", () => {
  it("uploads actual solver xyz/normals through PacketBuffers.set and retires prior geometry", () => {
    const { packet, physics } = scene(), session = createSoftBodyRuntimeSession(physics), f = resourceConsumer();
    f.cache.set(packet);
    const oldVertices = f.allocated.find(buffer => buffer.label === "Deep vertices")!;
    const instances = f.allocated.find(buffer => buffer.label === "Deep packet instances")!;
    for (let tick = 0; tick < 16; tick++) session.step();
    const candidate = projectSoftBodyRenderPacket(session, packet, [binding]);
    expect(candidate.geometries[0]!.revision).toBe(1);
    expect(candidate.materials).toBe(packet.materials); expect(candidate.instances).toBe(packet.instances);
    expect(candidate.geometries[0]!.indices).toBe(packet.geometries[0]!.indices);
    expect(candidate.geometries[0]!.uv0).toBe(packet.geometries[0]!.uv0);
    expect(f.cache.set(candidate)).toBe(true);
    const actual = f.contents.get(f.allocated.filter(buffer => buffer.label === "Deep vertices").at(-1)!)!;
    for (let vertex = 0; vertex < 4; vertex++) {
      // Actual uploaded stream has xyz+normal+UV0+UV1, 10 f32 per vertex.
      for (let axis = 0; axis < 6; axis++) expect(actual[vertex*10+axis]).toBe(candidate.geometries[0]!.vertices[vertex*6+axis]);
      expect(Math.hypot(...actual.slice(vertex*10+3,vertex*10+6))).toBeCloseTo(1,6);
    }
    const world = session.readout("flag")!;
    expect(actual[0]).toBe(Math.fround(world[0]!-5)); expect(actual[1]).toBe(Math.fround(world[1]!-6));
    expect(actual[2]).toBe(Math.fround(world[2]!-7));
    expect(oldVertices.destroy).toHaveBeenCalledOnce(); expect(f.owned.has(instances)).toBe(true);
    const writes = f.device.queue.writeBuffer.mock.calls.length;
    expect(projectSoftBodyRenderPacket(session, candidate, [binding])).toBe(candidate);
    expect(f.cache.set(candidate)).toBe(false); expect(f.device.queue.writeBuffer.mock.calls.length).toBe(writes);
    f.cache.dispose(); expect(f.owned.size).toBe(0);
  });
  it("keeps renderer revisions monotonic after solver snapshot restore", () => {
    const { packet, physics } = scene(), session = createSoftBodyRuntimeSession(physics), initial = session.capture();
    session.step(); const first = projectSoftBodyRenderPacket(session, packet, [binding]);
    session.restore(initial); const replay = projectSoftBodyRenderPacket(session, first, [binding]);
    expect(session.tick).toBe(0); expect(replay.geometries[0]!.revision).toBe(2);
  });
  it("failed real resource upload preserves the old publication and permits same-candidate retry", () => {
    const { packet, physics } = scene(), session = createSoftBodyRuntimeSession(physics), f = resourceConsumer();
    f.cache.set(packet); const revision = f.cache.visibilityRevision;
    session.step(); const candidate = projectSoftBodyRenderPacket(session, packet, [binding]);
    f.device.queue.writeBuffer.mockImplementationOnce(() => { throw new Error("selected upload failure"); });
    expect(() => f.cache.set(candidate)).toThrow("selected upload failure");
    expect(f.cache.visibilityRevision).toBe(revision); expect(f.cache.set(candidate)).toBe(true);
    f.cache.dispose(); expect(f.owned.size).toBe(0);
  });
  it("twenty actual solver/resource cycles keep ownership bounded and preserve static uploads", () => {
    const { packet: initial, physics } = scene(), session = createSoftBodyRuntimeSession(physics), f = resourceConsumer();
    let packet = initial; f.cache.set(packet);
    const instanceBuffer = f.allocated.find(buffer => buffer.label === "Deep packet instances")!;
    for (let tick = 0; tick < 20; tick++) {
      session.step(); packet = projectSoftBodyRenderPacket(session,packet,[binding]);
      expect(f.cache.set(packet)).toBe(true); expect(f.owned.size).toBe(4);
      expect(f.owned.has(instanceBuffer)).toBe(true);
    }
    f.cache.dispose(); expect(f.owned.size).toBe(0);
    expect(f.allocated.every(buffer => vi.mocked(buffer.destroy).mock.calls.length === 1)).toBe(true);
  });
  it("rejects guessed identity, invalid mapping, shared meshes, LOD, existing deformation and tangent profiles", () => {
    const { packet, physics } = scene(), session = createSoftBodyRuntimeSession(physics);
    const project = (p: RenderPacket, b: SoftBodyRenderBinding = binding) => projectSoftBodyRenderPacket(session,p,[b]);
    expect(projectSoftBodyRenderPacket(session,packet,[])).toBe(packet);
    expect(() => project(packet,{ ...binding, bodyId:"missing" })).toThrow(/body/);
    expect(() => project(packet,{ ...binding, instanceId:"missing" })).toThrow(/instance/);
    expect(() => project(packet,{ ...binding, vertexParticles:[0,1,2] })).toThrow(/per vertex/);
    expect(() => project(packet,{ ...binding, vertexParticles:[0,1,2,99] })).toThrow(/invalid particle/);
    expect(() => project({ ...packet, instances:[...packet.instances,{ ...packet.instances[0]!,id:"other" }] })).toThrow(/exclusive/);
    expect(() => project({ ...packet, instances:[{ ...packet.instances[0]!,pose:"skin-pose" }] })).toThrow(/deformation/);
    expect(() => project({ ...packet, geometries:[{ ...packet.geometries[0]!,tangents:new Float32Array(16) }] })).toThrow(/untangent/);
    expect(() => project({ ...packet, instances:[{ ...packet.instances[0]!, transform:new Float32Array(16) }] })).toThrow(/affine/);
    const scaled = Array.from(packet.instances[0]!.transform); scaled[0] = 2;
    expect(() => project({ ...packet, instances:[{ ...packet.instances[0]!, transform:scaled }] })).toThrow(/translation-only/);
    expect(() => project({ ...packet, geometries:[{ ...packet.geometries[0]!,revision:Number.MAX_SAFE_INTEGER }] })).toThrow(/revision/);
    expect(() => projectSoftBodyRenderPacket(session,packet,[binding,binding])).toThrow(/multiple bindings/);
  });
});
