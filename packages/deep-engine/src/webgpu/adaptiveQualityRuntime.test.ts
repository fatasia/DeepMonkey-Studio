import { describe, expect, it } from "vitest";
import { ProbeClipmapUpdateScheduler } from "../lighting/probeClipmapUpdateScheduler.js";
import { pbrVisibilityInput } from "./pbrVisibilityInput.js";
import type { RenderView } from "./pbrRendererTypes.js";

describe("adaptive quality runtime consumers", () => {
  it("reduces only the LOD projection scale while preserving the physical culling frustum", () => {
    const view = { eye: [0, 0, 5], target: [0, 0, 0], up: [0, 1, 0] } as unknown as RenderView;
    const projection = { verticalFovRadians: 1, near: 0.1, far: 100 };
    const result = pbrVisibilityInput(view, projection, 1920, 1080, false, 0.75);
    expect(result.lod.viewport).toEqual({ width: 1440, height: 810 });
    expect(() => pbrVisibilityInput(view, projection, 1920, 1080, false, 0.4)).toThrow(/detail scale/);
  });

  it("bounds DDGI work per frame without changing the scheduler's admitted capacity", async () => {
    const publisher = { setValidated: async (plan: object) => ({ status: "reused", resource: { plan }, evidence: {
      generation: 1, allocatedBytes: 0, updatedBytes: 0, updateCount: 4, createdBufferCount: 0, reusedBufferCount: 3,
    } }) } as never;
    const scheduler = new ProbeClipmapUpdateScheduler(publisher, { frameBudget: 8, cameraCutBudget: 12 });
    const result = await scheduler.submit({ frame: 0, deviceEpoch: "adaptive", viewport: [1280, 720],
      cameraPosition: [0, 0, 0], sceneBounds: { min: [-10, -10, -10], max: [10, 10, 10] },
      options: { levelCount: 2, gridSize: [4, 2, 4] }, frameBudget: 4 });
    expect(result.stats).toMatchObject({ frameBudget: 4, capacityBudget: 12, updateCount: 4 });
    await expect(scheduler.submit({ frame: 1, deviceEpoch: "adaptive", viewport: [1280, 720],
      cameraPosition: [0, 0, 0], sceneBounds: null, frameBudget: 9 })).rejects.toThrow(/frameBudget/);
  });
});
