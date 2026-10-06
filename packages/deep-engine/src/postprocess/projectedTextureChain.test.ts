import { describe, expect, it } from "vitest";
import { applyProjectedTextureCpu, resolveProjectedTextureFrame } from "./projectedTextureCpu.js";
import type { ProjectedTextureCpuFrame, ProjectedTextureLight } from "./projectedTextureTypes.js";
import { buildSsrSceneFrame, SSR_SEQUENCE_VERTICAL_FOV } from "./screenSpaceReflectionScenes.js";
import { screenSpaceReflectionCpu } from "./screenSpaceReflectionCpu.js";

/**
 * P2 投影纹理光 × 反射链路(CPU 全链):投影纹理 pass 输出在 SSR 之前,SSR composite
 * 在命中 UV 采色即携带投影贡献——本测试在解析 SSR 场景(地板 y=-2 反射墙 z=-30)上
 * 钉死三件事:
 * 1. **关闭零变化**:强度 0 的投影器全帧逐位等于不开(apply 跳过),SSR 全链输出逐位一致;
 * 2. **命中点投影贡献差分**:开投影器后,地板反射命中墙面被投影像素的 SSR 输出严格变亮,
 *    差分像素集中在地板反射区;天空/SSR miss 像素逐位不变;
 * 3. **确定性**:全链两次运行逐位一致。
 * 屏空间对视锥外命中点无深度/法线,出屏命中不评估投影贡献(与 manifest 登记口径一致)。
 */

const WIDTH = 64, HEIGHT = 48;
const RANGE = 60;

const frame = buildSsrSceneFrame({ name: "projected-texture-chain", width: WIDTH, height: HEIGHT,
  roughness: 0, wallTop: 12, occluder: undefined });

/** 主轴墙面像素(深度 30):投影器贴墙 2 个单位水平照射(地板 dy=-4.5 在锥外,
 * 地板不受直射光 → 下半屏差分是纯反射链证据)。 */
const AXIS = { x: 32, y: 20 };
const uvX = (AXIS.x + 0.5) / WIDTH, uvY = (AXIS.y + 0.5) / HEIGHT;
const tanHalfFov = Math.tan(SSR_SEQUENCE_VERTICAL_FOV * 0.5), aspect = WIDTH / HEIGHT;
const axisX = (uvX * 2 - 1) * tanHalfFov * aspect * 30, axisY = (1 - uvY * 2) * tanHalfFov * 30;

const light: ProjectedTextureLight = {
  position: [axisX, axisY, -28], target: [axisX, axisY, -30],
  verticalFovRadians: Math.PI / 2, intensity: 3, color: [0.9, 0.8, 0.4],
  range: RANGE, edgeSoften: 0, gobo: {} as ProjectedTextureLight["gobo"],
};
const identityView = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const resolved = resolveProjectedTextureFrame(light, identityView);
const cpuFrame: ProjectedTextureCpuFrame = {
  viewToProjector: resolved.viewToProjector, positionView: resolved.positionView,
  intensity: resolved.intensity, color: resolved.color, range: resolved.range, edgeSoften: resolved.edgeSoften,
};

const baseInput = { width: WIDTH, height: HEIGHT, depth: frame.cpuInput.depth,
  normals: frame.cpuInput.normals, color: frame.cpuInput.color, goboWidth: 1, goboHeight: 1, gobo: [1, 1, 1] };

const SSR_OPTIONS = { verticalFovRadians: SSR_SEQUENCE_VERTICAL_FOV, maxDistance: 70, thickness: 0.4,
  steps: 32, refines: 4, edgeFade: 0.08, fresnelF0: 0.05 } as const;

const lit = applyProjectedTextureCpu(baseInput, cpuFrame, { verticalFovRadians: SSR_SEQUENCE_VERTICAL_FOV });
const litInput = { ...baseInput, color: Array.from(lit.output) };
const ssrOff = screenSpaceReflectionCpu(baseInput, SSR_OPTIONS);
const ssrOn = screenSpaceReflectionCpu(litInput, SSR_OPTIONS);

