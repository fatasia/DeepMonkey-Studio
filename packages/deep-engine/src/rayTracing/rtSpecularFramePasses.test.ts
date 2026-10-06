import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RtSpecularFillPass, RtSpecularIndirectionPass } from "./rtSpecularFramePasses.js";
import { RT_SPECULAR_BOUNCE_ALBEDO, RT_SPECULAR_INDIRECTION_PARAMS_BYTES } from "./rtSpecularIndirectionKernel.js";
import { RT_SPECULAR_FILL_PARAMS_BYTES } from "./rtSpecularFillKernel.js";

/**
 * RT specular 帧执行器合同(2026-10-06 P1 质量主线切片;同日遮蔽+反照率切片更新绑定面):
 * 同步 encode(postprocess 家族合同,消费点在同步帧链内禁异步括夹)、自有 uniform、
 * bind LRU 4、无 readback;差界面(96B/16B 参数、8/6 槽绑定、视图身份缓存键)逐项钉死。
 * GPU 侧 mock 同族惯例;真机 dispatch 语义由 scripts/rtSpecularGiGpuTest.mjs 覆盖
 * (indirection==CPU 镜像 + 遮蔽/反照率差分 + fill on/off 对拍)。
 */

function deviceStub() {
  const buffers: Array<{ label?: string; size: number; usage: number; destroy: ReturnType<typeof vi.fn> }> = [];
  const bindGroups: Array<{ entries: Array<{ binding: number; resource: unknown }> }> = [];
  let validationError: GPUError | null = null;
  const device = {
    features: new Set<string>(),
    pushErrorScope: vi.fn(),
    popErrorScope: vi.fn(async () => validationError),
    queue: { writeBuffer: vi.fn() },
    createBuffer: vi.fn((descriptor: { size: number; usage: number }) => {
      const buffer = { size: descriptor.size, usage: descriptor.usage, destroy: vi.fn() };
      buffers.push(buffer); return buffer;
    }),
    createShaderModule: vi.fn(() => ({})),
    createComputePipeline: vi.fn(() => ({ getBindGroupLayout: () => ({}) })),
    createBindGroupLayout: vi.fn(() => ({})),
    createPipelineLayout: vi.fn(() => ({})),
    createSampler: vi.fn(() => ({})),
    createBindGroup: vi.fn((descriptor: { entries: Array<{ binding: number; resource: unknown }> }) => {
      const group = { entries: descriptor.entries }; bindGroups.push(group); return group;
    }),
    failNextValidation(message: string) {
      validationError = { message } as GPUError;
    },
  };
  return { device: device as unknown as GPUDevice & { failNextValidation(message: string): void }, buffers, bindGroups };
}

function view(label: string): GPUTextureView {
  return { label } as unknown as GPUTextureView;
}

function encoderStub() {
  const passes: Array<{ dispatches: Array<[number, number, number]> }> = [];
  const encoder = {
    beginComputePass: vi.fn(() => {
      const record = { dispatches: [] as Array<[number, number, number]> };
      passes.push(record);
      return { setPipeline: vi.fn(), setBindGroup: vi.fn(), dispatchWorkgroups: vi.fn((x: number, y: number, z: number) => {
        record.dispatches.push([x, y, z]);
      }), end: vi.fn() };
    }),
  } as unknown as GPUCommandEncoder;
  return { encoder, passes };
}

