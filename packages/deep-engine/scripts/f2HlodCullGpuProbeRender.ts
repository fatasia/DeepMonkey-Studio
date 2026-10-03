// F2/驻留感知 HLOD 冻结场景 probe 渲染 harness(sourceSizeGate 拆分:自 f2HlodCullGpuProbe.ts
// 按职责分文件,代码逐行同源,仅改可见性;语义零变化)。
// 职责:对象 ID 自持 WGSL、base64 载荷解码、离屏会话、相机矩阵、几何拼接与实例打包、
// 附件读回与掩码膨胀。
import { DeviceSession } from "../src/webgpu/deviceSession.js";
import { packTransform } from "../src/instanceTransform.js";
import { F2_MEMBER_GEOMETRY_KEY, F2_VIEWPORT_HEIGHT, F2_VIEWPORT_WIDTH,
  type F2Payload } from "./f2HlodCullShared.js";

export const ID_WGSL = /* wgsl */ `
struct Uniforms { viewProj: mat4x4f };
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read> positions: array<f32>;
@group(0) @binding(2) var<storage, read> indices: array<u32>;

struct VsOut {
  @builtin(position) clip: vec4f,
  @location(0) @interpolate(flat) id: u32,
};

@vertex
fn vs(@builtin(vertex_index) vertexIndex: u32, @builtin(instance_index) instanceIndex: u32,
  @location(0) row0: vec4f, @location(1) row1: vec4f, @location(2) row2: vec4f,
  @location(3) metaRow: vec4u) -> VsOut {
  // metaRow = (indexBase, indexCount, u32Id, 0);实例几何小于 draw 上限时截断到屏外。
  if (vertexIndex >= metaRow.y) {
    return VsOut(vec4f(2.0, 2.0, 2.0, 1.0), 0u);
  }
  let slot = metaRow.x + vertexIndex;
  let positionIndex = indices[slot] * 3u;
  let position = vec3f(positions[positionIndex], positions[positionIndex + 1u], positions[positionIndex + 2u]);
  // packTransform 行序:row0=(a0,b0,c0,tx)…;世界 = p.x·colA + p.y·colB + p.z·colC + t。
  let world = vec3f(
    dot(vec3f(row0.x, row1.x, row2.x), position) + row0.w,
    dot(vec3f(row0.y, row1.y, row2.y), position) + row1.w,
    dot(vec3f(row0.z, row1.z, row2.z), position) + row2.w);
  return VsOut(u.viewProj * vec4f(world, 1.0), metaRow.z);
}

@fragment
fn fs(vsOut: VsOut) -> @location(0) u32 {
  return vsOut.id;
}
`;

export const BYTES_PER_ROW = F2_VIEWPORT_WIDTH * 4; // r32uint/depth32float 均 4B/px;960×4=3840 为 256 对齐。
export const PIXELS = F2_VIEWPORT_WIDTH * F2_VIEWPORT_HEIGHT;
export const MEMBER_ID_BASE = 1;

export function bytesFromB64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
export function f32FromB64(value: string): Float32Array {
  const bytes = bytesFromB64(value);
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}
export function u32FromB64(value: string): Uint32Array {
  const bytes = bytesFromB64(value);
  return new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
}

/** 离屏 canvas 真机会话(照 f3VirtualTextureGpuProbe 先例);附带设备错误收集。 */
export async function openF2Session(): Promise<{ session: DeviceSession; adapter: unknown; deviceErrors: string[] }> {
  if (!navigator.gpu) throw new Error("navigator.gpu unavailable.");
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("WebGPU adapter unavailable");
  const canvas = document.createElement("canvas");
  const session = await DeviceSession.open(canvas, navigator.gpu, new AbortController().signal);
  const deviceErrors: string[] = [];
  session.device.addEventListener("uncapturederror", (event: Event) => {
    deviceErrors.push(String((event as GPUUncapturedErrorEvent).error?.message ?? String(event)));
  });
  const info = adapter.info;
  return { session, adapter: info ? { vendor: info.vendor, architecture: info.architecture,
    device: info.device, description: info.description } : {}, deviceErrors };
}

