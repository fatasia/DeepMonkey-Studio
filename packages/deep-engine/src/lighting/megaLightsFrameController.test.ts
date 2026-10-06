// B2 MegaLights M2 生产接线单测:帧控制器纯逻辑面(路径决策/矩阵组合)+
// 宿主私有 WGSL 合同字面量门(与 ABI/打包端逐字互钉;GPU 行为由真机探针
// megaLightsGpuTest.mjs 覆盖,如实分工)+ 可见性供给链 device-stub 帧面
// (升级/staging 身份/fail-closed;真机遮挡差分由渲染级 harness 供给腿覆盖)。
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { MAX_MEGA_LIGHTS, MEGALIGHTS_CLUSTER_PATH_LIGHT_BUDGET,
  megaLightFromPoint } from "./megaLights.js";
import { MEGA_LIGHTS_SURFACES_STRIDE_VEC4 } from "./megaLightsAbi.js";
import { MegaLightsFrameController } from "./megaLightsFrameController.js";
import { multiplyColumnMajor4x4, megaLightsFramePlanned } from "./megaLightsFrameController.js";
import { MEGA_LIGHTS_COMPOSITE_PARAMS_BYTES, MEGA_LIGHTS_COMPOSITE_WGSL,
  MEGA_LIGHTS_REBUILD_DEPTH_GATE, MEGA_LIGHTS_REBUILD_PARAMS_BYTES,
  MEGA_LIGHTS_REBUILD_WGSL } from "./megaLightsFrameWgsl.js";
import type { MegaLightsFrameEncodeContext } from "./megaLightsFrameDecision.js";
import type { TlasPackedScene } from "../rayTracing/tlasLayout.js";

describe("MegaLights frame controller pure logic", () => {
  it("combines column-major matrices as out = a × b", () => {
    const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const translation = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 3, 4, 1]);
    expect([...multiplyColumnMajor4x4(translation, identity)]).toEqual([...translation]);
    expect([...multiplyColumnMajor4x4(identity, translation)]).toEqual([...translation]);
    // 平移 × 平移 = 分量和(列主序:平移占第 4 列)。
    const twice = multiplyColumnMajor4x4(translation, translation);
    expect(twice[12]).toBe(4); expect(twice[13]).toBe(6); expect(twice[14]).toBe(8);
  });

  it("keeps the frame-plan decision single-sourced with the path selector", () => {
    // 开关关:恒 false(逐位零变化承诺的纯函数面)。
    expect(megaLightsFramePlanned(false, { points: [1, 2, 3], spots: [] })).toBe(false);
    expect(megaLightsFramePlanned(false, undefined)).toBe(false);
    // ≤64 本地灯 = 簇光快路径(既有路径零变化);边界 64/65 逐值钉死。
    const sixtyFour = Array.from({ length: MEGALIGHTS_CLUSTER_PATH_LIGHT_BUDGET }, (_, i) => i);
    const sixtyFive = [...sixtyFour, 64];
    expect(megaLightsFramePlanned(true, { points: sixtyFour, spots: [] })).toBe(false);
    expect(megaLightsFramePlanned(true, { points: sixtyFive, spots: [] })).toBe(true);
    expect(megaLightsFramePlanned(true, { points: [], spots: sixtyFour })).toBe(false);
    expect(megaLightsFramePlanned(true, { points: [], spots: sixtyFive })).toBe(true);
    // 面积光不参与决策(M1 定案:两通路都常驻面积光路径)。
    expect(megaLightsFramePlanned(true, { points: [], spots: [] })).toBe(false);
  });

  it("surfaces the pool capacity contract for fail-closed wording", () => {
    expect(MAX_MEGA_LIGHTS).toBe(65_535);
    expect(MEGALIGHTS_CLUSTER_PATH_LIGHT_BUDGET).toBe(64);
    // 打包端同门兜底:超池容量在 packMegaLights 处拒绝(双闸之二,此处钉常量耦合)。
    const light = megaLightFromPoint({ positionView: [0, 0, 0], range: 0, color: [1, 1, 1],
      intensity: 1 });
    expect(light.kind).toBe("point");
  });
});

