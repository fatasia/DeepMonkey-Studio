// RT specular GI 二反弹切片测试(2026-10-06 后继切片,关闭登记「二反弹不做」边界):
// - closest 帧通道 secondBounce 档:基线/光照遮蔽档逐字节不变(既有 sha 钉值不动),
//   二反弹档新增第二命中腿(binding 11/12、镜面反射方向、遮蔽腿同式、fail-closed
//   miss/零遮蔽),f32/f16 各自 sha256 字节级钉死;
// - indirection 内核 secondBounce 档:基线逐字节不变,二反弹档新增 binding 8/9 与
//   Lambert 中继累加,sha256 钉死;
// - CPU 镜像:二跳累加公式独立重建、记录 2 miss = 一次反弹逐位、遮挡只归零二跳
//   直接项;
// - 执行器合同:secondBounce 缺视图 fail-fast;closest pass secondBounce 需 illumination。
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { emitRayTraceClosestFrameKernelWgsl, RAY_TRACE_CLOSEST_FRAME_SECOND_BOUNCE_BINDINGS } from "./rayTraceClosestFrameKernel.js";
import { emitRtSpecularIndirectionKernelWgsl, RT_SPECULAR_INDIRECTION_SECOND_BOUNCE_BINDINGS,
  RT_SPECULAR_BOUNCE_ALBEDO } from "./rtSpecularIndirectionKernel.js";
import { rtSpecularIndirectionRecordCpu, RT_SPECULAR_NEUTRAL_SHADING,
  type RtSpecularIndirectionCpuParams } from "./rtSpecularIndirectionCpu.js";
import { RayTraceClosestFramePass } from "./rayTraceClosestFramePass.js";
import { RtSpecularIndirectionPass } from "./rtSpecularFramePasses.js";
import type { TlasPackedScene } from "./tlasLayout.js";

const sha = (value: string): string => createHash("sha256").update(value).digest("hex");

// 二反弹档 sha256 钉值(2026-10-07:二跳遮蔽从真实偏移后命中点发射)。
const RAY_TRACE_CLOSEST_FRAME_SECOND_BOUNCE_F32_SHA256 =
  "f6b8098258bbafa66d93b8ebb65ab54e3ddac891a4cb6bab436aade84fdfd025";
const RAY_TRACE_CLOSEST_FRAME_SECOND_BOUNCE_F16_SHA256 =
  "6e66ce09bb3b45d64300bb5c84114801f8db76dc2fa0390dee60088c5174638b";
const RT_SPECULAR_INDIRECTION_SECOND_BOUNCE_SHA256 =
  "7e5c9d04c4c150b0ae149297e0efdd98c1280e4b4bdbf3520e96c7ea006ea98d";

const baseParams: RtSpecularIndirectionCpuParams = {
  tanHalfFov: 0.6, aspect: 1.5, surfaceToLightWorld: [0.2, 0.8, 0.55],
  lightColor: [1.0, 0.95, 0.9], lightIntensity: 3, envRadiance: [0.25, 0.3, 0.35], fresnelF0: 0.04,
};

const f32Wgsl = emitRayTraceClosestFrameKernelWgsl({ illumination: true, secondBounce: true });
const f16Wgsl = emitRayTraceClosestFrameKernelWgsl({ illumination: true, secondBounce: true, f16: true });
const indirectionWgsl = emitRtSpecularIndirectionKernelWgsl({ secondBounce: true });

