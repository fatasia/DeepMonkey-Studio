// 多投影器灯池测试(2026-10-06 后继切片,关闭登记「单投影器、多投影器灯池属后续」):
// - 灯池累加 = 单投影器逐槽和(槽序 0..N,CPU 镜像与 WGSL 手展开同序);
// - 单投影器池 = legacy applyProjectedTextureCpu 逐位一致(count 1 退化路径);
// - 544B 参数块布局逐字段回读(4×128B 子块 + count + surface);
// - 灯池解析 resolveProjectedTextureFrames(逐灯 resolve,>4 fail-closed);
// - 全部投影器无贡献(强度 0)→ 输出逐位等于输入(加性零透传)。
import { describe, expect, it } from "vitest";
import { applyProjectedTextureCpu, applyProjectedTextureCpuMulti, packProjectedTextureParametersMulti,
  projectedTextureRadianceCpu, resolveProjectedTextureFrames,
  PROJECTED_TEXTURE_MAX_PROJECTORS, PROJECTED_TEXTURE_PARAMETERS_MULTI_BYTES,
  PROJECTED_TEXTURE_PROJECTOR_SLOT_BYTES } from "./projectedTextureCpu.js";
import { PROJECTED_TEXTURE_NEAR, type ProjectedTextureCpuFrame, type ProjectedTextureCpuInput,
  type ProjectedTextureLight } from "./projectedTextureTypes.js";
import { buildSsrSceneFrame, SSR_SEQUENCE_VERTICAL_FOV } from "./screenSpaceReflectionScenes.js";

const WIDTH = 64, HEIGHT = 48;
const PROJECTOR_FOV = Math.PI / 2;
const RANGE = 40;
const TAN_HALF_FOV = Math.tan(SSR_SEQUENCE_VERTICAL_FOV * 0.5);
const ASPECT = WIDTH / HEIGHT;

const frame = buildSsrSceneFrame({ name: "projected-texture-multi", width: WIDTH, height: HEIGHT,
  roughness: 0, wallTop: 12, occluder: undefined });

/** 主轴目标像素:墙面命中(深度 30),反射重建位置即投影器主轴点。 */
const AXIS_PIXEL = { x: 32, y: 20 };

function axisPixelWorldPosition(): readonly [number, number, number] {
  const uvX = (AXIS_PIXEL.x + 0.5) / WIDTH, uvY = (AXIS_PIXEL.y + 0.5) / HEIGHT;
  const dirX = (uvX * 2 - 1) * TAN_HALF_FOV * ASPECT, dirY = (1 - uvY * 2) * TAN_HALF_FOV;
  return [dirX * 30, dirY * 30, -30];
}

const AXIS_POSITION = axisPixelWorldPosition();

/** 沿 +x 平移的投影器(主轴仍过墙面,y/z 与 AXIS 同高),index 0 为主轴位。 */
function poolLight(index: number, overrides: Partial<ProjectedTextureLight> = {}):
  ProjectedTextureLight {
  const shift = index * 3;
  return {
    position: [AXIS_POSITION[0] + shift, AXIS_POSITION[1], -21],
    target: [AXIS_POSITION[0] + shift, AXIS_POSITION[1], -30],
    verticalFovRadians: PROJECTOR_FOV,
    intensity: 2.5,
    color: [0.8, 0.9, 1.1],
    range: RANGE,
    edgeSoften: 0,
    gobo: {} as ProjectedTextureLight["gobo"],
    ...overrides,
  };
}

const identityView = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

const WHITE_GOBO_INPUT = (): ProjectedTextureCpuInput => ({
  width: WIDTH, height: HEIGHT,
  depth: frame.cpuInput.depth, normals: frame.cpuInput.normals, color: frame.cpuInput.color,
  goboWidth: 1, goboHeight: 1, gobo: [1, 1, 1],
});

function toCpuFrames(lights: readonly ProjectedTextureLight[]): ProjectedTextureCpuFrame[] {
  return resolveProjectedTextureFrames(lights, identityView).map(resolved => ({
    viewToProjector: resolved.viewToProjector, positionView: resolved.positionView,
    intensity: resolved.intensity, color: resolved.color, range: resolved.range,
    edgeSoften: resolved.edgeSoften,
  }));
}

