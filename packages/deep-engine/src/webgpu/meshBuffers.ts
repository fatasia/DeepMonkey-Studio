import type { DeviceSession } from "./deviceSession.js";
import type { MeshData } from "./primitives.js";
import type { GeometryResource } from "../renderPacket.js";
import { PacketMeshletSource, type PacketMeshletBudget } from "./packetMeshletSource.js";
import type { PacketLodDraw } from "./packetLodTypes.js";
import { failWithResourceCleanup } from "./resourceCleanup.js";

export function uploadBuffer(session: DeviceSession, label: string, data: Float32Array<ArrayBuffer> | Uint32Array<ArrayBuffer>, usage: GPUBufferUsageFlags): GPUBuffer {
  const buffer = session.own(session.device.createBuffer({ label, size: Math.max(4, data.byteLength), usage: usage | GPUBufferUsage.COPY_DST }));
  try { session.device.queue.writeBuffer(buffer, 0, data); }
  catch (error) { session.release(buffer); throw error; }
  return buffer;
}

export class MeshBuffers {
  readonly vertices: GPUBuffer;
  readonly tangents: GPUBuffer | undefined;
  /** 线性 RGBA 顶点色；独立流，旧无颜色几何没有该 buffer，顶点流布局保持 40B 不变。 */
  readonly colors: GPUBuffer | undefined;
  readonly indices: GPUBuffer;
  readonly indexCount: number;
  readonly meshletSource: PacketMeshletSource | undefined;
  readonly meshletFallback: string | undefined;

  constructor(private readonly session: DeviceSession, mesh: MeshData | GeometryResource, meshletBudget?: PacketMeshletBudget) {
    this.vertices = uploadBuffer(session, "Deep vertices", interleaveUvSets(mesh), GPUBufferUsage.VERTEX);
    let tangents: GPUBuffer | undefined, colors: GPUBuffer | undefined;
    try {
      if ("tangents" in mesh && mesh.tangents) tangents = uploadBuffer(session, "Deep tangents", mesh.tangents, GPUBufferUsage.VERTEX);
      if ("colors" in mesh && mesh.colors) colors = uploadBuffer(session, "Deep colors", mesh.colors, GPUBufferUsage.VERTEX);
      this.indices = uploadBuffer(session, "Deep indices", mesh.indices, GPUBufferUsage.INDEX);
    } catch (error) {
      const allocated = [tangents, colors].filter(Boolean) as GPUBuffer[];
      for (const buffer of allocated) session.release(buffer);
      session.release(this.vertices); throw error;
    }
    this.tangents = tangents; this.colors = colors;
    this.indexCount = mesh.indices.length;
    try {
      const prepared = meshletBudget && "id" in mesh ? PacketMeshletSource.prepare(session, mesh, meshletBudget) : undefined;
      this.meshletSource = prepared?.source; this.meshletFallback = prepared?.fallback;
    } catch (error) { failWithResourceCleanup(error, "Mesh buffer preparation failed.", [() => this.dispose()]); }
  }

  dispose(): void {
    const failures: unknown[] = [];
    try { this.meshletSource?.dispose(); } catch (error) { failures.push(error); }
    for (const buffer of [this.vertices, this.tangents, this.colors, this.indices]) {
      if (!buffer) continue;
      try { this.session.release(buffer); }
      catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "Mesh buffer disposal failed.");
  }

  /** 颜色流绑定 slot4：现行 pipeline 未声明该 slot 的属性输入（shader 消费在颜色变体切片接入），
   * WebGPU 允许绑定 pipeline 未引用的 slot，旧无颜色几何不会走到这里。 */
  private bindColor(pass: GPURenderPassEncoder): void {
    if (this.colors) pass.setVertexBuffer(4, this.colors);
  }