describe("closest frame kernel second-bounce variant(二反弹档,保守单跳)", () => {
  it("基线与光照遮蔽档逐字节不变(secondBounce 缺省 = 既有发射)", () => {
    expect(emitRayTraceClosestFrameKernelWgsl({ illumination: true }))
      .toBe(emitRayTraceClosestFrameKernelWgsl({ illumination: true, secondBounce: false }));
    expect(emitRayTraceClosestFrameKernelWgsl())
      .toBe(emitRayTraceClosestFrameKernelWgsl({ secondBounce: true }));
  });

  it("二反弹档:binding 11/12 合同 + 第二命中腿结构(f32/f16 sha 钉死)", () => {
    expect(RAY_TRACE_CLOSEST_FRAME_SECOND_BOUNCE_BINDINGS).toHaveLength(13);
    expect(RAY_TRACE_CLOSEST_FRAME_SECOND_BOUNCE_BINDINGS[11]).toEqual(
      { binding: 11, name: "reflectionHit2", type: "storage-texture" });
    expect(RAY_TRACE_CLOSEST_FRAME_SECOND_BOUNCE_BINDINGS[12]).toEqual(
      { binding: 12, name: "bounceShading2", type: "storage-texture" });
    for (const wgsl of [f32Wgsl, f16Wgsl]) {
      expect(wgsl).toContain("@group(0) @binding(11) var reflectionHit2: texture_storage_2d<rgba32float, write>;");
      expect(wgsl).toContain("@group(0) @binding(12) var bounceShading2: texture_storage_2d<rgba32float, write>;");
      // 镜面反射方向(手动式,与首腿同式);第二跳 origin = 首命中点 + 反射方向×bias。
      expect(wgsl).toContain("let reflectDir2 = reflectDir - 2.0 * dot(reflectDir, hit.normal) * hit.normal;");
      expect(wgsl).toContain("let origin2 = hitPosition1 + reflectDir2 * params.biasAndPad.x;");
      // t2 is measured from the biased ray origin; visibility must use that same hit position.
      expect(wgsl).toContain("let hitPosition2 = origin2 + reflectDir2 * hit2.t;");
      // 第二遮蔽腿与首腿同式;miss/溢出 fail-closed 零能量。
      expect(wgsl).toContain("let found2 = traceTwoLevelClosest(origin2, reflectDir2, inv2, params.eyeAndMax.w,");
      expect(wgsl).toContain("visibility2 = select(1.0, 0.0, occluded2 || shadowOverflow2 != 0u);");
      expect(wgsl).toContain("textureStore(bounceShading2, px, vec4f(0.0));");
      // 帧级 miss(背景/邻域退化)同步清零第二记录。
      expect(wgsl).toContain("textureStore(reflectionHit2, px, vec4f(-1.0, 0.0, 0.0, 0.0));");
    }
    // sha256 字节级钉死(f32/f16 各自;光照遮蔽档钉值在既有测试未动)。
    expect(sha(f32Wgsl)).toBe(RAY_TRACE_CLOSEST_FRAME_SECOND_BOUNCE_F32_SHA256);
    expect(sha(f16Wgsl)).toBe(RAY_TRACE_CLOSEST_FRAME_SECOND_BOUNCE_F16_SHA256);
  });
});

describe("indirection kernel second-bounce variant(二反弹累积)", () => {
  it("基线逐字节不变;二反弹档 binding 8/9 + Lambert 中继累加,sha 钉死", () => {
    expect(emitRtSpecularIndirectionKernelWgsl()).toBe(emitRtSpecularIndirectionKernelWgsl({ secondBounce: false }));
    expect(RT_SPECULAR_INDIRECTION_SECOND_BOUNCE_BINDINGS).toHaveLength(10);
    expect(RT_SPECULAR_INDIRECTION_SECOND_BOUNCE_BINDINGS[8]).toEqual(
      { binding: 8, name: "rtHitRecord2", type: "texture" });
    expect(RT_SPECULAR_INDIRECTION_SECOND_BOUNCE_BINDINGS[9]).toEqual(
      { binding: 9, name: "bounceShading2", type: "texture" });
    expect(indirectionWgsl).toContain("@group(0) @binding(8) var rtHitRecord2: texture_2d<f32>;");
    expect(indirectionWgsl).toContain("@group(0) @binding(9) var bounceShading2: texture_2d<f32>;");
    // 累加式与 CPU 镜像同序:oneBounce += bounceAlbedo * ((direct2 + env) * albedo2)。
    expect(indirectionWgsl).toContain(
      "oneBounce = oneBounce + bounceAlbedo * ((direct2 + indirectionParams.envRadiance.rgb) * albedo2);");
    expect(indirectionWgsl).toContain("var oneBounce");
    expect(emitRtSpecularIndirectionKernelWgsl()).toContain("let oneBounce");
    expect(sha(indirectionWgsl)).toBe(RT_SPECULAR_INDIRECTION_SECOND_BOUNCE_SHA256);
  });
});

