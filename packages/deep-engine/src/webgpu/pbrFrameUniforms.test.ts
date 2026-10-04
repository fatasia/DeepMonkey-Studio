import { describe, expect, it, vi } from "vitest";
import { updatePbrFrameUniforms, type PbrFrameUniformResources, type PbrFrameUniformView } from "./pbrFrameUniforms.js";
import { lookAt, lookAtRelative, multiply, orthographic, perspective, type Vec3 } from "./cameraMath.js";
import { CameraFrameHistory } from "./cameraFrameHistory.js";
import { DEFAULT_PBR_RENDERER_FEATURES } from "./pbrRendererFeatures.js";

function resources(): PbrFrameUniformResources {
  return { frameBuffer: {} as GPUBuffer, outputBuffer: {} as GPUBuffer, groundInstance: {} as GPUBuffer,
    frameData: new Float32Array(96), outputData: new Float32Array(8), groundData: new Float32Array(36) };
}
function run(view: PbrFrameUniformView, target = resources()) {
  return updatePbrFrameUniforms({ writeBuffer: vi.fn() } as unknown as GPUQueue, new CameraFrameHistory(),
    view, 800, 600, false, target, undefined, DEFAULT_PBR_RENDERER_FEATURES);
}
const baseView: PbrFrameUniformView = { eye: [12.5, -3, 8], target: [0, 0.5, 0], extent: 10,
  background: [0.1, 0.2, 0.3], floor: [0, 0, 0], exposure: 1, roughness: 1 };

describe("updatePbrFrameUniforms：camera-relative 增量", () => {
  it("未提供 cameraWorldPosition：worldToView/stable/depth 与既有 lookAt 组合逐位一致（回归）", () => {
    const result = run(baseView);
    expect(Array.from(result.worldToView)).toEqual(Array.from(lookAt(baseView.eye, baseView.target)));
    expect(Array.from(result.stableViewProjection))
      .toEqual(Array.from(multiply(perspective(Math.PI / 4, 800 / 600, 0.1, 200), result.worldToView)));
    expect(result.projection).toEqual({ verticalFovRadians: Math.PI / 4, near: 0.1, far: 200 });
  });

  it("未提供 cameraWorldPosition：eye 槽位与地面平面保持世界坐标原值（回归）", () => {
    const target = resources();
    run(baseView, target);
    expect(Array.from(target.frameData.slice(64, 67))).toEqual(Array.from(baseView.eye));
    expect(target.groundData[3]).toBe(0);
    expect(target.groundData[7]).toBeCloseTo(-0.02, 6);
    expect(target.groundData[11]).toBe(0);
  });

  it("提供 cameraWorldPosition：view 矩阵以相机为原点构建，eye 槽位写入 Float64 相对坐标", () => {
    const origin: Vec3 = [1e7 + 12.3, 3, 12];
    const view: PbrFrameUniformView = { ...baseView, eye: [1e7 + 24.6, 6, 24], target: [1e7 + 0.3, 0.25, 0],
      cameraWorldPosition: origin };
    const target = resources();
    const result = run(view, target);
    expect(Array.from(result.worldToView))
      .toEqual(Array.from(lookAtRelative(view.eye, view.target, view.up ?? [0, 1, 0], origin)));
    expect(target.frameData[64]).toBeCloseTo(24.6 - 12.3, 5);
    expect(target.frameData[65]).toBeCloseTo(3, 5);
    expect(target.frameData[66]).toBeCloseTo(12, 5);
  });

  it("提供 cameraWorldPosition：地面平面与地面装饰光矩阵同步平移到相机相对域", () => {
    const origin: Vec3 = [1e5 + 40, 7, -30];
    const target = resources();
    run({ ...baseView, cameraWorldPosition: origin }, target);
    expect(target.groundData[3]).toBeCloseTo(-1e5 - 40, 4);
    expect(target.groundData[7]).toBeCloseTo(-7.02, 5);
    expect(target.groundData[11]).toBeCloseTo(30, 4);
    const groundLight = multiply(orthographic(15, 0.1, 80),
      lookAtRelative([16, 28, 12], [0, 0, 0], [0, 1, 0], origin));
    expect(Array.from(target.frameData.slice(48, 64))).toEqual(Array.from(groundLight));
  });

  it("两种模式输出尺寸与写入顺序不变（帧 ABI 与上传契约不变）", () => {
    const writeBuffer = vi.fn();
    const target = resources();
    updatePbrFrameUniforms({ writeBuffer } as unknown as GPUQueue, new CameraFrameHistory(),
      { ...baseView, cameraWorldPosition: [42, 0, 0] }, 800, 600, false, target, undefined,
      DEFAULT_PBR_RENDERER_FEATURES);
    expect(target.frameData.length).toBe(96);
    expect(target.outputData.length).toBe(8);
    expect(target.groundData.length).toBe(36);
    expect(writeBuffer.mock.calls.map(call => call[0])).toEqual([target.groundInstance, target.frameBuffer, target.outputBuffer]);
  });
});

describe("M2 方向光 RT 阴影开关位(frame.output.bloom 保留槽复用)", () => {
  const rtFeatures = { ...DEFAULT_PBR_RENDERER_FEATURES, rayTracedShadows: true } as const;
  it("features.rayTracedShadows=true 时 outputData[1]=1,其余输出槽位不变", () => {
    const target = resources();
    run(baseView, target);
    expect(target.outputData[1]).toBe(0);
    const rtTarget = resources();
    updatePbrFrameUniforms({ writeBuffer: vi.fn() } as unknown as GPUQueue, new CameraFrameHistory(),
      baseView, 800, 600, false, rtTarget, undefined, rtFeatures);
    expect(rtTarget.outputData[1]).toBe(1);
    // 帧数据除开关位槽(frameData[89] = Frame.output.bloom)外与默认打包逐位一致。
    const baseline = resources(); run(baseView, baseline);
    for (let index = 0; index < 96; index++) {
      if (index === 89) { expect(rtTarget.frameData[89]).toBe(1); continue; }
      expect(rtTarget.frameData[index]).toBe(baseline.frameData[index]);
    }
    const rtOutput = [...rtTarget.outputData]; rtOutput[1] = baseline.outputData[1];
    expect(rtOutput).toEqual(Array.from(baseline.outputData));
  });
  it("默认 features(关)写 0 —— 打包行为与历史逐位一致", () => {
    const target = resources();
    run(baseView, target);
    expect(target.outputData[1]).toBe(0);
  });
});
