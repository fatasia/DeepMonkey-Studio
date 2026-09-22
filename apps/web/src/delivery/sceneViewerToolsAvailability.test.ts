import { describe, expect, it } from "vitest";
import type { SceneSnapshot } from "@bim-studio/contracts";
import { sceneViewerToolsAvailability } from "./sceneViewerToolsAvailability";

/** 最小合法发布快照：只带判定涉及的字段，其余字段与本判定无关。 */
function sceneFixture(overrides: Partial<SceneSnapshot> = {}): SceneSnapshot {
  return {
    schemaVersion: 1,
    id: "scene-1",
    projectId: "project-1",
    name: "发布场景",
    camera: { position: { x: 4, y: 3, z: 2 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" },
    models: [],
    primitives: [],
    measurements: [],
    createdAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-03T00:00:00.000Z",
    ...overrides,
  };
}

describe("sceneViewerToolsAvailability", () => {
  it("快照未携带剖切与物理字段时两类能力均不可用", () => {
    expect(sceneViewerToolsAvailability(sceneFixture())).toEqual({
      clippingAvailable: false,
      physicsAvailable: false,
    });
  });

  it("快照携带剖切状态时剖切工具可用（对应 deep.scene.section-plane.v1 编译条件）", () => {
    const snapshot = sceneFixture({
      clipping: { enabled: false, axis: "y", offset: 0, inverted: false },
    });
    expect(sceneViewerToolsAvailability(snapshot).clippingAvailable).toBe(true);
  });

  it("物理判定看 physics.enabled：启用为可用，停用或缺失均不可用（对应 deep.scene.physics-runtime.v1）", () => {
    const enabled = sceneViewerToolsAvailability(sceneFixture({
      physics: { enabled: true, playing: true, gravity: { x: 0, y: -9.8, z: 0 } },
    }));
    expect(enabled.physicsAvailable).toBe(true);

    const disabled = sceneViewerToolsAvailability(sceneFixture({
      physics: { enabled: false, playing: false, gravity: { x: 0, y: -9.8, z: 0 } },
    }));
    expect(disabled.physicsAvailable).toBe(false);
  });

  it("测量与爆炸没有快照编译字段可判定，判定对象不伪造这两个维度", () => {
    const availability = sceneViewerToolsAvailability(sceneFixture({
      measurements: [{ id: "m-1", start: { x: 0, y: 0, z: 0 }, end: { x: 1, y: 0, z: 0 }, distance: 1 }],
    }));
    expect(Object.keys(availability).sort()).toEqual(["clippingAvailable", "physicsAvailable"]);
    expect("measurementAvailable" in availability).toBe(false);
    expect("explosionAvailable" in availability).toBe(false);
  });
});