  draw(pass: GPURenderPassEncoder, instances: GPUBuffer, count: number, normalMapped = false, previous?: GPUBuffer): void {
    if (!count) return;
    if (normalMapped && !this.tangents) throw new Error("Normal-mapped draw requires tangent GPU data.");
    pass.setVertexBuffer(0, this.vertices);
    pass.setVertexBuffer(1, instances);
    if (previous) pass.setVertexBuffer(2, previous);
    if (normalMapped) pass.setVertexBuffer(previous ? 3 : 2, this.tangents!);
    this.bindColor(pass);
    pass.setIndexBuffer(this.indices, "uint32");
    pass.drawIndexed(this.indexCount, count);
  }

  drawIndirect(pass: GPURenderPassEncoder, instances: GPUBuffer, indirect: GPUBuffer, normalMapped = false,
    previous?: GPUBuffer, indirectOffset = 0, instanceByteOffset = 0, previousByteOffset = 0): void {
    if (normalMapped && !this.tangents) throw new Error("Normal-mapped draw requires tangent GPU data.");
    pass.setVertexBuffer(0, this.vertices);
    pass.setVertexBuffer(1, instances, instanceByteOffset);
    if (previous) pass.setVertexBuffer(2, previous, previousByteOffset);
    if (normalMapped) pass.setVertexBuffer(previous ? 3 : 2, this.tangents!);
    this.bindColor(pass);
    pass.setIndexBuffer(this.indices, "uint32");
    pass.drawIndexedIndirect(indirect, indirectOffset);
  }
  drawMeshletIndirect(pass: GPURenderPassEncoder, draw: PacketLodDraw, normalMapped: boolean, previous: boolean): void {
    if (!draw.meshlets) throw Error("Meshlet draw metadata is missing.");
    if (normalMapped && !this.tangents) throw Error("Normal-mapped draw requires tangent GPU data.");
    pass.setVertexBuffer(0, this.vertices); pass.setVertexBuffer(1, draw.instances, draw.instanceByteOffset);
    if (previous) pass.setVertexBuffer(2, draw.previousTransforms, draw.previousByteOffset);
    if (normalMapped) pass.setVertexBuffer(previous ? 3 : 2, this.tangents!);
    this.bindColor(pass);
    pass.setIndexBuffer(draw.meshlets.indexBuffer, "uint32");
    for (let command = 0; command < draw.meshlets.commandCount; command++) pass.drawIndexedIndirect(draw.indirect, command * 20);
  }
}

/** GPU 顶点布局固定为 position/normal/uv0/uv1；旧 packet 缺失的坐标集补零。 */
function interleaveUvSets(mesh: MeshData | GeometryResource): Float32Array<ArrayBuffer> {
  const source = mesh.vertices, uv0 = "uv0" in mesh ? mesh.uv0 : undefined, uv1 = "uv1" in mesh ? mesh.uv1 : undefined;
  const vertices = source.length / 6, packed = new Float32Array(vertices * 10);
  for (let vertex = 0; vertex < vertices; vertex++) {
    const sourceOffset = vertex * 6, targetOffset = vertex * 10;
    packed.set(source.subarray(sourceOffset, sourceOffset + 6), targetOffset);
    if (uv0) { packed[targetOffset + 6] = uv0[vertex * 2]!; packed[targetOffset + 7] = uv0[vertex * 2 + 1]!; }
    if (uv1) { packed[targetOffset + 8] = uv1[vertex * 2]!; packed[targetOffset + 9] = uv1[vertex * 2 + 1]!; }
  }
  return packed;
}

export function validateInstances(data: Float32Array): number {
  if (data.length % 12 !== 0 || data.length > 12 * 16_384) throw new Error("Invalid instance buffer length.");
  for (let i = 0; i < data.length; i += 12) {
    for (let k = 0; k < 12; k++) if (!Number.isFinite(data[i + k])) throw new Error("Instance data must be finite.");
    if (data[i + 3]! <= 0) throw new Error("Instance radius must be positive.");
    for (const offset of [4, 5, 6, 7, 8]) {
      if (data[i + offset]! < 0 || data[i + offset]! > 1) throw new Error("Material data must be in 0..1.");
    }
  }
  return data.length / 12;
}
