import { describe, expect, it } from "vitest";
import { normalizedRendererDrawCalls } from "./viewerEngineTypes";

describe("normalizedRendererDrawCalls", () => {
  it("读取 WebGL 的 calls 作为本帧绘制数", () => {
    expect(normalizedRendererDrawCalls("webgl", { calls: 122, drawCalls: 900 })).toBe(122);
  });

  it("读取 WebGPU 的 drawCalls，避免使用累计 render 调用", () => {
    expect(normalizedRendererDrawCalls("webgpu", { calls: 590, drawCalls: 123 })).toBe(123);
  });

  it("在旧统计对象缺字段时安全回退", () => {
    expect(normalizedRendererDrawCalls("webgpu", { calls: 8 })).toBe(8);
    expect(normalizedRendererDrawCalls("webgl", undefined)).toBe(0);
  });
});