describe("indirection CPU mirror second bounce(二跳累加)", () => {
  const record: readonly [number, number, number, number] = [2.5, 0, 1, 0];
  const record2: readonly [number, number, number, number] = [3.5, 0.6, 0.64, 0.48];
  const shading = { albedo: [0.6, 0.5, 0.4] as const, visibility: 1 };
  const shading2 = { albedo: [0.8, 0.7, 0.6] as const, visibility: 0.5 };

  it("记录 2 miss(t2<=0)= 一次反弹逐位一致;未给二跳参数同", () => {
    const firstOnly = rtSpecularIndirectionRecordCpu(record, [0, 0, 1], 0.25, 4, 3, 4, 8, 8, baseParams);
    const missRecords = [{ record: [-1, 0, 0, 0] }, { record: [0, 0, 0, 0] }] as const;
    for (const second of missRecords) {
      const withSecond = rtSpecularIndirectionRecordCpu(record, [0, 0, 1], 0.25, 4, 3, 4, 8, 8, baseParams,
        RT_SPECULAR_NEUTRAL_SHADING, second);
      expect(withSecond).toEqual(firstOnly);
    }
  });

  it("二跳累加 = 首跳 + 首命中反照率 ×(第二命中点同式解析辐射),独立重建逐值一致", () => {
    const out = rtSpecularIndirectionRecordCpu(record, [0, 0, 1], 0.25, 4, 3, 4, 8, 8, baseParams,
      shading, { record: record2, shading: shading2 });
    const firstOnly = rtSpecularIndirectionRecordCpu(record, [0, 0, 1], 0.25, 4, 3, 4, 8, 8, baseParams, shading);
    const fraction = firstOnly[3]!;
    const albedo2 = [Math.min(1, Math.max(0, shading2.albedo[0])),
      Math.min(1, Math.max(0, shading2.albedo[1])), Math.min(1, Math.max(0, shading2.albedo[2]))];
    // 独立重建二跳解析辐射(与镜像同式,逐通道手写)。
    const ndotl2 = Math.min(1, Math.max(0,
      record2[1]! * baseParams.surfaceToLightWorld[0]! + record2[2]! * baseParams.surfaceToLightWorld[1]!
        + record2[3]! * baseParams.surfaceToLightWorld[2]!));
    for (let channel = 0; channel < 3; channel++) {
      const direct2 = ndotl2 * baseParams.lightColor[channel]! * baseParams.lightIntensity
        * shading2.visibility;
      const secondRadiance = (direct2 + baseParams.envRadiance[channel]!) * albedo2[channel]!;
      // firstOnly 已含首跳×fraction;期望 = 首跳×fraction + fraction×albedo×二跳辐射。
      const expected = firstOnly[channel]! + fraction * (shading.albedo[channel]! * secondRadiance);
      expect(out[channel]).toBeCloseTo(expected, 12);
    }
    expect(out[3]).toBe(firstOnly[3]);
    // 二跳带来严格增量(可见性 0.5、正环境项)。
    expect(out[0]).toBeGreaterThan(firstOnly[0]!);
  });

  it("第二跳遮挡只归零二跳直接项(严格更暗;同输入确定性逐位一致)", () => {
    const litSecond = rtSpecularIndirectionRecordCpu(record, [0, 0, 1], 0.25, 4, 3, 4, 8, 8, baseParams,
      shading, { record: record2, shading: { albedo: [0.8, 0.7, 0.6], visibility: 1 } });
    const occludedSecond = rtSpecularIndirectionRecordCpu(record, [0, 0, 1], 0.25, 4, 3, 4, 8, 8, baseParams,
      shading, { record: record2, shading: { albedo: [0.8, 0.7, 0.6], visibility: 0 } });
    const occludedRepeat = rtSpecularIndirectionRecordCpu(record, [0, 0, 1], 0.25, 4, 3, 4, 8, 8, baseParams,
      shading, { record: record2, shading: { albedo: [0.8, 0.7, 0.6], visibility: 0 } });
    for (let channel = 0; channel < 3; channel++) {
      expect(occludedSecond[channel]).toBeLessThan(litSecond[channel]!);
      expect(occludedSecond[channel]).toBe(occludedRepeat[channel]);
    }
  });

  it("中性反照率常量与登记合同一致(0.5;中继能量有界,无超量注入)", () => {
    expect(RT_SPECULAR_BOUNCE_ALBEDO).toBe(0.5);
  });
});

