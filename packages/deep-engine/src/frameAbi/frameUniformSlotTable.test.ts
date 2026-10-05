// 帧 uniform 96 字槽位表的运行时对拍门(B3 刀3 审计,2026-10-06)。
// 三点交叉验证,任一漂移即红:
//   1) 槽位表 ↔ WGSL 单源 Frame struct(frameAbi/generated,/schema sha256 钉)字段序
//      与字数逐项互钉;
//   2) 槽位表 ↔ 宿主打包:updatePbrFrameUniforms 真调用(桩 queue),逐字断言关键
//      语义槽(eye.w 环境位 / background.w castShadow / floor.w groundGrid /
//      lightDirection.w environmentIntensity / tuning 行 / sunColor 行 / output 行
//      的 RT 阴影开关位 word 89);
//   3) 槽位表闭合性:无重叠、无空隙、总和 = 96 = FRAME_ABI_TS_FLOATS。
// 审计裁决(96 字满载,逐像素混合登记下一切片)见 frameUniformSlotTable.ts 头注释。
import { describe, expect, it } from "vitest";
import { CameraFrameHistory } from "../webgpu/cameraFrameHistory.js";
import { updatePbrFrameUniforms, type PbrFrameUniformResources } from "../webgpu/pbrFrameUniforms.js";
import { DEFAULT_PBR_RENDERER_FEATURES } from "../webgpu/pbrRendererFeatures.js";
import { FRAME_ABI_TS_FLOATS } from "./generated/frameLayout.js";
import { FRAME_STRUCTS_WGSL } from "./generated/frameStructsWgsl.js";
import { FRAME_UNIFORM_REUSED_WORDS, FRAME_UNIFORM_SLOTS,
  FRAME_UNIFORM_TOTAL_WORDS, RT_SHADOW_PER_PIXEL_BLEND_VERDICT } from "./frameUniformSlotTable.js";

const WRITES: ArrayBuffer[] = [];

function makeResources(): PbrFrameUniformResources {
  return {
    frameBuffer: {} as GPUBuffer, outputBuffer: {} as GPUBuffer, groundInstance: {} as GPUBuffer,
    frameData: new Float32Array(FRAME_UNIFORM_TOTAL_WORDS),
    outputData: new Float32Array(8),
    groundData: new Float32Array(36),
  };
}

const stubQueue = { writeBuffer: (_buffer: GPUBuffer, _offset: number, data: ArrayBuffer) => {
  WRITES.push(data);
} } as unknown as GPUQueue;

const BASE_VIEW = {
  eye: [1, 2, 3] as [number, number, number], target: [0, 1, 0] as [number, number, number],
  extent: 4, background: [0.05, 0.06, 0.07] as [number, number, number],
  floor: [0.2, 0.21, 0.22] as [number, number, number], exposure: 1.25, roughness: 0.35,
};