/** 列主序 view-projection(lookAt(up=+Y) + WebGPU [0,1] 深度透视;probe 本地实现)。 */
export function viewProjectionMatrix(eye: readonly number[], forward: readonly number[], tanHalfFovY: number,
  near: number, farPlane: number): Float32Array {
  const normalize = (value: number[]): number[] => {
    const length = Math.hypot(value[0]!, value[1]!, value[2]!);
    if (!(length > 1e-12)) throw new Error("F2 view axis degenerate.");
    return [value[0]! / length, value[1]! / length, value[2]! / length];
  };
  const target = [eye[0]! + forward[0]!, eye[1]! + forward[1]!, eye[2]! + forward[2]!];
  const zAxis = normalize([eye[0]! - target[0]!, eye[1]! - target[1]!, eye[2]! - target[2]!]);
  const up = [0, 1, 0];
  const xAxis = normalize([up[1]! * zAxis[2]! - up[2]! * zAxis[1]!, up[2]! * zAxis[0]! - up[0]! * zAxis[2]!,
    up[0]! * zAxis[1]! - up[1]! * zAxis[0]!]);
  const yAxis = [zAxis[1]! * xAxis[2]! - zAxis[2]! * xAxis[1]!, zAxis[2]! * xAxis[0]! - zAxis[0]! * xAxis[2]!,
    zAxis[0]! * xAxis[1]! - zAxis[1]! * xAxis[0]!];
  const view = new Float32Array([
    xAxis[0]!, yAxis[0]!, zAxis[0]!, 0,
    xAxis[1]!, yAxis[1]!, zAxis[1]!, 0,
    xAxis[2]!, yAxis[2]!, zAxis[2]!, 0,
    -(xAxis[0]! * eye[0]! + xAxis[1]! * eye[1]! + xAxis[2]! * eye[2]!),
    -(yAxis[0]! * eye[0]! + yAxis[1]! * eye[1]! + yAxis[2]! * eye[2]!),
    -(zAxis[0]! * eye[0]! + zAxis[1]! * eye[1]! + zAxis[2]! * eye[2]!), 1]);
  const aspect = F2_VIEWPORT_WIDTH / F2_VIEWPORT_HEIGHT;
  const focal = 1 / tanHalfFovY;
  const projection = new Float32Array([
    focal / aspect, 0, 0, 0,
    0, focal, 0, 0,
    0, 0, farPlane / (near - farPlane), -1,
    0, 0, near * farPlane / (near - farPlane), 0]);
  const out = new Float32Array(16);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += projection[k * 4 + row]! * view[column * 4 + k]!;
      out[column * 4 + row] = sum;
    }
  }
  return out;
}

export interface GeometrySlot { readonly indexBase: number; readonly indexCount: number; }
export interface PackedInstances { readonly buffer: GPUBuffer; readonly count: number; readonly degenerate: number;
  readonly maxIndexCount: number; }