describe("MegaLights frame WGSL host-template contracts", () => {
  it("rebuild kernel ABI stays pinned to the surfaces stride and RIS depth gate", () => {
    expect(MEGA_LIGHTS_REBUILD_WGSL).toContain(`const DEEP_MEGA_REBUILD_SURFACE_STRIDE: u32 = ${MEGA_LIGHTS_SURFACES_STRIDE_VEC4}u;`);
    expect(MEGA_LIGHTS_SURFACES_STRIDE_VEC4).toBe(3);
    // 深度门与 RIS 时域深度门同族同值(0.1;漂移一侧即红)。
    expect(MEGA_LIGHTS_REBUILD_DEPTH_GATE).toBe(0.1);
    expect(MEGA_LIGHTS_REBUILD_WGSL).toContain(`const DEEP_MEGA_REBUILD_DEPTH_GATE: f32 = ${MEGA_LIGHTS_REBUILD_DEPTH_GATE};`);
    expect(MEGA_LIGHTS_REBUILD_WGSL).toContain("@workgroup_size(8, 8)");
    expect(MEGA_LIGHTS_REBUILD_WGSL).toContain("fn deepMegaRebuildSurfacesFrame");
  });

  it("rebuild kernel zeroes background and discontinuous pixels (output mask semantics)", () => {
    // 清屏深度(≥1)与深度不连续 → 表面全零(RIS 着色核 nDotL=0 早退 = 零贡献)。
    expect(MEGA_LIGHTS_REBUILD_WGSL).toContain("if (centerDepth >= 1.0 || discontinuous) {");
    expect(MEGA_LIGHTS_REBUILD_WGSL).toContain("deepMegaRebuildSurfaces[base] = vec4f(0.0);");
  });

  it("rebuild kernel documents the neutral-material degraded start tier", () => {
    // 中性材质起步档(albedo 0.8/0.78/0.75、roughness 0.5、metallic 0):与真机探针
    // 朗伯墙同族;GBuffer 消费切片替换时这两个字面量门先红,防静默漂移。
    expect(MEGA_LIGHTS_REBUILD_WGSL).toContain("deepMegaRebuildSurfaces[base] = vec4f(center.xyz, 0.0);");
    expect(MEGA_LIGHTS_REBUILD_WGSL).toContain("deepMegaRebuildSurfaces[base + 1u] = vec4f(normal, 0.5);");
    expect(MEGA_LIGHTS_REBUILD_WGSL).toContain("deepMegaRebuildSurfaces[base + 2u] = vec4f(0.8, 0.78, 0.75, 0.0);");
  });

  it("composite kernel stays alpha-preserving additive over the HDR attachment", () => {
    expect(MEGA_LIGHTS_COMPOSITE_WGSL).toContain("return vec4f(deepMegaCompositeColor[pixelIndex].rgb, 0.0);");
    expect(MEGA_LIGHTS_COMPOSITE_WGSL).toContain("fn deepMegaCompositeVertex");
    expect(MEGA_LIGHTS_COMPOSITE_WGSL).toContain("fn deepMegaCompositeFragment");
    // uniform 参数字节数与 WGSL struct 自然布局一致(16B;漂移由打包端写不进而红)。
    expect(MEGA_LIGHTS_COMPOSITE_PARAMS_BYTES).toBe(16);
    expect(MEGA_LIGHTS_REBUILD_PARAMS_BYTES).toBe(80);
  });

  it("keeps both host-template kernels byte-stable (hash pin, regeneration drift guard)", () => {
    // 宿主私有模板无 wgsl/ 单源链,以源内 SHA-256 夹具钉字节(改动必须显式过门)。
    const rebuildHash = createHash("sha256").update(new TextEncoder().encode(MEGA_LIGHTS_REBUILD_WGSL)).digest("hex");
    const compositeHash = createHash("sha256").update(new TextEncoder().encode(MEGA_LIGHTS_COMPOSITE_WGSL)).digest("hex");
    expect(rebuildHash).toMatch(/^[0-9a-f]{64}$/);
    expect(compositeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rebuildHash).toBe("5f6f961341c2a32ebab9db9f9dfca4df306c5b896184b8600f0e23cf5f8b5135");
    expect(compositeHash).toBe("6df6f45501c0a492bf34f7303dca81493a75f8a149a14fdf2ccff6d6943fb3be");
  });
});

