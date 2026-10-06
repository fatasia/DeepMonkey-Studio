/// <reference types="@webgpu/types" />
// B2 MegaLights M1 真机验收探针(headless Chrome WebGPU;模式沿用 clusterLightCullingGpuProbe):
//   ① perf:5000 动态点光(10% 移动)@1920×1080,RIS compute 两趟,wall-clock p50/p95(≤20ms 门);
//   ③ flicker:同场景静态 + 固定帧种子,逐帧颜色差 p99(≤2/255 门,线性域直比更严);
//   ④ area:64 面积光走既有 LTC 交付核(DEEP_AREA_LIGHTING_WGSL + LUT 区,compute 复用)
//      ↔ evaluateAreaLightCpu 网格 RMS(≤1% 门)→ lab/megaLightsGpuProbeAreaLtc.ts;
//   ⑤ parity:8 灯场景穷举模式(GPU ↔ CPU 精确和,退化一致性;容差吸收 GPU FMA)
//      + RIS 单帧无偏性烟雾(严格无偏性由 CPU vitest 门守)→ lab/megaLightsGpuProbeParity.ts;
//   ⑥ visibility:M2 胜者可见性射线——单灯+遮挡盒,阴影区抑制 ≥98%/亮区不变
//      (CPU f64 线段-盒 oracle)/哨兵零/帧时披露;traceTwoLevelOccluded 片段族真机闭环
//      → lab/megaLightsGpuProbeVisibility.ts(⑦ 生产供给 perf 同文件)。
// 体量门拆分:腿间共享层在 lab/megaLightsGpuProbeShared.ts;本文件保留 ①③ 合并腿
// 与 runner 入口面(runner entryPoints 不变)。
// runner:scripts/megaLightsGpuTest.mjs;证据:test-output/ue-class-b2/megalights-m1/。
import { megaLightsFromClustered, packMegaLights } from "../src/lighting/megaLights.js";
import { MegaLightsRuntime } from "../src/lighting/megaLightsRuntime.js";
import { PERF_HEIGHT, PERF_WIDTH, buildPerfLights, buildPerfSurfaces, compilationMessages,
  readbackColor, requestDevice, runFrame, shimSession } from "./megaLightsGpuProbeShared.js";
import { areaLightLtcLeg } from "./megaLightsGpuProbeAreaLtc.js";
import { parityLeg } from "./megaLightsGpuProbeParity.js";
import { visibilityPerfLeg, winnerVisibilityLeg } from "./megaLightsGpuProbeVisibility.js";

