import { describe, expect, it } from "vitest";
import { aggregateSsrTiers, classifySsrMiss, decideSsrFallback } from "./screenSpaceReflectionFallback.js";

const BASE = { ssrMask: 0, originDepth: 5, roughness: 0.1, historyValid: true } as const;

describe("decideSsrFallback 单像素决策表", () => {
  it("no-origin：深度缺失直接回退 base，不允许任何档位加能量", () => {
    expect(decideSsrFallback({ ...BASE, originDepth: 0, ssrMask: 0.5 })).toEqual({
      source: "fallback-base", reason: "no-origin", weight: 0 });
  });
  it("命中：weight 等于 trace mask 且夹到 [0,1]", () => {
    expect(decideSsrFallback({ ...BASE, ssrMask: 0.42, reflectedZ: -1 })).toEqual({
      source: "ssr", reason: "hit", weight: 0.42 });
    expect(decideSsrFallback({ ...BASE, ssrMask: 1.7 }).weight).toBe(1);
    expect(decideSsrFallback({ ...BASE, ssrMask: -0.2 }).weight).toBe(0);
  });
  it("粗糙度超阈：即使有命中也回退探针（roughness-exceeds）", () => {
    expect(decideSsrFallback({ ...BASE, ssrMask: 0.9, roughness: 0.95,
      roughnessFallbackThreshold: 0.85 })).toEqual({ source: "probe", reason: "roughness-exceeds", weight: 0 });
    // 默认阈 1 = 关闭：roughness 0.95 不触发。
    expect(decideSsrFallback({ ...BASE, ssrMask: 0.9, roughness: 0.95 }).source).toBe("ssr");
  });
  it("历史失效：屏外扩展档被降级为探针，理由标记 history-invalid", () => {
    const miss = { ...BASE, reflectedZ: -1 };
    expect(decideSsrFallback({ ...miss, extensionMask: 0.8, rayExtensionAvailable: true }))
      .toEqual({ source: "ray-extension", reason: "hit", weight: 0.8 });
    expect(decideSsrFallback({ ...miss, extensionMask: 0.8, rayExtensionAvailable: true, historyValid: false }))
      .toEqual({ source: "probe", reason: "history-invalid", weight: 0 });
    // 扩展不可用或未命中时同样探针档，但理由保持 miss 族而不是 history-invalid。
    const unavailable = decideSsrFallback({ ...miss, extensionMask: 0.8, rayExtensionAvailable: false });
    expect(unavailable.source).toBe("probe");
    expect(unavailable.reason).toBe("step-exhausted");
  });
  it("miss 族理由透传：背面/步进耗尽分别成立", () => {
    expect(decideSsrFallback({ ...BASE, reflectedZ: 1 }).reason).toBe("reflected-behind");
    expect(decideSsrFallback({ ...BASE, reflectedZ: -1 }).reason).toBe("step-exhausted");
  });
});

describe("classifySsrMiss 与 WGSL 早退边界一一对应", () => {
  it("空洞拒绝优先于其他族（细化终点落深度 0）", () => {
    expect(classifySsrMiss(-1, true, false, true)).toBe("depth-hole");
    expect(classifySsrMiss(1, true, false, false)).toBe("reflected-behind");
    expect(classifySsrMiss(-1, false, false, false)).toBe("off-screen");
    expect(classifySsrMiss(-1, true, true, false)).toBe("step-exhausted");
  });
});

describe("aggregateSsrTiers 帧级分档", () => {
  it("计数与理由表一致，回退率可由 probe+fallbackBase 除以总数复算", () => {
    const stats = aggregateSsrTiers([
      { source: "ssr", reason: "hit", weight: 0.5 },
      { source: "ssr", reason: "hit", weight: 0.2 },
      { source: "ray-extension", reason: "hit", weight: 0.7 },
      { source: "probe", reason: "off-screen", weight: 0 },
      { source: "fallback-base", reason: "no-origin", weight: 0 },
    ]);
    expect(stats).toMatchObject({ ssr: 2, rayExtension: 1, probe: 1, fallbackBase: 1 });
    expect(stats.reasons).toEqual({ hit: 3, "off-screen": 1, "no-origin": 1 });
  });
});
