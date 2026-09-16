import type { DeviceSession } from "../src/webgpu/deviceSession.js";
import { PacketDeformationResources } from "../src/webgpu/packetDeformationResources.js";
import type { DeformationPose, DeformationSource } from "../src/deformation/types.js";
import type { SkinningPalette } from "../src/webgpu/gpuSkinningTypes.js";
import type { GpuMorphWeights } from "../src/webgpu/gpuMorphTypes.js";

export type ProbeProducerKind = "skin" | "morph" | "morph-skin";

/** Three vertices and one joint/target; all position deformation happens on the GPU. */
export function createProbeProducer(session: DeviceSession, kind: ProbeProducerKind) {
  const resources = new PacketDeformationResources(session);
  const positions = new Float32Array([-0.6, -0.3, 0.5, -0.2, -0.3, 0.5, -0.4, 0.3, 0.5]);
  const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const skinSource = { revision: 0, positions, normals, joints: new Uint16Array(12),
    weights: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]) };
  const morphSource = { revision: 0, positions, normals,
    primitive: { id: "probe", sourceMeshIndex: 0, sourcePrimitiveIndex: 0, vertexCount: 3,
      targets: [{ index: 0, name: "translate", positionDeltas: new Float32Array([0.8, 0, 0, 0.8, 0, 0, 0.8, 0, 0]) }] } };
  const palette = (revision: number, x: number): SkinningPalette => ({ revision,
    matrices: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1]) });
  const weights = (revision: number, value: number): GpuMorphWeights => ({ revision, values: new Float32Array([value]) });
  const source: DeformationSource = { id: "source", geometry: "triangle", revision: 0, kind, semantics: "three-r185",
    ...(kind !== "skin" ? { morph: morphSource } : {}), ...(kind !== "morph" ? { skinning: skinSource } : {}) };
  const pose = (id: string, revision: number, moved: boolean): DeformationPose => ({ id, source: source.id, revision,
    ...(kind !== "skin" ? { morphWeights: weights(revision, moved ? kind === "morph" ? 1 : 0.5 : 0) } : {}),
    ...(kind !== "morph" ? { palette: palette(revision, moved ? kind === "skin" ? 0.8 : 0.4 : 0) } : {}) });
  const still = pose("still", 0, false);
  let readback: GPUBuffer | undefined;
  try {
    resources.prepare({ sources: [source], poses: [pose("moving", 0, false), still] });
    readback = session.own(session.device.createBuffer({ size: 144, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }));
  } catch (error) { resources.dispose(); throw error; }
  return {
    encode(encoder: GPUCommandEncoder, frame: number) {
      if (frame === 1) resources.updatePoses([pose("moving", 1, true), still]);
      // Exercise cancellation without publishing the discarded compute/history commands.
      if (frame === 1) { resources.encode(session.device.createCommandEncoder()); resources.cancelFrame(); }
      resources.encode(encoder);
      const moving = resources.drawStreams("moving")!, stationary = resources.drawStreams("still")!;
      if (moving.current === stationary.current) throw new Error("Two poses alias the same output.");
      encoder.copyBufferToBuffer(stationary.current, 0, readback!, 0, 144);
      return moving;
    },
    commit() { resources.commitFrame(); },
    async inspectStationary() {
      await readback!.mapAsync(GPUMapMode.READ);
      try {
        const values = new Float32Array(readback!.getMappedRange());
        const x = [values[0]!, values[12]!, values[24]!];
        return { x, unchanged: x.every((value, index) => Math.abs(value - positions[index * 3]!) < 1e-6) };
      } finally { readback!.unmap(); }
    },
    dispose() {
      try { resources.cancelFrame(); }
      finally { try { resources.dispose(); } finally { if (readback) session.release(readback); } }
    },
  };
}