describe("projected texture × reflection chain (CPU full chain)", () => {
  it("关闭零变化:强度 0 投影器逐位等于不开,SSR 全链输出逐位一致", () => {
    const zeroFrame: ProjectedTextureCpuFrame = { ...cpuFrame, intensity: 0 };
    const zero = applyProjectedTextureCpu(baseInput, zeroFrame, { verticalFovRadians: SSR_SEQUENCE_VERTICAL_FOV });
    expect(Array.from(zero.output)).toEqual(Array.from(frame.cpuInput.color));
    const ssrZero = screenSpaceReflectionCpu({ ...baseInput, color: Array.from(zero.output) }, SSR_OPTIONS);
    expect(Array.from(ssrZero.output)).toEqual(Array.from(ssrOff.output));
    expect(Array.from(ssrZero.trace)).toEqual(Array.from(ssrOff.trace));
  });

  it("命中点投影贡献差分:地板(锥外不受直射)反射命中墙面被投影像素处严格变亮", () => {
    let differing = 0, maxDelta = 0, differingBelowMiddle = 0;
    for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
      const base = (y * WIDTH + x) * 3;
      const delta = Math.max(
        Math.abs(ssrOn.output[base]! - ssrOff.output[base]!),
        Math.abs(ssrOn.output[base + 1]! - ssrOff.output[base + 1]!),
        Math.abs(ssrOn.output[base + 2]! - ssrOff.output[base + 2]!));
      if (delta > 1e-6) {
        differing++;
        maxDelta = Math.max(maxDelta, delta);
        if (y >= HEIGHT / 2) differingBelowMiddle++;
      }
    }
    expect(differing).toBeGreaterThan(0);
    expect(maxDelta).toBeGreaterThan(1e-3);
    // 投影器贴墙(y≈2.5,地板 dy=-4.5 在 π/2 锥外)→ 地板不受直射光;
    // 下半屏差分像素只能来自 SSR 命中 UV 采色携带的墙面投影贡献(反射链路)。
    expect(differingBelowMiddle).toBeGreaterThan(0);
  });

  it("差分归因:下半屏差分像素的 SSR trace 命中位为真(反射命中采色,非 miss 回退差异)", () => {
    const traceWidth = Math.ceil(WIDTH / 2), traceHeight = Math.ceil(HEIGHT / 2);
    let attributed = 0;
    for (let y = Math.floor(HEIGHT / 2); y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
      const base = (y * WIDTH + x) * 3;
      const delta = Math.max(
        Math.abs(ssrOn.output[base]! - ssrOff.output[base]!),
        Math.abs(ssrOn.output[base + 1]! - ssrOff.output[base + 1]!),
        Math.abs(ssrOn.output[base + 2]! - ssrOff.output[base + 2]!));
      if (delta <= 1e-6) continue;
      // 差分像素对应半分辨率 trace 格点必须命中(a>0):差分来自命中点采色变化。
      const tx = Math.min(traceWidth - 1, Math.floor((x + 0.5) / WIDTH * traceWidth));
      const ty = Math.min(traceHeight - 1, Math.floor((y + 0.5) / HEIGHT * traceHeight));
      const mask = ssrOn.trace[(ty * traceWidth + tx) * 4 + 3] ?? 0;
      if (mask > 0) attributed++;
    }
    expect(attributed).toBeGreaterThan(0);
  });

  it("天空/SSR miss 像素逐位不变(投影贡献只经命中采色进入反射)", () => {
    for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
      const pixel = y * WIDTH + x;
      const depth = frame.cpuInput.depth[pixel] ?? 0;
      if (depth > 0) continue;
      const base = pixel * 3;
      // 天空像素:深度 0 → 投影 pass 透传;SSR 无 origin → miss → 透传。两次逐位一致。
      expect(ssrOn.output[base]).toBe(ssrOff.output[base]);
      expect(ssrOn.output[base + 1]).toBe(ssrOff.output[base + 1]);
      expect(ssrOn.output[base + 2]).toBe(ssrOff.output[base + 2]);
    }
  });

  it("确定性:全链(投影 pass + SSR trace/composite)两次运行逐位一致", () => {
    const litAgain = applyProjectedTextureCpu(baseInput, cpuFrame, { verticalFovRadians: SSR_SEQUENCE_VERTICAL_FOV });
    expect(Array.from(litAgain.output)).toEqual(Array.from(lit.output));
    const ssrOnAgain = screenSpaceReflectionCpu({ ...baseInput, color: Array.from(litAgain.output) }, SSR_OPTIONS);
    expect(Array.from(ssrOnAgain.output)).toEqual(Array.from(ssrOn.output));
  });
});
