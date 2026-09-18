import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { configurePostProcessingAntialias, selectPostProcessingSamples } from "./postProcessingAntialias";

describe("HDR composer antialias", () => {
  it.each([
    [[8, 4, 2], [8, 4, 2], 8, 4],
    [[4, 2], [2], 4, 2],
    [[4], [4], 2, 0],
    [[], [4], 4, 0],
    [[4], [], 4, 0],
    [[NaN, Infinity, -1, 2.5, 2], [2.5, 2], 4, 2],
  ])("selects supported common samples: %j / %j, max %s", (color, depth, maximum, expected) => {
    expect(selectPostProcessingSamples(color as number[], depth as number[], maximum as number)).toBe(expected);
  });
  it("configures both actual ping-pong targets without changing HDR color or physical size", () => {
    const gl = { RENDERBUFFER: 1, RGBA16F: 2, DEPTH_COMPONENT24: 3, SAMPLES: 4,
      getInternalformatParameter: vi.fn(() => new Int32Array([4, 2])) };
    const renderer = { getContext: () => gl, capabilities: { maxSamples: 4 } } as unknown as THREE.WebGLRenderer;
    const first = new THREE.WebGLRenderTarget(1600, 900, { type: THREE.HalfFloatType });
    const second = first.clone();
    expect(configurePostProcessingAntialias(renderer, [first, second])).toBe(4);
    for (const target of [first, second]) {
      expect(target.samples).toBe(4);
      expect(target.texture.type).toBe(THREE.HalfFloatType);
      expect([target.width, target.height]).toEqual([1600, 900]);
      target.setSize(980, 600);
      expect(target.samples).toBe(4);
      target.dispose();
    }
    expect(gl.getInternalformatParameter.mock.calls).toEqual([[1, 2, 4], [1, 3, 4]]);
  });
});
