import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { emitRtSpecularIndirectionKernelWgsl, packRtSpecularIndirectionUniform,
  RT_SPECULAR_BOUNCE_ALBEDO, RT_SPECULAR_INDIRECTION_BINDINGS,
  RT_SPECULAR_INDIRECTION_ENTRY_POINT, RT_SPECULAR_INDIRECTION_PARAMS_BYTES } from "./rtSpecularIndirectionKernel.js";
import { emitRtSpecularFillKernelWgsl, packRtSpecularFillUniform,
  RT_SPECULAR_FILL_BINDINGS, RT_SPECULAR_FILL_ENTRY_POINT, RT_SPECULAR_FILL_PARAMS_BYTES } from "./rtSpecularFillKernel.js";
import { rtSpecularFillCompositeCpu, rtSpecularIndirectionRecordCpu, RT_SPECULAR_NEUTRAL_SHADING } from "./rtSpecularIndirectionCpu.js";
import { ssrBrdfSpecularFractionCpu } from "../postprocess/ssrBrdfFraction.js";

/**
 * RT specular GI 家族合同(2026-10-06 P1 质量主线切片;同日遮蔽+反照率切片更新钉值):
 * - 两内核 WGSL sha256 字节级钉死(同族 rayTraceClosestFrameKernel.test 惯例);
 *   有意变更必须更新钉值 + 复核 SSR 高光分数语义 + 真机对拍后入库。indirection 钉值
 *   变更 = 增 bounceShading 遮蔽记录消费(直接项乘命中点→光源可见性,反照率取命中
 *   实例材质;无表供给 = 执行器预填中性 0.5),fill 内核未动(钉值不变)。
 * - CPU 镜像 = 可执行规格:命中/miss 语义、SSR 优先透传、双 miss 零变化、
 *   替换换手式逐值断言;高光分数与 SSR 单源(ssrBrdfSpecularFractionCpu)对拍;
 *   遮蔽 on/off 与反照率 on/off 差分逐值断言(中性基线 == 旧公式恒等)。
 * - ABI:两 pass 只用自有 uniform(96B/16B),帧 uniform(frameAbi 单源)不借位。
 */
const RT_SPECULAR_INDIRECTION_SHA256 = "070ece75ab9e0e57507d6e8f14b944d4ac101a720203a2bc40e0f8d5064350db";
const RT_SPECULAR_FILL_SHA256 = "310e450813a03933171380dad50948fd17aaee07cb6b3162ac8bdbe79999d975";

const baseParams = {
  tanHalfFov: Math.tan(Math.PI / 6), aspect: 1.5,
  surfaceToLightWorld: [0.4, 0.8, -0.45] as const,
  lightColor: [1.0, 0.96, 0.9] as const, lightIntensity: 3.2,
  envRadiance: [0.05, 0.06, 0.08] as const, fresnelF0: 0.05,
};