describe("executor contracts(执行器 fail-fast)", () => {
  function deviceStub() {
    const bindGroups: Array<{ entries: Array<{ binding: number; resource: unknown }> }> = [];
    const device = {
      features: new Set<string>(),
      pushErrorScope: vi.fn(), popErrorScope: vi.fn(async () => null),
      queue: { writeBuffer: vi.fn() },
      createBuffer: vi.fn((descriptor: { size: number; usage: number }) => (
        { size: descriptor.size, usage: descriptor.usage, destroy: vi.fn() })),
      createShaderModule: vi.fn(() => ({})),
      createBindGroupLayout: vi.fn((descriptor: { entries: GPUBindGroupLayoutEntry[] }) => {
        // A device requested without raised limits permits four storage textures.
        if (descriptor.entries.filter(entry => entry.storageTexture).length > 4) {
          throw new Error("baseline storage texture limit exceeded");
        }
        return {};
      }),
      createPipelineLayout: vi.fn(() => ({})),
      createComputePipeline: vi.fn(() => ({ getBindGroupLayout: () => ({}) })),
      createSampler: vi.fn(() => ({})),
      createBindGroup: vi.fn((descriptor: { entries: Array<{ binding: number; resource: unknown }> }) => {
        const group = { entries: descriptor.entries }; bindGroups.push(group); return group;
      }),
      limits: { maxInstances: 1_000_000 },
    };
    return { device: device as unknown as GPUDevice, bindGroups };
  }

  // indirection 布局构造引用 GPUShaderStage 全局(rtSpecularFramePasses.test 同款 stub)。
  vi.stubGlobal("GPUShaderStage", { COMPUTE: 1 });

  const scene = { instanceCount: 1, tlasNodeCount: 1, blasNodeCount: 4, triangleCount: 2,
    recordBytes: new ArrayBuffer(128), nodeBytes: new ArrayBuffer(240),
    vertices: new Float32Array(9), indices: new Uint32Array(3), order: new Uint32Array(1),
    placements: Object.freeze([]) } as unknown as TlasPackedScene;

  it("closest pass:secondBounce 无 illumination 构造即抛;encode 缺二跳视图即抛", async () => {
    const stub = deviceStub();
    expect(() => new RayTraceClosestFramePass(stub.device, scene, { secondBounce: true })).toThrow(/illumination/);
    const pass = new RayTraceClosestFramePass(stub.device, scene, { illumination: true, secondBounce: true });
    const view = {} as GPUTextureView;
    await expect(pass.encode({} as GPUCommandEncoder, { depthView: view, hitView: view,
      bounceShadingView: view, width: 8, height: 8,
      invViewProjection: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], eye: [0, 0, 0],
      tMax: 10, bias: 0.01, rayMask: 1, lightDirectionWorld: [0, 1, 0] })).rejects.toThrow(/hit2View/);
  });

  it("indirection pass:secondBounce 缺二跳视图 encode 即抛;视图齐备时绑定 10 槽", () => {
    const stub = deviceStub();
    const pass = new RtSpecularIndirectionPass(stub.device, { secondBounce: true });
    const view = {} as GPUTextureView;
    // encoder stub:走到 dispatch 才算通过(绑定组构造已在 stub.bindGroups 记账)。
    const encoder = { beginComputePass: vi.fn(() => ({ setPipeline: vi.fn(), setBindGroup: vi.fn(),
      dispatchWorkgroups: vi.fn(), end: vi.fn() })) } as unknown as GPUCommandEncoder;
    expect(() => pass.encode(encoder, { linearDepthView: view, viewNormalView: view,
      brdfLutView: view, rtHitView: view, bounceShadingView: view, indirectionView: view,
      width: 8, height: 8, params: { width: 8, height: 8, ...baseParams } })).toThrow(/rtHit2View/);
    expect(() => pass.encode(encoder, { linearDepthView: view, viewNormalView: view,
      brdfLutView: view, rtHitView: view, bounceShadingView: view, rtHit2View: view,
      bounceShading2View: view, indirectionView: view, width: 8, height: 8,
      params: { width: 8, height: 8, ...baseParams } })).not.toThrow();
    expect(stub.bindGroups[0]!.entries).toHaveLength(10);
    expect(stub.bindGroups[0]!.entries.map(entry => entry.binding)).toEqual(
      RT_SPECULAR_INDIRECTION_SECOND_BOUNCE_BINDINGS.map(entry => entry.binding));
    pass.destroy();
  });
});
