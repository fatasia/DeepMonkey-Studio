import { describe, expect, it } from "vitest";
import { applyProjectedTextureCpu, packProjectedTextureParameters, projectedTextureRadianceCpu,
  projectedTextureWorldMatrix, resolveProjectedTextureFrame, sampleProjectedTextureGobo,
  validateProjectedTextureLight, PROJECTED_TEXTURE_PARAMETER_BYTES } from "./projectedTextureCpu.js";
import { PROJECTED_TEXTURE_NEAR, type ProjectedTextureCpuFrame, type ProjectedTextureCpuInput,
  type ProjectedTextureLight } from "./projectedTextureTypes.js";
import { buildSsrSceneFrame, SSR_SEQUENCE_VERTICAL_FOV } from "./screenSpaceReflectionScenes.js";

/**
 * P2 投影纹理光 CPU 权威镜像测试:投影采样确定性 / 白 gobo 解析聚光参考 / 锥外·
 * 背后·超半径贡献恰为 0 / gobo 双线性 / 参数块打包单源 / fail-closed 校验。
 * 场景复用 SSR 解析序列(地板 y=-2 / 墙 z=-30 / 天空),几何真值见
 * screenSpaceReflectionScenes.ts;投影器瞄准墙面上某像素的主轴点。
 */

const WIDTH = 64, HEIGHT = 48;
const PROJECTOR_FOV = Math.PI / 2;
const RANGE = 40;
/** 与 SSR 场景同视纵;tanHalfFov = tan(π/6)。 */
const TAN_HALF_FOV = Math.tan(SSR_SEQUENCE_VERTICAL_FOV * 0.5);
const ASPECT = WIDTH / HEIGHT;

const frame = buildSsrSceneFrame({ name: "projected-texture-unit", width: WIDTH, height: HEIGHT,
  roughness: 0, wallTop: 12, occluder: undefined });

/** 主轴目标像素:墙面命中(深度 30,法线 (0,0,1)),反射重建位置即投影器主轴点。 */
const AXIS_PIXEL = { x: 32, y: 20 };

function axisPixelWorldPosition(): readonly [number, number, number] {
  const uvX = (AXIS_PIXEL.x + 0.5) / WIDTH, uvY = (AXIS_PIXEL.y + 0.5) / HEIGHT;
  const dirX = (uvX * 2 - 1) * TAN_HALF_FOV * ASPECT, dirY = (1 - uvY * 2) * TAN_HALF_FOV;
  return [dirX * 30, dirY * 30, -30];
}

const AXIS_POSITION = axisPixelWorldPosition();

/** 投影器在墙面法向前方 9 个世界单位,主轴穿过 AXIS_POSITION(lookAt 方向 = (0,0,-1))。 */
const light: ProjectedTextureLight = {
  position: [AXIS_POSITION[0], AXIS_POSITION[1], -21],
  target: [AXIS_POSITION[0], AXIS_POSITION[1], -30],
  verticalFovRadians: PROJECTOR_FOV,
  intensity: 2.5,
  color: [0.8, 0.9, 1.1],
  range: RANGE,
  edgeSoften: 0,
  gobo: {} as ProjectedTextureLight["gobo"],
};

const identityView = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const resolved = resolveProjectedTextureFrame(light, identityView);

const WHITE_GOBO_INPUT = (gobo: readonly number[] = [1, 1, 1], goboWidth = 1, goboHeight = 1):
  ProjectedTextureCpuInput => ({
  width: WIDTH, height: HEIGHT,
  depth: frame.cpuInput.depth, normals: frame.cpuInput.normals, color: frame.cpuInput.color,
  goboWidth, goboHeight, gobo: [...gobo],
});

/**
 * 场景法线经 rgba8unorm 量化(nx=0 → 128/255 → 解码 0.00392),解析参考必须用解码
 * 法线求 N·L(独立公式,不调用镜像 helper),量化偏移是场景数据的物理事实。
 */