export function concatGeometries(device: GPUDevice, payload: F2Payload): {
  positionsBuffer: GPUBuffer; indicesBuffer: GPUBuffer; slots: Map<string, GeometrySlot>;
} {
  const unitVertices = f32FromB64(payload.unitGeometry.verticesB64);
  const unitIndices = u32FromB64(payload.unitGeometry.indicesB64);
  const positions: number[] = [];
  for (let offset = 0; offset < unitVertices.length; offset += 6) {
    positions.push(unitVertices[offset]!, unitVertices[offset + 1]!, unitVertices[offset + 2]!);
  }
  const indices: number[] = [...unitIndices];
  const slots = new Map<string, GeometrySlot>([
    [F2_MEMBER_GEOMETRY_KEY, { indexBase: 0, indexCount: unitIndices.length }]]);
  for (const proxy of payload.proxyList) {
    const vertices = f32FromB64(proxy.verticesB64);
    const proxyIndices = u32FromB64(proxy.indicesB64);
    const vertexBase = positions.length / 3;
    const indexBase = indices.length;
    for (let offset = 0; offset < vertices.length; offset += 6) {
      positions.push(vertices[offset]!, vertices[offset + 1]!, vertices[offset + 2]!);
    }
    for (const index of proxyIndices) indices.push(index + vertexBase);
    slots.set(proxy.geometryId, { indexBase, indexCount: proxyIndices.length });
  }
  const positionsBuffer = device.createBuffer({ label: "F2 positions", size: positions.length * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(positionsBuffer, 0, new Float32Array(positions));
  const indicesBuffer = device.createBuffer({ label: "F2 indices", size: Math.max(indices.length * 4, 4),
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(indicesBuffer, 0, new Uint32Array(indices));
  return { positionsBuffer, indicesBuffer, slots };
}

/** 生产 packTransform 打包(24 float 行取前 12)+ 元数据行;fail-closed 与生产同源。 */
export function packInstanceRows(device: GPUDevice,
  rows: readonly { readonly transform: ArrayLike<number>; readonly slot: GeometrySlot; readonly u32Id: number }[]):
  PackedInstances {
  const packed = new ArrayBuffer(rows.length * 64);
  const floats = new Float32Array(packed);
  const words = new Uint32Array(packed);
  const transformRow = new Float32Array(24);
  let degenerate = 0;
  let maxIndexCount = 0;
  rows.forEach((row, index) => {
    packTransform(row.transform, transformRow, 0);
    const base = index * 16;
    floats.set(transformRow.subarray(0, 12), base);
    words.set([row.slot.indexBase, row.slot.indexCount, row.u32Id, 0], base + 12);
    maxIndexCount = Math.max(maxIndexCount, row.slot.indexCount);
    const linear = Math.max(Math.abs(transformRow[0]!), Math.abs(transformRow[5]!), Math.abs(transformRow[10]!));
    if (linear < 1e-4) degenerate += 1;
  });
  const buffer = device.createBuffer({ label: "F2 instances", size: Math.max(packed.byteLength, 4),
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(buffer, 0, packed);
  return { buffer, count: rows.length, degenerate, maxIndexCount };
}

/** 读回 r32uint/depth32float 附件(bytesPerRow=3840 已 256 对齐,无行冗余)。 */
export async function readbackAttachment(device: GPUDevice, texture: GPUTexture): Promise<Uint8Array> {
  const buffer = device.createBuffer({ label: "F2 readback", size: BYTES_PER_ROW * F2_VIEWPORT_HEIGHT,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const encoder = device.createCommandEncoder({ label: "F2 readback" });
  encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: BYTES_PER_ROW, rowsPerImage: F2_VIEWPORT_HEIGHT },
    { width: F2_VIEWPORT_WIDTH, height: F2_VIEWPORT_HEIGHT, depthOrArrayLayers: 1 });
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(GPUMapMode.READ);
  const bytes = new Uint8Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  buffer.destroy();
  return bytes;
}

/** 1px 膨胀(mask[dilated] = 自身或 8 邻域覆盖;边界抖动脉冲吸收用)。 */
export function dilate(mask: Uint8Array): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < F2_VIEWPORT_HEIGHT; y++) {
    for (let x = 0; x < F2_VIEWPORT_WIDTH; x++) {
      const index = y * F2_VIEWPORT_WIDTH + x;
      if (mask[index]!) { out[index] = 1; continue; }
      for (let dy = -1; dy <= 1 && out[index] === 0; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= F2_VIEWPORT_WIDTH || ny >= F2_VIEWPORT_HEIGHT) continue;
          if (mask[ny * F2_VIEWPORT_WIDTH + nx]!) { out[index] = 1; break; }
        }
      }
    }
  }
  return out;
}