describe("projected texture multi-projector light pool(灯池 ≤4)", () => {
  it("灯池输出 = 单投影器解析贡献之和(逐像素逐位,f32 加法序同 WGSL)", () => {
    const lights = [poolLight(0), poolLight(1), poolLight(2)];
    const frames = toCpuFrames(lights);
    const input = WHITE_GOBO_INPUT();
    const pooled = applyProjectedTextureCpuMulti(input, frames, { verticalFovRadians: SSR_SEQUENCE_VERTICAL_FOV });
    const tanHalfFov = Math.tan(SSR_SEQUENCE_VERTICAL_FOV * 0.5);
    // 严格逐位对拍:pooled = f32(base + Σ_slot radiance_slot)。镜像累加在 f64、
    // 存入 Float32Array 时才舍 f32 —— 期望值同式后补 Math.fround 对齐同一舍入点。
    for (let pixel = 0; pixel < WIDTH * HEIGHT; pixel++) {
      const base = pixel * 3;
      const depth = input.depth[pixel] ?? 0;
      let r = 0, g = 0, b = 0;
      for (const single of frames) {
        const radiance = projectedTextureRadianceCpu(input, single, (pixel % WIDTH),
          Math.floor(pixel / WIDTH), depth, tanHalfFov, WIDTH / HEIGHT);
        r += radiance[0]; g += radiance[1]; b += radiance[2];
      }
      expect(pooled.output[base]).toBe(Math.fround(r + (input.color[base] ?? 0)));
      expect(pooled.output[base + 1]).toBe(Math.fround(g + (input.color[base + 1] ?? 0)));
      expect(pooled.output[base + 2]).toBe(Math.fround(b + (input.color[base + 2] ?? 0)));
    }
  });

  it("单投影器池 = legacy 单投影器逐位一致(count 1 退化路径)", () => {
    const [frame0] = toCpuFrames([poolLight(0)]);
    const input = WHITE_GOBO_INPUT();
    const legacy = applyProjectedTextureCpu(input, frame0!, { verticalFovRadians: SSR_SEQUENCE_VERTICAL_FOV });
    const pooled = applyProjectedTextureCpuMulti(input, [frame0!], { verticalFovRadians: SSR_SEQUENCE_VERTICAL_FOV });
    expect(pooled.output).toEqual(legacy.output);
  });

  it("强度 0 灯池 = 加性零:输出逐位等于输入;槽间重叠区贡献可分累加", () => {
    const input = WHITE_GOBO_INPUT();
    const zeros = toCpuFrames([poolLight(0, { intensity: 0 }), poolLight(1, { intensity: 0 })]);
    const zeroPooled = applyProjectedTextureCpuMulti(input, zeros, { verticalFovRadians: SSR_SEQUENCE_VERTICAL_FOV });
    expect(zeroPooled.output).toEqual(Float32Array.from(input.color));
    // 同一主轴点两枚同参数投影器(位移 0)→ 贡献 ×2(线性叠加;差分区间 delta>0)。
    const twins = toCpuFrames([poolLight(0), poolLight(0)]);
    const single = applyProjectedTextureCpu(input, twins[0]!, { verticalFovRadians: SSR_SEQUENCE_VERTICAL_FOV });
    const double = applyProjectedTextureCpuMulti(input, twins, { verticalFovRadians: SSR_SEQUENCE_VERTICAL_FOV });
    const pixel = (AXIS_PIXEL.y * WIDTH + AXIS_PIXEL.x) * 3;
    expect(double.output[pixel]!).toBeCloseTo(2 * (single.output[pixel]! - (input.color[pixel] ?? 0))
      + (input.color[pixel] ?? 0), 5);
  });

  it("544B 参数块布局:子块步长 128B,4×128B + count@512 + surface@528;越界 fail-closed", () => {
    const lights = [poolLight(0, { intensity: 1 }), poolLight(1, { intensity: 2 })];
    const packedFrames = resolveProjectedTextureFrames(lights, identityView);
    const buffer = packProjectedTextureParametersMulti(packedFrames, WIDTH, HEIGHT, SSR_SEQUENCE_VERTICAL_FOV);
    expect(buffer.byteLength).toBe(PROJECTED_TEXTURE_PARAMETERS_MULTI_BYTES);
    const floats = new Float32Array(buffer), uints = new Uint32Array(buffer);
    for (let slot = 0; slot < lights.length; slot++) {
      const words = (slot * PROJECTED_TEXTURE_PROJECTOR_SLOT_BYTES) / 4;
      const packed = packedFrames[slot]!;
      expect(Array.from(floats.slice(words, words + 16))).toEqual(Array.from(packed.viewToProjector));
      // f32 存储位型对比(Float32Array 化期望值,规避 f64 字面量与 f32 舍入的假差;
      // legacy 128B 打包测试同款)。
      expect(floats.slice(words + 16, words + 20)).toEqual(new Float32Array(
        [packed.positionView[0], packed.positionView[1], packed.positionView[2], packed.intensity]));
      expect(floats.slice(words + 20, words + 24)).toEqual(new Float32Array(
        [packed.color[0], packed.color[1], packed.color[2], packed.range]));
      expect(floats[words + 24]).toBe(packed.edgeSoften);
      expect(floats[words + 26]).toBeCloseTo(WIDTH / HEIGHT, 6);
      expect(uints[words + 28]).toBe(WIDTH);
      expect(uints[words + 29]).toBe(HEIGHT);
    }
    // 未用槽全零;count 与 surface 在块尾。
    const unusedSlots = Array.from(floats.slice((2 * PROJECTED_TEXTURE_PROJECTOR_SLOT_BYTES) / 4, 512 / 4));
    expect(unusedSlots.every(value => value === 0)).toBe(true);
    expect(uints[512 / 4]).toBe(2);
    expect(uints[528 / 4]).toBe(WIDTH);
    expect(uints[532 / 4]).toBe(HEIGHT);
    // 灯池规模墙:0 与 >4 拒绝,4 恰好可打。
    expect(() => packProjectedTextureParametersMulti([], WIDTH, HEIGHT, SSR_SEQUENCE_VERTICAL_FOV)).toThrow(RangeError);
    expect(() => packProjectedTextureParametersMulti(
      resolveProjectedTextureFrames([poolLight(0), poolLight(1), poolLight(2), poolLight(3)], identityView),
      WIDTH, HEIGHT, SSR_SEQUENCE_VERTICAL_FOV)).not.toThrow();
    expect(() => packProjectedTextureParametersMulti(
      resolveProjectedTextureFrames([poolLight(0), poolLight(1), poolLight(2), poolLight(3),
        poolLight(0)], identityView), WIDTH, HEIGHT, SSR_SEQUENCE_VERTICAL_FOV)).toThrow(RangeError);
    expect(PROJECTED_TEXTURE_MAX_PROJECTORS).toBe(4);
    expect(PROJECTED_TEXTURE_NEAR).toBe(0.01);
  });

  it("resolveProjectedTextureFrames:逐灯 resolve + 单灯非法 fail-closed(整池拒绝,与打包同判据)", () => {
    const frames = resolveProjectedTextureFrames([poolLight(0), poolLight(1)], identityView);
    expect(frames).toHaveLength(2);
    expect(frames[1]!.intensity).toBe(2.5);
    // FOV 非法的灯:resolve 逐灯抛(validateProjectedTextureLight),渲染循环逐灯剔除。
    expect(() => resolveProjectedTextureFrames([poolLight(0, { verticalFovRadians: 4 })], identityView))
      .toThrow(RangeError);
    // 空池与超员池在解析入口 fail-closed。
    expect(() => resolveProjectedTextureFrames([], identityView)).toThrow(RangeError);
    expect(() => resolveProjectedTextureFrames(
      [poolLight(0), poolLight(1), poolLight(2), poolLight(3), poolLight(0)], identityView)).toThrow(RangeError);
  });
});
