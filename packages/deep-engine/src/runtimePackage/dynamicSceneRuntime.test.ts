import { describe, expect, it } from "vitest";
import { validateDynamicSceneRuntime } from "./dynamicSceneRuntime.js";

const animation = { schema: "deep-engine.dynamic-animation", schemaVersion: 1, durationMs: 1000, tracks: [{ targetId: "node-a", property: "translation", keyframes: [{ timeMs: 0, value: [0, 0, 0, 0, 0, 0, 1] }, { timeMs: 1000, value: [1, 0, 0, 0, 0, 0, 1] }] }] };
const base = () => ({ schema: "deep-engine.dynamic-runtime", schemaVersion: 1, id: "scene-dynamic", revision: 1, animation });

describe("dynamic scene runtime ABI", () => {
  it("accepts deterministic animation tracks", () => expect(validateDynamicSceneRuntime(base()).valid).toBe(true));
  it("accepts camera tracks and rejects non-boolean playback metadata", () => {
    expect(validateDynamicSceneRuntime({ ...base(), animation: { ...animation, autoplay: true, loop: true, tracks: [{ ...animation.tracks[0], targetId: "scene.camera", property: "camera-position" }] } }).valid).toBe(true);
    expect(validateDynamicSceneRuntime({ ...base(), animation: { ...animation, autoplay: "yes" } }).valid).toBe(false);
  });
  it("accepts strictly ordered offline replay revisions", () => { const value = base(); delete (value as { animation?: unknown }).animation; expect(validateDynamicSceneRuntime({ ...value, dataReplay: { schema: "deep-engine.dynamic-data-replay", schemaVersion: 1, channel: "telemetry", events: [{ revision: 1, timeMs: 0, payload: { value: 1 } }] } }).valid).toBe(true); });
  it("rejects unknown fields, unsorted keyframes and duplicate replay revisions", () => {
    expect(validateDynamicSceneRuntime({ ...base(), extra: true }).valid).toBe(false);
    expect(validateDynamicSceneRuntime({ ...base(), animation: { ...animation, tracks: [{ ...animation.tracks[0], keyframes: [animation.tracks[0].keyframes[1], animation.tracks[0].keyframes[0]] }] } }).valid).toBe(false);
    const value = base(); delete (value as { animation?: unknown }).animation; expect(validateDynamicSceneRuntime({ ...value, dataReplay: { schema: "deep-engine.dynamic-data-replay", schemaVersion: 1, channel: "x", events: [{ revision: 1, timeMs: 0, payload: null }, { revision: 1, timeMs: 1, payload: null }] } }).valid).toBe(false);
  });
  it("rejects unsafe interaction target shapes and empty channels", () => {
    expect(validateDynamicSceneRuntime({ schema: "deep-engine.dynamic-runtime", schemaVersion: 1, id: "x", revision: 1 }).valid).toBe(false);
    const value = base(); delete (value as { animation?: unknown }).animation; expect(validateDynamicSceneRuntime({ ...value, interaction: { schema: "deep-engine.dynamic-interaction", schemaVersion: 1, trigger: "command", action: "clip", targetId: null } }).valid).toBe(false);
  });
  it("accepts the v2 clip controller while preserving strict v1 and reference checks", () => {
    const controller = {
      schema: "deep-engine.animation-controller", schemaVersion: 1,
      initialStateId: "robot:idle", activeStateId: "robot:idle", transitionDurationMs: 250,
      states: [
        { id: "robot:idle", modelId: "robot", clipId: "Idle", loop: true },
        { id: "robot:work", modelId: "robot", clipId: "Work Cycle", loop: true },
      ],
      parameters: { advance: false },
      transitions: [{ id: "idle-work", fromStateId: "robot:idle", toStateId: "robot:work", parameter: "advance", equals: true }],
    };
    expect(validateDynamicSceneRuntime({ ...base(), schemaVersion: 2, animationController: controller }).valid).toBe(true);
    expect(validateDynamicSceneRuntime({ ...base(), animationController: controller }).valid).toBe(false);
    expect(validateDynamicSceneRuntime({ ...base(), schemaVersion: 4 }).valid).toBe(false);
    expect(validateDynamicSceneRuntime({ ...base(), schemaVersion: 2, animationController: { ...controller, activeStateId: "missing" } }).valid).toBe(false);
    expect(validateDynamicSceneRuntime({ ...base(), schemaVersion: 2, animationController: { ...controller, transitions: [{ ...controller.transitions[0], parameter: "missing" }] } }).valid).toBe(false);
  });
  it("accepts kinematic bodies with character parameters and rejects unknown body types", () => {
    const physics = {
      schema: "deep-engine.physics-runtime", schemaVersion: 1, enabled: true, playing: true, gravity: [0, -9.81, 0],
      bodies: [{ id: "body-a", type: "kinematic", initialPose: { translation: [0, 0, 0], rotation: [0, 0, 0, 1] }, mass: 1, friction: 0.5, restitution: 0,
        character: { offset: 0.02, autostep: { enabled: true, maxHeight: 0.3, minWidth: 0.2, includeDynamicBodies: false }, snapToGround: { enabled: true, distance: 0.2 } },
        collider: { kind: "render-bounds", instanceIds: ["instance-a"] } }], joints: [],
    };
    expect(validateDynamicSceneRuntime({ schema: "deep-engine.dynamic-runtime", schemaVersion: 3, id: "scene", revision: 1, physics }).valid).toBe(true);
    expect(validateDynamicSceneRuntime({ schema: "deep-engine.dynamic-runtime", schemaVersion: 3, id: "scene", revision: 1,
      physics: { ...physics, bodies: [{ ...physics.bodies[0], type: "unsupported" }] } }).valid).toBe(false);
    expect(validateDynamicSceneRuntime({ schema: "deep-engine.dynamic-runtime", schemaVersion: 3, id: "scene", revision: 1,
      physics: { ...physics, bodies: [{ ...physics.bodies[0], type: "dynamic" }] } }).valid).toBe(false);
  });

  it("accepts deterministic v3 physics and fails closed on unsupported multibody features", () => {
    const physics = {
      schema: "deep-engine.physics-runtime", schemaVersion: 1, enabled: true, playing: true, gravity: [0, -9.81, 0],
      bodies: [{ id: "body-a", type: "dynamic", initialPose: { translation: [0, 0, 0], rotation: [0, 0, 0, 1] }, mass: 2, friction: 0.5, restitution: 0.1,
        collider: { kind: "render-bounds", instanceIds: ["instance-a"] } }],
      joints: [{ id: "joint-a", kind: "revolute", solver: "impulse", bodyId: "body-a", connectedBodyId: null,
        worldAnchor: [0, 0, 0], localAnchor: [0, 0, 0], axis: [0, 1, 0],
        limits: { enabled: true, min: -1, max: 1 }, motor: { enabled: true, targetVelocity: 2, strength: 4 } }],
    };
    expect(validateDynamicSceneRuntime({ schema: "deep-engine.dynamic-runtime", schemaVersion: 3, id: "scene", revision: 1, physics }).valid).toBe(true);
    expect(validateDynamicSceneRuntime({ schema: "deep-engine.dynamic-runtime", schemaVersion: 2, id: "scene", revision: 1, physics }).valid).toBe(false);
    expect(validateDynamicSceneRuntime({ schema: "deep-engine.dynamic-runtime", schemaVersion: 3, id: "scene", revision: 1,
      physics: { ...physics, joints: [{ ...physics.joints[0], solver: "multibody" }] } }).valid).toBe(false);
    expect(validateDynamicSceneRuntime({ schema: "deep-engine.dynamic-runtime", schemaVersion: 3, id: "scene", revision: 1,
      physics: { ...physics, bodies: [{ ...physics.bodies[0], collider: { kind: "mesh", instanceIds: ["instance-a"] } }] } }).valid).toBe(false);
  });
});