describe("rt specular indirection kernel generation contract", () => {
  const wgsl = emitRtSpecularIndirectionKernelWgsl();

  it("is byte-stable across emissions (sha256 pin)", () => {
    expect(createHash("sha256").update(wgsl).digest("hex")).toBe(RT_SPECULAR_INDIRECTION_SHA256);
  });

  it("binds gbuffer/brdf/record/indirection/shading in executor order (8 slots)", () => {
    expect(RT_SPECULAR_INDIRECTION_BINDINGS).toHaveLength(8);
    RT_SPECULAR_INDIRECTION_BINDINGS.forEach((entry, index) => {
      expect(entry.binding).toBe(index);
      expect(wgsl).toContain(`@binding(${index})`);
      expect(wgsl).toContain(`${entry.name}:`);
    });
    expect(wgsl).toContain("var linearDepthTex: texture_2d<f32>;");
    expect(wgsl).toContain("var viewNormalTex: texture_2d<f32>;");
    expect(wgsl).toContain("var rtHitRecord: texture_storage_2d<rgba32float, read>;");
    expect(wgsl).toContain("var rtIndirection: texture_storage_2d<rgba16float, write>;");
    // 遮蔽记录(帧通道 illumination 档产出)与命中记录同族 rgba32float 只读。
    expect(wgsl).toContain("var bounceShading: texture_storage_2d<rgba32float, read>;");
    // 自有 uniform:恰好一条 uniform buffer 绑定,不触碰帧 uniform 槽位(frameAbi 单源)。
    expect(wgsl.match(/var<uniform>/gu)).toHaveLength(1);
    expect(RT_SPECULAR_INDIRECTION_PARAMS_BYTES).toBe(96);
  });

  it("declares the 8x8 entry point with fail-closed miss and one-bounce shading", () => {
    expect(wgsl).toContain(`fn ${RT_SPECULAR_INDIRECTION_ENTRY_POINT}(@builtin(global_invocation_id) gid: vec3u)`);
    expect(wgsl).toContain("@workgroup_size(8, 8, 1)");
    // miss fail-closed:t<=0(帧通道 miss)/深度非正 一律写全零,不产生虚假能量。
    expect(wgsl).toContain("if (!(record.x > 0.0)) { rtIndirectionStoreMiss(px); return; }");
    expect(wgsl).toContain("if (!(linearDepth > 0.0)) { rtIndirectionStoreMiss(px); return; }");
    // SSR 同款 N·V 重建与高光分数;解析一次反弹 = N·L 主方向光 + 环境项。
    expect(wgsl).toContain("let cosTheta = clamp(-dot(viewNormal, incident), 0.0, 1.0);");
    expect(wgsl).toContain("rtSpecSpecularFraction(cosTheta, roughness, indirectionParams.misc.x)");
    expect(wgsl).toContain("clamp(dot(hitNormal, indirectionParams.lightDirection.xyz), 0.0, 1.0)");
    // 遮蔽+反照率语义:直接光项乘帧通道可见性,反照率逐通道 clamp 后乘入。
    expect(wgsl).toContain("let shading = textureLoad(bounceShading, vec2<i32>(px));");
    expect(wgsl).toContain("let bounceAlbedo = clamp(shading.rgb, vec3f(0.0), vec3f(1.0));");
    expect(wgsl).toContain("* shading.a;");
    expect(wgsl).toContain("let oneBounce = (direct + indirectionParams.envRadiance.rgb) * bounceAlbedo;");
    expect(RT_SPECULAR_BOUNCE_ALBEDO).toBe(0.5);
  });
});

describe("rt specular fill kernel generation contract", () => {
  const wgsl = emitRtSpecularFillKernelWgsl();

  it("is byte-stable across emissions (sha256 pin)", () => {
    expect(createHash("sha256").update(wgsl).digest("hex")).toBe(RT_SPECULAR_FILL_SHA256);
  });

  it("binds ssr output/trace/indirection with composite-priority semantics (6 slots)", () => {
    expect(RT_SPECULAR_FILL_BINDINGS).toHaveLength(6);
    RT_SPECULAR_FILL_BINDINGS.forEach((entry, index) => {
      expect(entry.binding).toBe(index);
      expect(wgsl).toContain(`@binding(${index})`);
      expect(wgsl).toContain(`${entry.name}:`);
    });
    expect(wgsl).toContain("var ssrOutput: texture_2d<f32>;");
    expect(wgsl).toContain("var ssrTrace: texture_2d<f32>;");
    expect(wgsl).toContain("var fillTarget: texture_storage_2d<rgba16float, write>;");
    // SSR 优先(含半权双线性边缘);RT 替换走 SSR composite 同式 out*(1-a)+rgb。
    expect(wgsl).toContain("let useRt = trace.a <= 0.0 && rt.a > 0.0;");
    expect(wgsl).toContain("current.rgb * (1.0 - rt.a) + rt.rgb");
    expect(RT_SPECULAR_FILL_PARAMS_BYTES).toBe(16);
  });
});

describe("pack uniform layout (own uniforms only, no frame-ABI borrowing)", () => {
  it("packs indirection params at the documented 96B offsets", () => {
    const data = new Float32Array(packRtSpecularIndirectionUniform({ width: 64, height: 32, ...baseParams }));
    expect(data.byteLength).toBe(RT_SPECULAR_INDIRECTION_PARAMS_BYTES);
    const u32 = new Uint32Array(data.buffer);
    expect([u32[0], u32[1], u32[2], u32[3]]).toEqual([64, 32, 0, 0]);
    expect(data[4]).toBeCloseTo(baseParams.tanHalfFov);
    expect(data[5]).toBeCloseTo(baseParams.aspect);
    // f32 舍入:向量槽位按近值断言(f64 字面量入 f32 uniform 的量化差,非布局漂移)。
    [8, 9, 10].forEach((i, k) => expect(data[i]).toBeCloseTo(baseParams.surfaceToLightWorld[k]!, 7));
    [12, 13, 14].forEach((i, k) => expect(data[i]).toBeCloseTo(baseParams.lightColor[k]!, 7));
    expect(data[15]).toBeCloseTo(baseParams.lightIntensity, 7);
    [16, 17, 18].forEach((i, k) => expect(data[i]).toBeCloseTo(baseParams.envRadiance[k]!, 7));
    expect(data[20]).toBeCloseTo(baseParams.fresnelF0);
  });

  it("packs fill params at the documented 16B offsets", () => {
    const data = new Uint32Array(packRtSpecularFillUniform({ width: 64, height: 32 }));
    expect(data.byteLength).toBe(RT_SPECULAR_FILL_PARAMS_BYTES);
    expect([...data]).toEqual([64, 32, 0, 0]);
  });
});

