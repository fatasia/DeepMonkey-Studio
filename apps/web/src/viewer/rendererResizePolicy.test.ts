import { describe, expect, it } from "vitest";
import { canChangeRendererPixelRatio, shouldResizeRendererDrawingBuffer } from "./rendererResizePolicy";

describe("rendererResizePolicy", () => {
  it("始终允许首次分配绘图缓冲", () => {
    expect(shouldResizeRendererDrawingBuffer({ backend: "webgpu", drawingBufferInitialized: false, shadowsEnabled: true })).toBe(true);
  });

  it("锁定已启用阴影的 WebGPU 绘图缓冲", () => {
    const input = { backend: "webgpu" as const, drawingBufferInitialized: true, shadowsEnabled: true };
    expect(shouldResizeRendererDrawingBuffer(input)).toBe(false);
    expect(canChangeRendererPixelRatio(input)).toBe(false);
  });

  it("允许 WebGL 与无阴影 WebGPU 正常调整", () => {
    expect(shouldResizeRendererDrawingBuffer({ backend: "webgl", drawingBufferInitialized: true, shadowsEnabled: true })).toBe(true);
    expect(shouldResizeRendererDrawingBuffer({ backend: "webgpu", drawingBufferInitialized: true, shadowsEnabled: false })).toBe(true);
  });
});
