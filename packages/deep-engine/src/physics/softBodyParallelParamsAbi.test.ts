import { describe, expect, it } from "vitest";
import { packSoftBodyGpuParams, SOFT_BODY_GPU_PARAMS_BYTES } from "./softBodyGpuWgsl.js";
import { SOFT_BODY_PARALLEL_SOLVER_WGSL } from "./softBodyParallelSolverWgsl.js";

// WGSL struct 布局走查(mini layout walker):u32/f32 size=4 align=4,vec4f size=16
// align=16——按实际声明序算出每字段字节偏移,杜绝"u32 连续读"假设(params 字段序
// 教训:声明序≠槽位连续;异值字段+实际偏移双核对)。
function shaderParamLayout() {
  const declaration = SOFT_BODY_PARALLEL_SOLVER_WGSL.match(/struct Params \{([\s\S]*?)\}/)?.[1];
  expect(declaration).toBeDefined();
  let offset = 0;
  const fields: Array<{ name: string; type: string; offset: number }> = [];
  for (const match of declaration!.matchAll(/(\w+)\s*:\s*(u32|f32|vec4f)/g)) {
    const [, name, type] = match as unknown as [string, string, string];
    const align = type === "vec4f" ? 16 : 4;
    const size = type === "vec4f" ? 16 : 4;
    offset = Math.ceil(offset / align) * align;
    fields.push({ name: name!, type: type!, offset });
    offset += size;
  }
  return fields;
}

function readShaderParams(buffer: ArrayBuffer) {
  const view = new DataView(buffer);
  const read = (type: string, offset: number): number => type === "u32"
    ? view.getUint32(offset, true)
    : type === "f32" ? view.getFloat32(offset, true) : view.getUint32(offset, true); // vec4f 只读 x 槽
  return Object.fromEntries(shaderParamLayout().map(({ name, type, offset }) => [name, read(type, offset)]));
}

const particles = Array.from({ length: 13 }, (_, index) => ({
  position: [index, 0, 0] as const, velocity: [0, 0, 0] as const, inverseMass: 1,
}));
const base = {
  particles,
  edges: Array.from({ length: 7 }, (_, i) => ({ a: i, b: i + 1, restLength: 1 })),
  tets: Array.from({ length: 3 }, (_, i) => ({ i0: i, i1: i + 1, i2: i + 2, i3: i + 3, restVolume: 1 / 6 })),
  substeps: 2, dtSeconds: 1 / 60, complianceDistance: 0, complianceVolume: 0, damping: 0,
  gravity: [0, -9.81, 0] as const,
};

describe("soft-body parallel params ABI", () => {
  it("reads four distinct packed counts using the actual shader field order", () => {
    const params = packSoftBodyGpuParams(base);
    expect(params.byteLength).toBe(SOFT_BODY_GPU_PARAMS_BYTES);
    // 风场刀:WGSL Params 声明序的全部 u32 槽 = 头 4 counts + windEnabled/windSeed + 2 pad。
    // 零风输入:windEnabled/windSeed/pad 全零;counts 异值(13/7/3/2)按实际偏移逐字段核对。
    expect(readShaderParams(params)).toMatchObject({
      particleCount: 13, edgeCount: 7, tetCount: 3, substeps: 2,
      windEnabled: 0, windSeed: 0, _windPad0: 0, _windPad1: 0,
    });
  });

  it("packs the wind tail slots at the WGSL-declared u32 offsets with salted seed", () => {
    const wind = {
      direction: [0.6, 0, 0.2] as const, baseSpeed: 1.2, gustFrequency: 0.9,
      spatialScale: 2.5, seed: 7, tickSeconds: 1 / 60,
    };
    const params = packSoftBodyGpuParams({ ...base, wind });
    // u32 槽按实际偏移(walker):windEnabled@48=1 / windSeed@52=seed^salt。
    expect(readShaderParams(params)).toMatchObject({
      particleCount: 13, edgeCount: 7, tetCount: 3, substeps: 2,
      windEnabled: 1, windSeed: (7 ^ 0x51ed2701) >>> 0, _windPad0: 0, _windPad1: 0,
    });
    // f32 槽按字节偏移核对(WGSL 声明:f32×4@16..32、gravity@32..48、
    // baseSpeed@56/gustFreq@60/spatial@64/tick@68、pad@72..80、windDirection vec4f@80..96)。
    const floats = new Float32Array(params);
    expect(floats[4]).toBe(Math.fround(base.dtSeconds));
    expect(floats[7]).toBe(Math.fround(base.damping));
    expect([floats[8], floats[9], floats[10], floats[11]]).toEqual([0, Math.fround(-9.81), 0, 0]);
    expect(floats[14]).toBe(Math.fround(1.2));
    expect(floats[15]).toBe(Math.fround(0.9));
    expect(floats[16]).toBe(Math.fround(2.5));
    expect(floats[17]).toBe(Math.fround(1 / 60));
    expect([floats[18], floats[19]]).toEqual([0, 0]); // pad
    expect([floats[20], floats[21], floats[22], floats[23]]).toEqual([Math.fround(0.6), 0, Math.fround(0.2), 0]);
    // 零风与有风输入头 48B 逐位一致(风槽之外零扰动)。
    const noWind = packSoftBodyGpuParams(base);
    expect(Array.from(new Uint32Array(noWind, 0, 12))).toEqual(Array.from(new Uint32Array(params, 0, 12)));
  });

  it("retains all particles when there are no edge or volume constraints", () => {
    const params = readShaderParams(packSoftBodyGpuParams({ ...base, edges: [], tets: [] }));
    expect(params.particleCount).toBe(13);
    expect(params.edgeCount).toBe(0);
    expect(params.tetCount).toBe(0);
    expect(params.substeps).toBe(2);
  });

  it("does not silently omit the final particle in a chain", () => {
    const edges = Array.from({ length: 12 }, (_, i) => ({ a: i, b: i + 1, restLength: 1 }));
    const params = readShaderParams(packSoftBodyGpuParams({ ...base, edges, tets: [] }));
    expect(params.particleCount).toBe(particles.length);
    expect(12 < params.particleCount!).toBe(true);
    expect(params.substeps).toBe(2);
  });
});