describe("indirection CPU mirror (executable spec)", () => {
  it("writes zeros for misses and non-positive depth (fail-closed)", () => {
    for (const record of [[-1, 0, 0, 0], [0, 0, 1, 0]] as const) {
      expect(rtSpecularIndirectionRecordCpu(record, [0, 0, 1], 0, 2, 3, 4, 8, 8, baseParams))
        .toEqual([0, 0, 0, 0]);
    }
    expect(rtSpecularIndirectionRecordCpu([1.5, 0, 1, 0], [0, 0, 1], 0, 0, 3, 4, 8, 8, baseParams))
      .toEqual([0, 0, 0, 0]);
    // 遮蔽档输入同 miss 语义:命中记录缺失时遮蔽记录不救活(无虚假能量)。
    expect(rtSpecularIndirectionRecordCpu([-1, 0, 0, 0], [0, 0, 1], 0, 2, 3, 4, 8, 8, baseParams,
      { albedo: [0.9, 0.2, 0.1], visibility: 1 })).toEqual([0, 0, 0, 0]);
  });

  it("matches the shared SSR specular fraction source and the one-bounce formula", () => {
    const record = [2.5, 0, 1, 0] as const;
    const out = rtSpecularIndirectionRecordCpu(record, [0, 0, 1], 0.25, 4, 3, 4, 8, 8, baseParams);
    // 独立重建同一 cosTheta(SSR reconstruct 合同):viewPos/(depth) 归一化后 -N·I。
    const tanHalf = baseParams.tanHalfFov, aspect = baseParams.aspect;
    const uvX = 3.5 / 8, uvY = 4.5 / 8;
    const viewPos = [(uvX * 2 - 1) * 4 * tanHalf * aspect, (1 - uvY * 2) * 4 * tanHalf, -4];
    const incident = viewPos.map((value) => value / 4);
    const length = Math.hypot(...incident);
    const cosTheta = Math.min(1, Math.max(0, -(0 * incident[0]! + 0 * incident[1]! + 1 * incident[2]!) / length));
    expect(out[3]).toBeCloseTo(ssrBrdfSpecularFractionCpu(cosTheta, 0.25, baseParams.fresnelF0), 12);
    const ndotl = record[2]! * baseParams.surfaceToLightWorld[1]!;
    const oneBounce = (ndotl * baseParams.lightColor[1]! * baseParams.lightIntensity
      + baseParams.envRadiance[1]!) * RT_SPECULAR_BOUNCE_ALBEDO;
    expect(out[1]).toBeCloseTo(oneBounce * out[3], 12);
    expect(out[0]).toBeCloseTo((ndotl * baseParams.lightColor[0]! * baseParams.lightIntensity
      + baseParams.envRadiance[0]!) * RT_SPECULAR_BOUNCE_ALBEDO * out[3], 12);
    // 正面命中(N·L>0)产生非零反弹;背向命中(diffuse=0)只剩环境项。
    const back = rtSpecularIndirectionRecordCpu([2.5, 0, -1, 0], [0, 0, 1], 0.25, 4, 3, 4, 8, 8, baseParams);
    expect(back[3]).toBeCloseTo(out[3], 12);
    expect(back[1]).toBeLessThan(out[1]);
  });

  it("neutral shading is bit-identical to the legacy visibility=1 + albedo 0.5 baseline", () => {
    const record = [2.5, 0, 1, 0] as const;
    const legacy = rtSpecularIndirectionRecordCpu(record, [0, 0, 1], 0.25, 4, 3, 4, 8, 8, baseParams);
    const neutral = rtSpecularIndirectionRecordCpu(record, [0, 0, 1], 0.25, 4, 3, 4, 8, 8, baseParams,
      RT_SPECULAR_NEUTRAL_SHADING);
    expect(neutral).toEqual(legacy);
    const explicitNeutral = rtSpecularIndirectionRecordCpu(record, [0, 0, 1], 0.25, 4, 3, 4, 8, 8, baseParams,
      { albedo: [0.5, 0.5, 0.5], visibility: 1 });
    expect(explicitNeutral).toEqual(legacy);
  });

  it("occlusion zeroes only the direct term (on/off differential, ambient term survives)", () => {
    const record = [2.5, 0, 1, 0] as const;
    const lit = rtSpecularIndirectionRecordCpu(record, [0, 0, 1], 0.25, 4, 3, 4, 8, 8, baseParams,
      { albedo: [0.6, 0.5, 0.4], visibility: 1 });
    const occluded = rtSpecularIndirectionRecordCpu(record, [0, 0, 1], 0.25, 4, 3, 4, 8, 8, baseParams,
      { albedo: [0.6, 0.5, 0.4], visibility: 0 });
    // fraction 不受遮蔽影响;遮挡侧 direct 项归零,只剩环境项×反照率(严格更暗)。
    expect(occluded[3]).toBeCloseTo(lit[3], 12);
    const ambientR = baseParams.envRadiance[0]! * 0.6;
    expect(occluded[0]).toBeCloseTo(ambientR * occluded[3], 12);
    expect(occluded[0]).toBeLessThan(lit[0]);
    expect(occluded[1]).toBeLessThan(lit[1]);
    expect(occluded[2]).toBeLessThan(lit[2]);
    // 遮蔽不放大能量:遮挡侧 ≤ 可见侧逐通道。
    for (let c = 0; c < 3; c++) expect(occluded[c]!).toBeLessThanOrEqual(lit[c]! + 1e-12);
  });

  it("real albedo replaces the neutral constant (albedo differential) and clamps out-of-range", () => {
    const record = [2.5, 0, 1, 0] as const;
    const neutral = rtSpecularIndirectionRecordCpu(record, [0, 0, 1], 0.25, 4, 3, 4, 8, 8, baseParams);
    const real = rtSpecularIndirectionRecordCpu(record, [0, 0, 1], 0.25, 4, 3, 4, 8, 8, baseParams,
      { albedo: [0.85, 0.3, 0.1], visibility: 1 });
    // fraction 恒等;反照率差异直接进入预乘 rgb(暖色墙面 vs 中灰)。
    expect(real[3]).toBeCloseTo(neutral[3], 12);
    expect(real[0]).toBeGreaterThan(neutral[0]);
    expect(real[1]).toBeLessThan(neutral[1]);
    expect(real[2]).toBeLessThan(neutral[2]);
    // 越界反照率 clamp 到 [0,1](禁注入超量能量);负值 clamp 到 0。
    const saturated = rtSpecularIndirectionRecordCpu(record, [0, 0, 1], 0.25, 4, 3, 4, 8, 8, baseParams,
      { albedo: [2.5, -0.3, 1], visibility: 1 });
    const unit = rtSpecularIndirectionRecordCpu(record, [0, 0, 1], 0.25, 4, 3, 4, 8, 8, baseParams,
      { albedo: [1, 0, 1], visibility: 1 });
    expect(saturated).toEqual(unit);
  });
});