describe("frame uniform 96-word slot table audit (B3 刀3)", () => {
  it("slots tile the 96 words exactly — no gaps, no overlaps, no free word", () => {
    const sorted = [...FRAME_UNIFORM_SLOTS].sort((a, b) => a.wordStart - b.wordStart);
    let cursor = 0;
    for (const slot of sorted) {
      expect(slot.wordStart).toBe(cursor);
      cursor += slot.words;
    }
    expect(cursor).toBe(FRAME_UNIFORM_TOTAL_WORDS);
    expect(FRAME_UNIFORM_TOTAL_WORDS).toBe(FRAME_ABI_TS_FLOATS);
    // 裁决机读形态与表一致:满载 → 无空闲字。
    expect(RT_SHADOW_PER_PIXEL_BLEND_VERDICT.freeWords).toBe(
      FRAME_UNIFORM_TOTAL_WORDS - FRAME_UNIFORM_SLOTS.reduce((sum, slot) => sum + slot.words, 0));
  });

  it("slot order is pinned to the generated WGSL Frame struct (schema single source)", () => {
    const fieldOrder = [...FRAME_STRUCTS_WGSL.matchAll(/(\w+): (?:mat4x4f|vec4f|DeepOutputSettings),/g)]
      .map(match => match[1]!);
    expect(fieldOrder).toEqual(FRAME_UNIFORM_SLOTS.map(slot => slot.wgslField));
  });

  it("host packing lands every semantic word where the table says (real pack invocation)", () => {
    const history = new CameraFrameHistory();
    const resources = makeResources();
    updatePbrFrameUniforms(stubQueue, history, { ...BASE_VIEW,
      environmentIntensity: 2.5 }, 640, 480, false, resources,
      { castShadow: true, surfaceToLightWorld: [0.3, 0.8, 0.2], color: [1, 0.9, 0.8], intensity: 3 } as Parameters<
        typeof updatePbrFrameUniforms>[6],
      { ...DEFAULT_PBR_RENDERER_FEATURES, environment: true, groundGrid: true, fog: false,
        rayTracedShadows: true },
      undefined,
      { channel: "ray-traced" });
    const frame = resources.frameData;
    const byName = (name: string): { start: number; words: number } => {
      const slot = FRAME_UNIFORM_SLOTS.find(candidate => candidate.name === name)!;
      return { start: slot.wordStart, words: slot.words };
    };
    // eye.w = 环境开关位(1/0;features.environment=true)。
    const eye = byName("eye");
    expect(frame[eye.start + 3]).toBe(1);
    // background.w(word 71)= castShadow 开关位;background.rgb = 背景色。
    const background = byName("background");
    expect(frame[background.start]).toBeCloseTo(0.05, 6);
    expect(frame[background.start + 3]).toBe(1);
    expect(background.start + 3).toBe(FRAME_UNIFORM_REUSED_WORDS[0]!.word);
    // floor.rgb = 地面色;floor.w = groundGrid 开关位。
    const floor = byName("floor");
    expect(frame[floor.start]).toBeCloseTo(0.2, 6);
    expect(frame[floor.start + 3]).toBe(1);
    // lightDirection.w = environmentIntensity(2.5)。
    const lightDirection = byName("lightDirection");
    expect(frame[lightDirection.start]).toBeCloseTo(0.3, 6);
    expect(frame[lightDirection.start + 3]).toBe(2.5);
    // tuning 行:jitter 首帧 0;roughness;fog 关 → tuning.w = 0(pbrFogWgsl 短路口)。
    const tuning = byName("tuning");
    expect(frame[tuning.start + 2]).toBeCloseTo(0.35, 6);
    expect(frame[tuning.start + 3]).toBe(0);
    // sunColor.rgb/w = primary 色/强度。
    const sunColor = byName("sunColor");
    expect(frame[sunColor.start + 1]).toBeCloseTo(0.9, 6);
    expect(frame[sunColor.start + 3]).toBe(3);
    // output 行(word 88..95):exposure=88;bloom(word 89)= RT 阴影开关位(ray-traced
    // 选路 → 1);toneMapping=91;grading=92..95。
    const output = byName("output");
    expect(output.start).toBe(88);
    expect(frame[88]).toBe(1.25);
    expect(frame[89]).toBe(1);
    expect(89).toBe(FRAME_UNIFORM_REUSED_WORDS[1]!.word);
    // 帧粒度级联选路时开关位压 0(4988df13 合同,audit 表注明双语义)。
    const cascadeResources = makeResources();
    updatePbrFrameUniforms(stubQueue, new CameraFrameHistory(), { ...BASE_VIEW }, 640, 480, false,
      cascadeResources, undefined, DEFAULT_PBR_RENDERER_FEATURES, { channel: "cascade" });
    expect(cascadeResources.frameData[89]).toBe(0);
  });

  it("verdict: frame-granularity routing suffices; per-pixel blend is deferred, no further word reuse", () => {
    expect(RT_SHADOW_PER_PIXEL_BLEND_VERDICT.frameGranularitySufficient).toBe(true);
    expect(RT_SHADOW_PER_PIXEL_BLEND_VERDICT.perPixelBlendDeferred).toBe(true);
    expect(RT_SHADOW_PER_PIXEL_BLEND_VERDICT.furtherWordReuseForbidden).toBe(true);
    // 借位台账:历史上仅两处,新增借位即红(新增须改本表并过 schema 扩展流程)。
    expect(FRAME_UNIFORM_REUSED_WORDS).toHaveLength(2);
  });
});
