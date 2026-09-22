import { describe, expect, it } from "vitest";
import type { DeepRuntimePackage } from "@bim-studio/deep-engine/runtime-package";
import { applyDynamicRuntimeFrame, sampleDynamicRuntimePackage } from "./dynamicRuntimePlayback";

function visiblePackage(): DeepRuntimePackage {
  return {
    schema: "deep-engine.runtime-package", schemaVersion: 7, packageId: "vis", packageVersion: "1",
    entrypoints: { renderPacket: "render", deep2d: null, environment: "env", shaderPackages: [], dynamicRuntime: "scene.dynamic" },
    resources: [],
    payloads: {
      "scene.dynamic": {
        schema: "deep-engine.dynamic-runtime", schemaVersion: 1, id: "scene.dynamic", revision: 1,
        animation: { schema: "deep-engine.dynamic-animation", schemaVersion: 1, durationMs: 1000, tracks: [
          { targetId: "pump", property: "object-visible", keyframes: [
            { timeMs: 0, value: [0, 0, 0, 0, 0, 0, 1] }, { timeMs: 1000, value: [1, 0, 0, 0, 0, 0, 1] }] },
        ] },
      },
    },
    packageHash: { algorithm: "sha256", value: "fixture" }, materialBindings: [],
  } as DeepRuntimePackage;
}

describe("B2-a object visibility track", () => {
  it("samples visible state with the 0.5 threshold", () => {
    const hidden = sampleDynamicRuntimePackage(visiblePackage(), 200);
    const shown = sampleDynamicRuntimePackage(visiblePackage(), 900);
    expect(hidden.visibleTargets).toEqual([{ targetId: "pump", visible: false }]);
    expect(shown.visibleTargets).toEqual([{ targetId: "pump", visible: true }]);
    expect(hidden.transforms.pump).toBeUndefined();
  });
  it("applies visibility through the optional sink without breaking legacy hosts", () => {
    const calls: string[] = [];
    applyDynamicRuntimeFrame(visiblePackage(), 200, {
      applyTransform: () => {}, applyVisibility: (id, visible) => calls.push(`${id}:${visible}`),
    });
    expect(calls).toEqual(["pump:false"]);
    const legacy: string[] = [];
    applyDynamicRuntimeFrame(visiblePackage(), 200, { applyTransform: () => {} });
    expect(legacy).toEqual([]);
  });
});