function decodedAxisCosine(): number {
  const pixel = AXIS_PIXEL.y * WIDTH + AXIS_PIXEL.x;
  const nx = (frame.cpuInput.normals[pixel * 3] ?? 0) * 2 - 1;
  const ny = (frame.cpuInput.normals[pixel * 3 + 1] ?? 0) * 2 - 1;
  const nz = (frame.cpuInput.normals[pixel * 3 + 2] ?? 0) * 2 - 1;
  const length = Math.hypot(nx, ny, nz);
  return nz / length; // cosine = dot(n, toLight)/distance = nz(主轴几何 toLight=(0,0,9))。
}

const cpuFrame: ProjectedTextureCpuFrame = {
  viewToProjector: resolved.viewToProjector, positionView: resolved.positionView,
  intensity: resolved.intensity, color: resolved.color, range: resolved.range, edgeSoften: resolved.edgeSoften,
};

function frameDelta(input: ProjectedTextureCpuInput, result: { readonly output: Float32Array }): number[] {
  const deltas: number[] = [];
  for (let pixel = 0; pixel < WIDTH * HEIGHT; pixel++) {
    const base = pixel * 3;
    deltas.push(Math.max(Math.abs(result.output[base]! - (input.color[base] ?? 0)),
      Math.abs(result.output[base + 1]! - (input.color[base + 1] ?? 0)),
      Math.abs(result.output[base + 2]! - (input.color[base + 2] ?? 0))));
  }
  return deltas;
}

