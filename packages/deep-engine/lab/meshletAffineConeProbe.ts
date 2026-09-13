/// <reference types="@webgpu/types" />
import { buildMeshlets } from "@bim-studio/deep-engine/geometry";
import { MeshletCuller, type DeviceSession } from "@bim-studio/deep-engine/webgpu";

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as const;
const SCALE = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0.1, 0, 0, 0, 0, 1];
const MIRROR = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0.1, 0, 0, 0, 0, 1];
const SHEAR = [1, 0, 0, 0, 0, 1, 0, 0, 4, 0, 1, 0, 0, 0, 0, 1];
interface Case { name: string; world: readonly number[]; camera: readonly [number, number, number]; axis: "x" | "z"; visible: boolean }
const CASES: readonly Case[] = [
  { name: "unscaled-backface", world: IDENTITY, camera: [-50, 0, Math.sqrt(3) * 50], axis: "x", visible: false },
  { name: "nonuniform-frontface", world: SCALE, camera: [-50, 0, Math.sqrt(3) * 50], axis: "x", visible: true },
  { name: "nonuniform-backface", world: SCALE, camera: [-100, 0, 0], axis: "x", visible: false },
  { name: "sheared-frontface", world: SHEAR, camera: [94, 0, -34.2], axis: "z", visible: true },
  { name: "mirrored-frontface", world: MIRROR, camera: [-50, 0, -Math.sqrt(3) * 50], axis: "x", visible: true },
  { name: "mirrored-backface", world: MIRROR, camera: [-100, 0, 0], axis: "x", visible: false },
];

/** 用实际三角形面法线验证可见性，再读回真实 GPU 剔除结果。 */
export async function runMeshletAffineConeProbe(session: DeviceSession) {
  const device = session.device, culler = new MeshletCuller(session), owned: GPUBuffer[] = [];
  const buffer = (label: string, size: number, usage: GPUBufferUsageFlags): GPUBuffer => {
    const value = session.own(device.createBuffer({ label, size, usage })); owned.push(value); return value;
  };
  const descriptors = buffer("Deep affine cone descriptors", 64 * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
  const bounds = buffer("Deep affine cone bounds", 64 * 64, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
  const readback = buffer("Deep affine cone readback", 4, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
  const results: { name: string; visibleCount: number; expectedCount: number; maxFaceViewDot: number; coneEnabled: boolean }[] = [];
  try {
    for (const [revision, item] of CASES.entries()) {
      const { meshlets, positions, indices } = geometry(item.axis);
      if (meshlets.meshletCount !== 64) throw new Error("Affine cone fixture requires exactly 64 meshlets.");
      device.queue.writeBuffer(descriptors, 0, meshlets.descriptors);
      device.queue.writeBuffer(bounds, 0, meshlets.bounds);
      const encoder = device.createCommandEncoder({ label: `Deep affine cone ${item.name}` });
      const result = culler.encode(encoder, { descriptors, bounds, count: 64, revision }, {
        viewProjection: IDENTITY, worldFromObject: item.world, cameraPosition: item.camera, viewport: [64, 64], reversedZ: false,
        frustum: { planes: [[1, 0, 0, 1000], [-1, 0, 0, 1000], [0, 1, 0, 1000], [0, -1, 0, 1000], [0, 0, 1, 1000], [0, 0, -1, 1000]] },
      });
      if (result.mode !== "gpu") throw new Error("Affine cone probe requires real GPU culling.");
      encoder.copyBufferToBuffer(result.visibleCount, 0, readback, 0, 4);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const visibleCount = new Uint32Array(readback.getMappedRange())[0]!; readback.unmap();
      results.push({ name: item.name, visibleCount, expectedCount: item.visible ? 64 : 0,
        maxFaceViewDot: maxFaceViewDot(positions, indices, item), coneEnabled: result.normalConeTested });
    }
    return { affineConeCases: results, affineConesPassed: results.every(result => result.coneEnabled
      && result.visibleCount === result.expectedCount && (result.maxFaceViewDot > 0) === (result.expectedCount > 0)) };
  } finally {
    culler.dispose();
    for (const resource of owned.reverse()) session.release(resource);
  }
}

function geometry(axis: "x" | "z") {
  const positions = new Float32Array(64 * 18), indices = new Uint16Array(64 * 6), angle = Math.PI / 18, size = 0.01;
  for (let meshlet = 0; meshlet < 64; meshlet += 1) {
    for (let side = 0; side < 2; side += 1) {
      const vertex = meshlet * 6 + side * 3, s = (side ? 1 : -1) * Math.sin(angle), c = Math.cos(angle);
      const a = [0, 0, 0], b = [0, size, 0], normal = axis === "x" ? [c, 0, s] : [s, 0, c];
      const d = [-normal[2]! * size, 0, normal[0]! * size];
      positions.set([...a, ...b, ...d], vertex * 3); indices.set([vertex, vertex + 1, vertex + 2], vertex);
    }
  }
  return { positions, indices, meshlets: buildMeshlets({ positions, indices }, { maxTriangles: 2 }) };
}
function maxFaceViewDot(positions: Float32Array, indices: Uint16Array, item: Case): number {
  const m = item.world.map(Math.fround), camera = item.camera.map(Math.fround);
  const point = (index: number) => [0, 1, 2].map(row => m[row]! * positions[index * 3]!
    + m[row + 4]! * positions[index * 3 + 1]! + m[row + 8]! * positions[index * 3 + 2]! + m[row + 12]!);
  let maximum = -Infinity;
  for (let triangle = 0; triangle < indices.length; triangle += 3) {
    const a = point(indices[triangle]!), b = point(indices[triangle + 1]!), c = point(indices[triangle + 2]!);
    const u = b.map((value, i) => value - a[i]!), v = c.map((value, i) => value - a[i]!);
    const normal = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
    const direction = camera.map((value, i) => value - a[i]!);
    const dot = normal.reduce((sum, value, i) => sum + value * direction[i]!, 0) / Math.hypot(...normal) / Math.hypot(...direction);
    maximum = Math.max(maximum, dot);
  }
  return maximum;
}