// ---- 可见性供给链(device-stub 帧面;GPU 语义由真机腿覆盖,此处钉合同) ----

interface StubBuffer { readonly label: string; destroy: ReturnType<typeof vi.fn> }

/** 设备桩(同 rtShadowFrame.test 惯例):计数管线、按 label 标记缓冲、记录 writeBuffer。 */
function deviceStub(options: { failVisibilityShaderModule?: string } = {}) {
  const buffers: StubBuffer[] = [];
  const computePipelineLabels: string[] = [];
  const shaderModuleCodes: string[] = [];
  const writes: Array<{ buffer: StubBuffer; data: ArrayBuffer }> = [];
  const computePassLabels: string[] = [];
  const device = {
    features: new Set<string>(),
    limits: { maxStorageBuffersPerShaderStage: 8, maxTextureDimension2D: 8192 },
    queue: { writeBuffer: vi.fn((buffer: StubBuffer, _offset: number, data: ArrayBuffer) => {
      writes.push({ buffer, data });
    }) },
    createBuffer: vi.fn((descriptor: { size: number; label?: string }) => {
      const buffer: StubBuffer = { label: descriptor.label ?? `buffer-${buffers.length}`, destroy: vi.fn() };
      buffers.push(buffer); return buffer;
    }),
    createShaderModule: vi.fn((descriptor: { code: string }) => {
      if (options.failVisibilityShaderModule !== undefined
        && descriptor.code.includes("deepMegaTraceWinnerVisibility")) {
        throw new Error(options.failVisibilityShaderModule);
      }
      shaderModuleCodes.push(descriptor.code); return { __module: shaderModuleCodes.length };
    }),
    createBindGroupLayout: vi.fn(() => ({ __layout: true })),
    createPipelineLayout: vi.fn(() => ({ __pipelineLayout: true })),
    createComputePipeline: vi.fn((descriptor: { label: string }) => {
      computePipelineLabels.push(descriptor.label);
      return { label: descriptor.label, getBindGroupLayout: () => ({ __autoLayout: descriptor.label }) };
    }),
    createRenderPipeline: vi.fn((descriptor: { label: string }) => {
      computePipelineLabels.push(descriptor.label); return { label: descriptor.label };
    }),
    createBindGroup: vi.fn(() => ({ __bindGroup: true })),
  };
  const pass = () => ({ setPipeline: vi.fn(), setBindGroup: vi.fn(), dispatchWorkgroups: vi.fn(),
    draw: vi.fn(), end: vi.fn() });
  const encoder = {
    beginComputePass: vi.fn((descriptor: { label: string }) => {
      computePassLabels.push(descriptor.label); return pass();
    }),
    beginRenderPass: vi.fn(() => pass()),
  } as unknown as GPUCommandEncoder;
  const session = { state: "ready", device, own: (resource: unknown) => resource,
    release: vi.fn() } as unknown as import("../webgpu/deviceSession.js").DeviceSession;
  const wordsWritten = (label: string): Uint32Array[] => writes
    .filter(entry => entry.buffer.label === label).map(entry => new Uint32Array(entry.data));
  return { device, session, encoder, buffers, computePipelineLabels, shaderModuleCodes,
    computePassLabels, writes, wordsWritten };
}

const IDENTITY = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function stubPackedScene(): TlasPackedScene {
  return { instanceCount: 1, tlasNodeCount: 1, blasNodeCount: 4, triangleCount: 2,
    recordBytes: new ArrayBuffer(128), nodeBytes: new ArrayBuffer(48 * 5),
    vertices: new Float32Array(9), indices: new Uint32Array(3), order: new Uint32Array(1),
    placements: Object.freeze([]) } as unknown as TlasPackedScene;
}