describe("fill CPU mirror (composite semantics)", () => {
  const out: readonly [number, number, number] = [0.8, 0.6, 0.4];

  it("passes SSR-owned pixels through bit-for-bit (trace.a > 0, incl. half-weight edges)", () => {
    for (const traceAlpha of [1, 0.5, 0.125]) {
      expect(rtSpecularFillCompositeCpu(out, traceAlpha, [1.2, 0.4, 0.2, 0.9])).toEqual([0.8, 0.6, 0.4]);
    }
  });

  it("is bitwise identity when both SSR and RT miss (toggle-off zero change)", () => {
    expect(rtSpecularFillCompositeCpu(out, 0, [1.2, 0.4, 0.2, 0])).toEqual([0.8, 0.6, 0.4]);
    expect(rtSpecularFillCompositeCpu(out, 0, [-1, 0, 0, 0])).toEqual([0.8, 0.6, 0.4]);
  });

  it("replaces the IBL fallback with the RT one-bounce using the composite replace form", () => {
    const rt: readonly [number, number, number, number] = [1.2, 0.4, 0.2, 0.9];
    const filled = rtSpecularFillCompositeCpu(out, 0, rt);
    expect(filled[0]).toBeCloseTo(0.8 * 0.1 + 1.2, 12);
    expect(filled[1]).toBeCloseTo(0.6 * 0.1 + 0.4, 12);
    expect(filled[2]).toBeCloseTo(0.4 * 0.1 + 0.2, 12);
  });
});