describe("projected texture CPU mirror", () => {
  it("投影采样确定性:同一输入两次运行逐位一致", () => {
    const input = WHITE_GOBO_INPUT();
    const first = applyProjectedTextureCpu(input, cpuFrame, { verticalFovRadians: SSR_SEQUENCE_VERTICAL_FOV });
    const second = applyProjectedTextureCpu(input, cpuFrame, { verticalFovRadians: SSR_SEQUENCE_VERTICAL_FOV });
    expect(second.output).toEqual(first.output);
  });

  it("白 gobo 解析聚光参考:主轴墙面像素贡献 = color×intensity×(1-d/range)²(N·L=1,锥内)", () => {
    const result = applyProjectedTextureCpu(WHITE_GOBO_INPUT(), cpuFrame, { verticalFovRadians: SSR_SEQUENCE_VERTICAL_FOV });
    const pixel = AXIS_PIXEL.y * WIDTH + AXIS_PIXEL.x, base = pixel * 3;
    const expectedScale = light.intensity * decodedAxisCosine() * (1 - 9 / RANGE) ** 2;
    for (let channel = 0; channel < 3; channel++) {
      expect(result.output[base + channel]).toBeCloseTo((input_color(channel)) + light.color[channel]! * expectedScale, 5);
    }
    // 单点辐射函数与全帧路径在同一像素一致(镜像内部同式)。
    const depth = frame.cpuInput.depth[pixel]!;
    const radiance = projectedTextureRadianceCpu(WHITE_GOBO_INPUT(), cpuFrame,
      AXIS_PIXEL.x, AXIS_PIXEL.y, depth, TAN_HALF_FOV, ASPECT);
    expect(radiance[0]).toBeCloseTo(light.color[0]! * expectedScale, 5);
    expect(radiance[1]).toBeCloseTo(light.color[1]! * expectedScale, 5);
    expect(radiance[2]).toBeCloseTo(light.color[2]! * expectedScale, 5);

    function input_color(channel: number): number { return frame.cpuInput.color[base + channel] ?? 0; }
  });

  it("锥外零贡献:投影器视锥未覆盖的近处地板像素 delta 恰为 0", () => {
    // 地板 y=-2,投影器主轴水平;dy=-4 的地板点需 dz ≤ -4 才入视锥 → 近处(z≈-3)锥外。
    let nearFloorPixel = -1;
    for (let y = 0; y < HEIGHT && nearFloorPixel < 0; y++) for (let x = 0; x < WIDTH; x++) {
      const depth = frame.cpuInput.depth[y * WIDTH + x] ?? 0;
      if (depth > 0 && depth < 4.5) { nearFloorPixel = y * WIDTH + x; break; }
    }
    expect(nearFloorPixel).toBeGreaterThanOrEqual(0);
    const result = applyProjectedTextureCpu(WHITE_GOBO_INPUT(), cpuFrame, { verticalFovRadians: SSR_SEQUENCE_VERTICAL_FOV });
    const base = nearFloorPixel * 3;
    expect(result.output[base]).toBe(frame.cpuInput.color[base]);
    expect(result.output[base + 1]).toBe(frame.cpuInput.color[base + 1]);
    expect(result.output[base + 2]).toBe(frame.cpuInput.color[base + 2]);
  });

  it("天空像素(深度 0)逐位透传;超衰减半径(range=5,墙面距离 9)全帧逐位等于输入", () => {
    const skyPixel = frame.cpuInput.depth.findIndex(depth => !(depth > 0));
    expect(skyPixel).toBeGreaterThanOrEqual(0);
    const shortRange: ProjectedTextureCpuFrame = { ...cpuFrame, range: 5 };
    const result = applyProjectedTextureCpu(WHITE_GOBO_INPUT(), shortRange, { verticalFovRadians: SSR_SEQUENCE_VERTICAL_FOV });
    expect(Array.from(result.output)).toEqual(Array.from(frame.cpuInput.color));
    // 天空在正常半径下同样逐位透传(深度 0 直接走 color 通道)。
    const normal = applyProjectedTextureCpu(WHITE_GOBO_INPUT(), cpuFrame, { verticalFovRadians: SSR_SEQUENCE_VERTICAL_FOV });
    expect(normal.output.slice(skyPixel * 3, skyPixel * 3 + 3)).toEqual(
      new Float32Array([frame.cpuInput.color[skyPixel * 3]!, frame.cpuInput.color[skyPixel * 3 + 1]!,
        frame.cpuInput.color[skyPixel * 3 + 2]!]));
  });

  it("强度 0 = 加性零:全帧输出逐位等于输入(关闭零变化的镜像半边)", () => {
    const zero: ProjectedTextureCpuFrame = { ...cpuFrame, intensity: 0 };
    const result = applyProjectedTextureCpu(WHITE_GOBO_INPUT(), zero, { verticalFovRadians: SSR_SEQUENCE_VERTICAL_FOV });
    expect(Array.from(result.output)).toEqual(Array.from(frame.cpuInput.color));
  });

  it("gobo 双线性采样:2×2 四色贴图在 uv(0.5,0.5) 采样为四纹素均值,主轴像素按均值贡献", () => {
    const gobo = [0.2, 0.4, 0.6, 0.4, 0.8, 0.4, 0.6, 0.2, 0.2, 0.6, 0.4, 0.8];
    const input = WHITE_GOBO_INPUT(gobo, 2, 2);
    const center = sampleProjectedTextureGobo(input, 0.5, 0.5);
    const mean = (channel: number): number => (gobo[channel]! + gobo[3 + channel]! + gobo[6 + channel]! + gobo[9 + channel]!) / 4;
    expect(center[0]).toBeCloseTo(mean(0), 6);
    expect(center[1]).toBeCloseTo(mean(1), 6);
    expect(center[2]).toBeCloseTo(mean(2), 6);
    const result = applyProjectedTextureCpu(input, cpuFrame, { verticalFovRadians: SSR_SEQUENCE_VERTICAL_FOV });
    const base = (AXIS_PIXEL.y * WIDTH + AXIS_PIXEL.x) * 3;
    const scale = light.intensity * decodedAxisCosine() * (1 - 9 / RANGE) ** 2;
    expect(result.output[base]).toBeCloseTo(frame.cpuInput.color[base]! + mean(0) * light.color[0]! * scale, 6);
    expect(result.output[base + 1]).toBeCloseTo(frame.cpuInput.color[base + 1]! + mean(1) * light.color[1]! * scale, 5);
    expect(result.output[base + 2]).toBeCloseTo(frame.cpuInput.color[base + 2]! + mean(2) * light.color[2]! * scale, 5);
  });

  it("锥边软化:edgeSoften 收窄时主轴仍满贡献,越界 uv 贡献为 0", () => {
    const softened: ProjectedTextureCpuFrame = { ...cpuFrame, edgeSoften: 0.25 };
    const pixel = AXIS_PIXEL.y * WIDTH + AXIS_PIXEL.x;
    const radiance = projectedTextureRadianceCpu(WHITE_GOBO_INPUT(), softened,
      AXIS_PIXEL.x, AXIS_PIXEL.y, frame.cpuInput.depth[pixel]!, TAN_HALF_FOV, ASPECT);
    expect(radiance[0]).toBeCloseTo(light.color[0]! * light.intensity * decodedAxisCosine() * (1 - 9 / RANGE) ** 2, 6);
    expect(projectedTextureRadianceCpu(WHITE_GOBO_INPUT(), softened, 0, 0, 0, TAN_HALF_FOV, ASPECT)).toEqual([0, 0, 0]);
  });

  it("参数块打包单源:128B 布局逐字段回读一致(WGSL ProjectedTextureParams 同构)", () => {
    const buffer = packProjectedTextureParameters({ ...resolved, gobo: undefined as never }, WIDTH, HEIGHT,
      SSR_SEQUENCE_VERTICAL_FOV);
    expect(buffer.byteLength).toBe(PROJECTED_TEXTURE_PARAMETER_BYTES);
    const floats = new Float32Array(buffer), uints = new Uint32Array(buffer);
    expect(Array.from(floats.slice(0, 16))).toEqual(Array.from(projectedTextureWorldMatrix(light)));
    // f32 存储位型对比:Float32Array 化期望值,规避 f64 字面量与 f32 舍入的假差。
    expect(floats.slice(16, 20)).toEqual(new Float32Array([light.position[0], light.position[1], light.position[2], light.intensity]));
    expect(floats.slice(20, 24)).toEqual(new Float32Array([light.color[0], light.color[1], light.color[2], light.range]));
    expect(floats[24]).toBe(light.edgeSoften);
    expect(floats[25]).toBeCloseTo(TAN_HALF_FOV, 6);
    expect(floats[26]).toBeCloseTo(ASPECT, 6);
    expect(uints[28]).toBe(WIDTH);
    expect(uints[29]).toBe(HEIGHT);
  });

  it("resolveProjectedTextureFrame:单位视矩阵下 viewToProjector = worldToProjector,位置视变换正确", () => {
    expect(resolved.viewToProjector).toEqual(Array.from(projectedTextureWorldMatrix(light)));
    expect(resolved.positionView).toEqual(light.position);
    expect(resolved.gobo).toBe(light.gobo);
  });

  it("fail-closed 校验:非法 FOV/重合目标/负强度/零范围/越界软化逐项拒绝", () => {
    expect(() => validateProjectedTextureLight({ ...light, verticalFovRadians: 0 })).toThrow(RangeError);
    expect(() => validateProjectedTextureLight({ ...light, verticalFovRadians: Math.PI })).toThrow(RangeError);
    expect(() => validateProjectedTextureLight({ ...light, target: [...light.position] })).toThrow(/target must differ/);
    expect(() => validateProjectedTextureLight({ ...light, intensity: -1 })).toThrow(RangeError);
    expect(() => validateProjectedTextureLight({ ...light, range: 0 })).toThrow(RangeError);
    expect(() => validateProjectedTextureLight({ ...light, edgeSoften: 0.6 })).toThrow(RangeError);
    expect(() => validateProjectedTextureLight({ ...light, position: [Number.NaN, 0, 0] })).toThrow(RangeError);
    expect(() => applyProjectedTextureCpu(WHITE_GOBO_INPUT(), cpuFrame, { verticalFovRadians: 0 })).toThrow(RangeError);
  });

  it("投影器透视近截面为文档化常量;主轴像素帧 delta 分布:墙面命中区>0、天空=0", () => {
    expect(PROJECTED_TEXTURE_NEAR).toBe(0.01);
    const result = applyProjectedTextureCpu(WHITE_GOBO_INPUT(), cpuFrame, { verticalFovRadians: SSR_SEQUENCE_VERTICAL_FOV });
    const deltas = frameDelta(WHITE_GOBO_INPUT(), result);
    const positive = deltas.filter(delta => delta > 1e-6).length;
    const zero = deltas.filter(delta => delta === 0).length;
    expect(positive).toBeGreaterThan(0);
    expect(zero).toBeGreaterThan(0);
  });
});
