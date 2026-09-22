import { describe, expect, it } from "vitest";
import type { DeepRuntimePackage } from "@bim-studio/deep-engine/runtime-package";
import { applyDynamicRuntimeFrame, canonicalDynamicRuntimeFrame, sampleDynamicRuntimePackage } from "./dynamicRuntimePlayback";

function packageFixture(): DeepRuntimePackage {
  return {
    schema: "deep-engine.runtime-package",
    schemaVersion: 7,
    packageId: "fixture",
    packageVersion: "1",
    entrypoints: { renderPacket: "render", deep2d: null, environment: "env", shaderPackages: [], dynamicRuntime: "scene.dynamic" },
    resources: [],
    payloads: {
      "scene.dynamic": {
        schema: "deep-engine.dynamic-runtime",
        schemaVersion: 1,
        id: "scene.dynamic",
        revision: 1,
        animation: {
          schema: "deep-engine.dynamic-animation",
          schemaVersion: 1,
          durationMs: 1000,
          tracks: [
            { targetId: "pump", property: "translation", keyframes: [{ timeMs: 0, value: [0, 0, 0, 0, 0, 0, 1] }, { timeMs: 1000, value: [10, 2, 0, 0, 0, 0, 1] }] },
            { targetId: "pump", property: "rotation", keyframes: [{ timeMs: 0, value: [0, 0, 0, 0, 0, 0, 1] }, { timeMs: 1000, value: [0, 0, 0, 0, 0, 1, 0] }] },
            { targetId: "pump", property: "scale", keyframes: [{ timeMs: 0, value: [1, 1, 1, 0, 0, 0, 1] }, { timeMs: 1000, value: [2, 2, 2, 0, 0, 0, 1] }] },
          ],
        },
        dataReplay: { schema: "deep-engine.dynamic-data-replay", schemaVersion: 1, channel: "telemetry", events: [{ revision: 1, timeMs: 400, payload: { value: 7 } }] },
        interaction: { schema: "deep-engine.dynamic-interaction", schemaVersion: 1, trigger: "command", action: "select", targetId: "pump" },
      },
    },
    packageHash: { algorithm: "sha256", value: "fixture" },
    materialBindings: [],
  } as DeepRuntimePackage;
}

describe("dynamic runtime Web consumer", () => {
  it("samples compiled v7 tracks and clamps the runtime clock", () => {
    const frame = sampleDynamicRuntimePackage(packageFixture(), 500);
    expect(frame.timeMs).toBe(500);
    expect(frame.transforms.pump?.translation).toEqual([5, 1, 0]);
    expect(frame.transforms.pump?.scale).toEqual([1.5, 1.5, 1.5]);
    expect(frame.replayEvents).toHaveLength(1);
    expect(sampleDynamicRuntimePackage(packageFixture(), 2_000).timeMs).toBe(1000);
  });

  it("honors the lowered transition on the ending keyframe", () => {
    const value = packageFixture();
    const animation = (value.payloads["scene.dynamic"] as any).animation;
    animation.tracks[0].keyframes[1].transition = "ease-in";
    expect(sampleDynamicRuntimePackage(value, 500).transforms.pump?.translation?.[0]).toBe(2.5);
    animation.tracks[0].keyframes[1].transition = "step";
    expect(sampleDynamicRuntimePackage(value, 500).transforms.pump?.translation?.[0]).toBe(0);
  });

  it("applies one sampled frame to scene, replay, and interaction consumers", () => {
    const calls: string[] = [];
    const frame = applyDynamicRuntimeFrame(packageFixture(), 500, {
      applyTransform: (id, transform) => calls.push(`${id}:${transform.translation?.[0]}`),
      applyReplayEvent: (channel, event) => calls.push(`${channel}:${event.revision}`),
      applyInteraction: interaction => calls.push(`${interaction.action}:${interaction.targetId}`),
    });
    expect(frame.transforms.pump).toBeTruthy();
    expect(calls).toEqual(["pump:5", "telemetry:1", "select:pump"]);
  });
});

describe("dynamic runtime cross-end canonical frames", () => {
  it("emits the byte-exact canonical contract shared with the Native consumer", () => {
    const frame = canonicalDynamicRuntimeFrame(packageFixture(), 500);
    expect(frame.timeMs).toBe(500);
    expect(frame.replayRevisions).toEqual([1]);
    expect(frame.canonical).toBe(
      "dynamic-frame-v1|t=500|events=1|tracks="
      + "pump>rotation=0.000000,0.000000,0.000000,0.000000,0.000000,0.500000,0.500000;"
      + "pump>scale=1.500000,1.500000,1.500000,0.000000,0.000000,0.000000,1.000000;"
      + "pump>translation=5.000000,1.000000,0.000000,0.000000,0.000000,0.000000,1.000000",
    );
  });
  it("clamps the clock and sorts tracks by target then property", () => {
    const frame = canonicalDynamicRuntimeFrame(packageFixture(), 2_000);
    expect(frame.timeMs).toBe(1000);
    expect(frame.canonical).toContain("|t=1000|");
    expect(frame.canonical.indexOf("pump>rotation")).toBeLessThan(frame.canonical.indexOf("pump>scale"));
    expect(frame.canonical.indexOf("pump>scale")).toBeLessThan(frame.canonical.indexOf("pump>translation"));
    expect(frame.replayRevisions).toEqual([1]);
  });
  it("normalizes negative zero to keep the Rust consumer byte-identical", () => {
    const runtime = packageFixture();
    const dynamic = runtime.payloads["scene.dynamic"] as { animation: { tracks: { targetId: string; property: string; keyframes: { timeMs: number; value: number[] }[] }[] } };
    dynamic.animation.tracks = [{ targetId: "pump", property: "translation", keyframes: [{ timeMs: 0, value: [-0, 0, 0, 0, 0, 0, 1] }] }];
    const frame = canonicalDynamicRuntimeFrame(runtime, 0);
    expect(frame.canonical).toBe(
      "dynamic-frame-v1|t=0|events=|tracks=pump>translation=0.000000,0.000000,0.000000,0.000000,0.000000,0.000000,1.000000",
    );
  });
});