/** ① perf + ③ flicker 合并腿:先动态灯计时,再静止 + 固定种子测逐帧差。 */
async function perfAndFlickerLeg(): Promise<Record<string, unknown>> {
  const device = await requestDevice();
  device.addEventListener?.("uncapturederror", (event) => {
    console.error("[uncapturederror]", (event as GPUUncapturedErrorEvent).error.message);
  });
  const runtime = new MegaLightsRuntime(shimSession(device));
  try {
    const width = PERF_WIDTH, height = PERF_HEIGHT;
    const surfaces = buildPerfSurfaces(width, height);
    const frameTimes: number[] = [];
    let resources = { width, height, lightCount: 0 };
    let movers = 0, lightCount = 0;
    for (let frame = 0; frame < 68; frame++) {
      const packed = packMegaLights(megaLightsFromClustered(buildPerfLights(frame)));
      lightCount = packed.count;
      movers = Math.ceil(lightCount / 10);
      resources = { width, height, lightCount };
      runtime.prepare({ width, height, lights: packed, surfaces,
        temporalEnabled: true, spatialEnabled: false, alphaBlend: frame === 0 ? 1 : 1 / 32 });
      frameTimes.push(await runFrame(device, runtime, resources, frame >= 8));
    }
    const sorted = [...frameTimes].sort((a, b) => a - b);
    const percentile = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
    const perf = { frames: frameTimes.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95),
      maxMs: sorted[sorted.length - 1]!, lightCount, movers, width, height, gateMs: 20 };
    const compileMessages = await compilationMessages(runtime);
    if (compileMessages.length) console.error("[compilation]", compileMessages.join(" | "));

    // ③ 静态 + 固定帧种子:同输入逐位回放 → 逐帧差应为 0;门 = 2/255(线性域直比更严)。
    // 相位 1(temporal off,12 帧):冲掉 perf 场景在蓄水池 B 里的陈旧历史(深度门因
    // 同 gbuffer 放行,时域合并会把上一场景的胜者渗入数帧——首测即衰减假帧差);
    // 相位 2(temporal on,alpha=1 全量替换 1 帧)→ 相位 3(alpha=1/32,测量 11 帧)。
    const staticPacked = packMegaLights(megaLightsFromClustered(buildPerfLights(0)));
    runtime.prepare({ width, height, lights: staticPacked, surfaces,
      temporalEnabled: false, spatialEnabled: false, frameSeed: 7, alphaBlend: 1 });
    for (let frame = 0; frame < 12; frame++) {
      await runFrame(device, runtime, { width, height, lightCount: staticPacked.count }, false);
    }
    runtime.prepare({ width, height, lights: staticPacked, surfaces,
      temporalEnabled: true, spatialEnabled: false, frameSeed: 7, alphaBlend: 1 });
    await runFrame(device, runtime, { width, height, lightCount: staticPacked.count }, false);
    runtime.prepare({ width, height, lights: staticPacked, surfaces,
      temporalEnabled: true, spatialEnabled: false, frameSeed: 7, alphaBlend: 1 / 32 });
    let previous: Float32Array | undefined;
    let maxFrameDiffP99 = 0, framesCompared = 0;
    const perFrameP99: number[] = [];
    for (let frame = 0; frame < 12; frame++) {
      await runFrame(device, runtime, { width, height, lightCount: staticPacked.count }, false);
      const color = await readbackColor(device, runtime);
      if (previous) {
        const diffs: number[] = [];
        for (let index = 0; index < color.length; index += 4) {
          diffs.push(Math.abs(color[index]! - previous[index]!) + Math.abs(color[index + 1]! - previous[index + 1]!)
            + Math.abs(color[index + 2]! - previous[index + 2]!));
        }
        diffs.sort((a, b) => a - b);
        const p99 = diffs[Math.floor(diffs.length * 0.99)]!;
        perFrameP99.push(p99);
        maxFrameDiffP99 = Math.max(maxFrameDiffP99, p99);
        framesCompared++;
      }
      previous = color;
    }
    // 非零输出哨兵:全零 = 通路空转(③ 的 diff=0 会是空真),必须挡下。
    const meanLuminance = previous!.reduce((sum, value, index) => index % 4 === 3 ? sum : sum + value, 0)
      / (previous!.length / 4 * 3);
    return { action: "megalights-perf-flicker", perf, compileMessages,
      meanLuminance, perFrameP99,
      flicker: { framesCompared, maxFrameDiffP99, gate: 2 / 255, pass: maxFrameDiffP99 <= 2 / 255 },
      perfPass: percentile(0.95) <= 20 && meanLuminance > 0 };
  } finally { runtime.dispose(); }
}

// ---- 组装入口(runner 逐腿调用) ----

export function probeAdapterInfo(): unknown {
  return { href: location.href, userAgent: navigator.userAgent, webgpu: "gpu" in navigator };
}

export async function runPerfFlicker(): Promise<Record<string, unknown>> {
  return perfAndFlickerLeg();
}

export async function runAreaLtc(): Promise<Record<string, unknown>> {
  return areaLightLtcLeg();
}

export async function runParity(): Promise<Record<string, unknown>> {
  return parityLeg();
}

export async function runWinnerVisibility(): Promise<Record<string, unknown>> {
  return winnerVisibilityLeg();
}

/** ⑦ 生产供给 perf(2026-10-05 TLAS 供给收口):5000 灯 1080p 三趟 p95 门。 */
export async function runVisibilityPerf(): Promise<Record<string, unknown>> {
  return visibilityPerfLeg();
}
