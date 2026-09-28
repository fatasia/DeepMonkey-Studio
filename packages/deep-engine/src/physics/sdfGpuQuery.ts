import type { SdfGrid } from "./sdfGrid.js";

/** GPU query of a CPU-verified SDF grid. Opt-in evidence path, not a Rapier solver. */
export const SDF_QUERY_WGSL = `
struct QueryParams {
  origin: vec3f,
  cellSize: f32,
  dimensions: vec3u,
  count: u32,
};
@group(0) @binding(0) var<uniform> params: QueryParams;
@group(0) @binding(1) var<storage, read> field: array<f32>;
@group(0) @binding(2) var<storage, read> points: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> output: array<f32>;
fn at(x: u32, y: u32, z: u32) -> f32 {
  let d = params.dimensions;
  return field[(min(z, d.z - 1u) * d.y + min(y, d.y - 1u)) * d.x + min(x, d.x - 1u)];
}
fn lerp2(a: f32, b: f32, t: f32) -> f32 { return a + (b - a) * t; }
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= params.count) { return; }
  let q = (points[gid.x].xyz - params.origin) / params.cellSize;
  let maxQ = vec3f(params.dimensions - vec3u(1u));
  if (any(q < vec3f(0.0)) || any(q > maxQ)) {
    output[gid.x] = bitcast<f32>(0x7fc00000u);
    return;
  }
  let l = vec3u(floor(q));
  let f = q - vec3f(l);
  let x0 = lerp2(at(l.x, l.y, l.z), at(l.x + 1u, l.y, l.z), f.x);
  let x1 = lerp2(at(l.x, l.y + 1u, l.z), at(l.x + 1u, l.y + 1u, l.z), f.x);
  let x2 = lerp2(at(l.x, l.y, l.z + 1u), at(l.x + 1u, l.y, l.z + 1u), f.x);
  let x3 = lerp2(at(l.x, l.y + 1u, l.z + 1u), at(l.x + 1u, l.y + 1u, l.z + 1u), f.x);
  output[gid.x] = lerp2(lerp2(x0, x1, f.y), lerp2(x2, x3, f.y), f.z);
}
`;

export interface SdfQueryGpuInput {
  readonly grid: SdfGrid;
  readonly points: readonly (readonly [number, number, number])[];
}

/** Each output lane is owned by exactly one invocation, so there is no nondeterministic reduction. */
export async function querySdfGridGpu(device: GPUDevice, input: SdfQueryGpuInput): Promise<Float32Array> {
  const count = input.points.length;
  if (count < 1 || count > 65_536 || input.points.some(point => !point.every(Number.isFinite))) {
    throw new RangeError("SDF GPU 查询点数量或数值非法");
  }
  const params = new ArrayBuffer(32), view = new DataView(params);
  input.grid.origin.forEach((value, i) => view.setFloat32(i * 4, value, true));
  view.setFloat32(12, input.grid.cellSize, true);
  input.grid.dimensions.forEach((value, i) => view.setUint32(16 + i * 4, value, true));
  view.setUint32(28, count, true);
  const pointBytes = new Float32Array(count * 4);
  input.points.forEach((point, i) => point.forEach((value, axis) => { pointBytes[i * 4 + axis] = value; }));
  const make = (size: number, usage: GPUBufferUsageFlags, source?: ArrayBufferView<ArrayBuffer> | ArrayBuffer) => {
    const buffer = device.createBuffer({ size: Math.max(4, size), usage });
    if (source) device.queue.writeBuffer(buffer, 0, source);
    return buffer;
  };
  const uniform = make(32, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, params);
  const field = make(input.grid.distances.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, input.grid.distances);
  const points = make(pointBytes.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, pointBytes);
  const result = make(count * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
  const readback = make(count * 4, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
  try {
    const module = device.createShaderModule({ code: SDF_QUERY_WGSL });
    const pipeline = await device.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint: "main" } });
    const bindGroup = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: uniform } }, { binding: 1, resource: { buffer: field } },
      { binding: 2, resource: { buffer: points } }, { binding: 3, resource: { buffer: result } },
    ] });
    const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
    pass.setPipeline(pipeline); pass.setBindGroup(0, bindGroup); pass.dispatchWorkgroups(Math.ceil(count / 64)); pass.end();
    encoder.copyBufferToBuffer(result, 0, readback, 0, count * 4); device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    return new Float32Array(readback.getMappedRange().slice(0));
  } finally {
    if (readback.mapState === "mapped") readback.unmap();
    for (const buffer of [uniform, field, points, result, readback]) buffer.destroy();
  }
}