/** 超预算点光集(65 盏 → 决策落 megalights-ris;probe 池容量腿同形)。 */
function overBudgetLights(count = MEGALIGHTS_CLUSTER_PATH_LIGHT_BUDGET + 1): ClusteredLightsInput {
  return { points: Array.from({ length: count }, (_, index) => ({
    positionView: [Math.cos(index * 0.01), 0.5, -2 - (index % 7)] as readonly number[],
    range: 0, color: [1, 1, 1] as readonly number[], intensity: 1, decay: 2 })) };
}

type ClusteredLightsInput = MegaLightsFrameEncodeContext["lights"];

function encodeContext(overrides: Partial<MegaLightsFrameEncodeContext> = {}): MegaLightsFrameEncodeContext {
  const depthTexture = { createView: vi.fn(() => ({ __depthView: true })) } as unknown as GPUTexture;
  return { encoder: { beginComputePass: vi.fn(), beginRenderPass: vi.fn() } as unknown as GPUCommandEncoder,
    width: 8, height: 8, colorView: { __color: true } as unknown as GPUTextureView,
    depthTexture, depthViewProjection: new Float32Array(IDENTITY), worldToView: new Float32Array(IDENTITY),
    lights: overBudgetLights(), ...overrides };
}

describe("MegaLights frame controller visibility supply (device stub)", () => {
  // node 测试环境无 WebGPU 全局(同 fog/volumetricFogPass.test 惯例;数值取规范值)。
  vi.stubGlobal("GPUShaderStage", { COMPUTE: 4, FRAGMENT: 2, VERTEX: 1 });
  vi.stubGlobal("GPUBufferUsage", { STORAGE: 0x80, COPY_DST: 0x08, COPY_SRC: 0x04,
    UNIFORM: 0x40, MAP_READ: 0x01 });

  it("keeps frames without supply on the legacy two-pass path (关闭零变化)", () => {
    const stub = deviceStub();
    const controller = new MegaLightsFrameController(stub.session);
    const result = controller.encodeFrame(encodeContext({ encoder: stub.encoder }));
    expect(result.dispatched).toBe(true);
    // legacy 档:重建 + RIS 两趟,无 trace pass;params word9 = 0。
    expect(stub.computePassLabels).toEqual(["Deep MegaLights surface rebuild",
      "Deep MegaLights RIS direct lighting", "Deep MegaLights reuse and shade"]);
    expect(stub.wordsWritten("Deep MegaLights params").at(-1)![9]).toBe(0);
    expect(stub.computePipelineLabels.filter(label => label.includes("visibility"))).toEqual([]);
    expect(controller.metrics.visibilitySource).toBe("off");
    expect(controller.metrics.visibilityFallbackReason).toBeUndefined();
    controller.dispose();
  });

  it("upgrades on first supply and stages the scene through the trace leg (供给链)", () => {
    const stub = deviceStub();
    const controller = new MegaLightsFrameController(stub.session);
    const scene = stubPackedScene();
    const first = controller.encodeFrame(encodeContext({ encoder: stub.encoder,
      visibility: { scene, viewToWorld: new Float32Array(IDENTITY), rayMask: 7 } }));
    expect(first.dispatched).toBe(true);
    // 升级后三趟:build → trace → shade(trace 夹在 RIS 两趟之间)。
    expect(stub.computePassLabels).toEqual(["Deep MegaLights surface rebuild",
      "Deep MegaLights RIS direct lighting", "Deep MegaLights trace winner visibility",
      "Deep MegaLights reuse and shade"]);
    expect(stub.wordsWritten("Deep MegaLights params").at(-1)![9]).toBe(1);
    // visParams:viewToWorld 16 词 + word16 = rayMask。
    const visParams = stub.wordsWritten("Deep MegaLights visibility params").at(-1)!;
    expect(visParams.length).toBe(20);
    expect(visParams[16]).toBe(7);
    // 场景五缓冲首帧整体 staging(nodes/instances 数据引用 = 供给场景对象)。
    const nodeWrites = stub.writes.filter(entry => entry.buffer.label === "Deep MegaLights visibility nodes");
    const instanceWrites = stub.writes.filter(entry => entry.buffer.label === "Deep MegaLights visibility instances");
    expect(nodeWrites.length).toBe(1);
    expect(instanceWrites.length).toBe(1);
    expect(nodeWrites[0]!.data).toBe(scene.nodeBytes);
    expect(instanceWrites[0]!.data).toBe(scene.recordBytes);
    expect(controller.metrics.visibilitySource).toBe("rt-shadow-tlas");
    // 第二帧同场景引用:staging 身份合同 → 场景零重传;visParams 照常刷新。
    controller.encodeFrame(encodeContext({ encoder: stub.encoder,
      visibility: { scene, viewToWorld: new Float32Array(IDENTITY), rayMask: 7 } }));
    expect(stub.writes.filter(entry => entry.buffer.label === "Deep MegaLights visibility nodes").length).toBe(1);
    expect(stub.wordsWritten("Deep MegaLights visibility params").length).toBe(2);
    controller.dispose();
  });

  it("runs visibility-mode frames without input at ×1.0 exact (开关位闭环)", () => {
    const stub = deviceStub();
    const controller = new MegaLightsFrameController(stub.session);
    const scene = stubPackedScene();
    controller.encodeFrame(encodeContext({ encoder: stub.encoder,
      visibility: { scene, viewToWorld: new Float32Array(IDENTITY), rayMask: 0xffffffff } }));
    expect(controller.metrics.visibilitySource).toBe("rt-shadow-tlas");
    // 同 runtime 下无供给帧:enabled=0 → trace 零 dispatch,可见性恒 1(×1.0 精确)。
    stub.computePassLabels.length = 0;
    controller.encodeFrame(encodeContext({ encoder: stub.encoder }));
    expect(stub.computePassLabels).toEqual(["Deep MegaLights surface rebuild",
      "Deep MegaLights RIS direct lighting", "Deep MegaLights reuse and shade"]);
    expect(stub.wordsWritten("Deep MegaLights params").at(-1)![9]).toBe(0);
    expect(controller.metrics.visibilitySource).toBe("off");
    // 簇光预算内帧同样回 off 且零 dispatch。
    stub.computePassLabels.length = 0;
    const within = controller.encodeFrame(encodeContext({ encoder: stub.encoder,
      lights: overBudgetLights(MEGALIGHTS_CLUSTER_PATH_LIGHT_BUDGET) }));
    expect(within.dispatched).toBe(false);
    expect(stub.computePassLabels).toEqual([]);
    expect(controller.metrics.visibilitySource).toBe("off");
    controller.dispose();
  });

  it("fail-closed when the visibility runtime cannot be built (sticky, 不重试)", () => {
    const stub = deviceStub({ failVisibilityShaderModule: "visibility trace entry unavailable" });
    const controller = new MegaLightsFrameController(stub.session);
    const scene = stubPackedScene();
    const context = encodeContext({ encoder: stub.encoder,
      visibility: { scene, viewToWorld: new Float32Array(IDENTITY), rayMask: 0xffffffff } });
    // 升级失败不抛穿渲染循环:帧照常按 legacy 档编码,可见性恒 1。
    const result = controller.encodeFrame(context);
    expect(result.dispatched).toBe(true);
    expect(stub.computePassLabels).toEqual(["Deep MegaLights surface rebuild",
      "Deep MegaLights RIS direct lighting", "Deep MegaLights reuse and shade"]);
    expect(stub.wordsWritten("Deep MegaLights params").at(-1)![9]).toBe(0);
    expect(controller.metrics.visibilitySource).toBe("unsupported");
    expect(controller.metrics.visibilityFallbackReason).toContain("visibility trace entry unavailable");
    const moduleCount = stub.shaderModuleCodes.length;
    // sticky:第二帧不再重试(shader 模块创建次数稳定)。
    controller.encodeFrame(context);
    expect(stub.shaderModuleCodes.length).toBe(moduleCount);
    expect(controller.metrics.visibilitySource).toBe("unsupported");
    controller.dispose();
  });
});