function indirectionInput(width = 16, height = 8): Parameters<RtSpecularIndirectionPass["encode"]>[1] {
  return { linearDepthView: view("linear-depth"), viewNormalView: view("view-normal"), brdfLutView: view("brdf"),
    rtHitView: view("rt-hit"), bounceShadingView: view("bounce-shading"), indirectionView: view("indirection"),
    width, height,
    params: { width, height, tanHalfFov: 0.6, aspect: 1.5, surfaceToLightWorld: [0.4, 0.8, -0.45],
      lightColor: [1, 0.96, 0.9], lightIntensity: 3.2, envRadiance: [0.05, 0.06, 0.08], fresnelF0: 0.05 } };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

beforeEach(() => {
  // 显式绑定布局构造引用 GPUShaderStage 全局(与 SSR pass 测试同款 stub)。
  vi.stubGlobal("GPUShaderStage", { COMPUTE: 1 });
});

describe("RtSpecularIndirectionPass", () => {
  it("allocates only its own 96B uniform, dispatches 8x8 workgroups, caches bindings by view identity", () => {
    const f = deviceStub(), pass = new RtSpecularIndirectionPass(f.device);
    expect(f.buffers).toHaveLength(1);
    expect(f.buffers[0]!.size).toBe(RT_SPECULAR_INDIRECTION_PARAMS_BYTES);
    // 0x40|0x8 = UNIFORM|COPY_DST(数值位,同 RayTraceClosestFramePass 不触运行时全局)。
    expect(f.buffers[0]!.usage).toBe(0x40 | 0x8);
    const { encoder, passes } = encoderStub();
    const input = indirectionInput();
    pass.encode(encoder, input);
    expect(passes).toHaveLength(1);
    expect(passes[0]!.dispatches).toEqual([[2, 1, 1]]);
    // 8 槽:0..2 GBuffer/brdf,3 采样器,4 uniform,5 命中记录,6 输出,7 遮蔽记录。
    expect(f.bindGroups[0]!.entries.map((entry) => entry.binding)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    // 同一视图身份二次 encode 命中缓存(不重建 bind group)。
    pass.encode(encoder, input);
    expect(f.bindGroups).toHaveLength(1);
    // 任一视图身份变化 = 新绑定(LRU 4);遮蔽记录视图也参与缓存键(消费端逐槽对应)。
    pass.encode(encoder, { ...input, indirectionView: view("indirection-2") });
    expect(f.bindGroups).toHaveLength(2);
    pass.encode(encoder, { ...indirectionInput(), bounceShadingView: view("bounce-shading-2") });
    expect(f.bindGroups).toHaveLength(3);
    pass.destroy();
    expect(f.buffers[0]!.destroy).toHaveBeenCalled();
  });

  it("rejects dimension/param mismatches and non-finite shading inputs before any dispatch (sync fail-closed)", () => {
    const f = deviceStub(), pass = new RtSpecularIndirectionPass(f.device);
    const { encoder, passes } = encoderStub();
    expect(() => pass.encode(encoder, indirectionInput(0, 8))).toThrow(/positive integer/);
    const mismatched = indirectionInput();
    expect(() => pass.encode(encoder, { ...mismatched,
      params: { ...mismatched.params, width: 8 } })).toThrow(/must match/);
    const nanLight = indirectionInput();
    expect(() => pass.encode(encoder, { ...nanLight,
      params: { ...nanLight.params, lightIntensity: Number.NaN } })).toThrow(/finite/);
    expect(passes).toHaveLength(0);
    pass.destroy();
  });
});

describe("RtSpecularFillPass", () => {
  it("allocates only its own 16B uniform, dispatches 8x8 workgroups, caches by view identity", () => {
    const f = deviceStub(), pass = new RtSpecularFillPass(f.device);
    expect(f.buffers).toHaveLength(1);
    expect(f.buffers[0]!.size).toBe(RT_SPECULAR_FILL_PARAMS_BYTES);
    const { encoder, passes } = encoderStub();
    const input = { ssrOutputView: view("ssr-hdr"), ssrTraceView: view("ssr-trace"),
      indirectionView: view("indirection"), outputView: view("fill-out"), width: 17, height: 9 };
    pass.encode(encoder, input);
    expect(passes[0]!.dispatches).toEqual([[3, 2, 1]]);
    expect(f.bindGroups[0]!.entries.map((entry) => entry.binding)).toEqual([0, 1, 2, 3, 4, 5]);
    pass.encode(encoder, input);
    expect(f.bindGroups).toHaveLength(1);
    pass.encode(encoder, { ...input, outputView: view("fill-out-2") });
    expect(f.bindGroups).toHaveLength(2);
    expect(() => pass.encode(encoder, { ...input, width: 0 })).toThrow(/positive integer/);
    pass.destroy();
    expect(f.buffers[0]!.destroy).toHaveBeenCalled();
  });

  it("keeps the neutral bounce albedo pinned (no hidden energy inflation)", () => {
    expect(RT_SPECULAR_BOUNCE_ALBEDO).toBe(0.5);
  });
});
