import { describe, expect, it } from "vitest";
import { validateScene } from "./sceneValidation";

const transform = {
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0 },
  scale: { x: 1, y: 1, z: 1 },
};

describe("scene material validation", () => {
  it("accepts a persistent fire effect for a model or primitive", () => {
    const effects = {
      outline: false, glow: false, xray: false, scanline: false, heatmap: false,
      dissolve: 0, edgeLight: false, color: "#ff6a22", intensity: 1,
      fire: { enabled: true, color: "#ff6a22", intensity: 2.4, height: 3.5, density: 1.25 },
    };
    expect(() => validateScene({
      id: "scene-fire", name: "消防演练",
      camera: { position: { x: 1, y: 2, z: 3 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" },
      models: [{ modelId: "tank-1", name: "储罐", visible: true, opacity: 1, transform, effects }],
      primitives: [{ modelId: "alarm-box", name: "报警点", visible: true, opacity: 1, transform, kind: "box", color: "#ffffff", effects }],
      measurements: [],
    }, "scene")).not.toThrow();
  });

  it("rejects an incomplete fire effect", () => {
    expect(() => validateScene({
      id: "scene-fire", name: "消防演练",
      camera: { position: { x: 1, y: 2, z: 3 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" },
      models: [{
        modelId: "tank-1", name: "储罐", visible: true, opacity: 1, transform,
        effects: { outline: false, glow: false, xray: false, scanline: false, heatmap: false, dissolve: 0, edgeLight: false, color: "#ff6a22", intensity: 1, fire: { enabled: true } },
      }],
      primitives: [], measurements: [],
    }, "scene")).toThrow("color");
  });

  it("rejects unsafe fire density outside the runtime budget", () => {
    expect(() => validateScene({
      id: "scene-fire", name: "消防演练",
      camera: { position: { x: 1, y: 2, z: 3 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" },
      models: [{
        modelId: "tank-1", name: "储罐", visible: true, opacity: 1, transform,
        effects: { outline: false, glow: false, xray: false, scanline: false, heatmap: false, dissolve: 0, edgeLight: false, color: "#ff6a22", intensity: 1, fire: { enabled: true, color: "#ff6a22", intensity: 2, height: 3, density: 10 } },
      }],
      primitives: [], measurements: [],
    }, "scene")).toThrow("density");
  });

  it("accepts a persistent UV animation configuration", () => {
    expect(() => validateScene({
      id: "scene-1",
      name: "产线",
      camera: { position: { x: 1, y: 2, z: 3 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" },
      models: [{
        modelId: "belt-1",
        name: "输送带",
        visible: true,
        opacity: 1,
        animationEnabled: true,
        animationPlayback: { autoplay: true, loopMode: "once" },
        spatialAudio: { enabled: true, url: "/audio/motor.ogg", autoplay: true, loopMode: "loop", muted: false, volume: 0.7, refDistance: 2, maxDistance: 40, rolloffFactor: 1 },
        transform,
        material: {
          baseColorMapUrl: "/textures/belt.png",
          textureRepeatX: 4,
          textureRepeatY: 1.5,
          textureOffsetX: 0.25,
          textureOffsetY: -0.1,
          uvAnimation: { enabled: true, loopMode: "once", durationSeconds: 5, offsetSpeedX: 0.25, offsetSpeedY: 0, rotationSpeed: 0 },
          screen: { enabled: true, sourceType: "video", url: "/media/status.mp4", autoplay: true, loopMode: "loop", muted: true, emissiveIntensity: 1.2 },
        },
      }],
      primitives: [],
      measurements: [],
      animation: { duration: 4, autoplay: true, loop: false, camera: [], models: [] },
    }, "scene")).not.toThrow();
  });

  it("rejects incomplete model screen playback data", () => {
    expect(() => validateScene({
      id: "scene-1",
      name: "产线",
      camera: { position: { x: 1, y: 2, z: 3 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" },
      models: [{ modelId: "screen-1", name: "生产看板", visible: true, opacity: 1, transform, material: { screen: { enabled: true, sourceType: "video", url: "/media/status.mp4" } } }],
      primitives: [],
      measurements: [],
    }, "scene")).toThrow("autoplay");
  });

  it("rejects incomplete UV animation data", () => {
    expect(() => validateScene({
      id: "scene-1",
      name: "产线",
      camera: { position: { x: 1, y: 2, z: 3 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" },
      models: [{ modelId: "belt-1", name: "输送带", visible: true, opacity: 1, transform, material: { uvAnimation: { enabled: true } } }],
      primitives: [],
      measurements: [],
    }, "scene")).toThrow("offsetSpeedX");
  });
});

describe("scene robot planning evidence validation", () => {
  it("accepts explicit payload, TCP and combined center-of-mass evidence", () => {
    expect(() => validateScene(robotScene({
      loadCapability: {
        ratedPayloadKg: 20,
        maximumLoadCenterDistanceMeters: 0.35,
        source: "configured-prefab",
        reference: "robot.articulated-6",
      },
      toolLoad: {
        tcpPositionMeters: { x: 0, y: 0, z: 0.18 },
        tcpOrientationEulerDeg: { x: 0, y: 90, z: 0 },
        toolMassKg: 4.2,
        carriedPayloadKg: 8,
        combinedCenterOfMassMeters: { x: 0, y: 0, z: 0.21 },
        source: "author-confirmed",
      },
    }), "scene")).not.toThrow();
  });

  it("rejects invalid robot planning measurements instead of normalizing them into evidence", () => {
    expect(() => validateScene(robotScene({
      loadCapability: { ratedPayloadKg: 0, source: "author-confirmed" },
    }), "scene")).toThrow("ratedPayloadKg");
    expect(() => validateScene(robotScene({
      toolLoad: { toolMassKg: -1, source: "author-confirmed" },
    }), "scene")).toThrow("toolMassKg");
  });
});

function robotScene(robotPatch: Record<string, unknown>) {
  return {
    id: "scene-robot",
    name: "机器人工位",
    camera: { position: { x: 1, y: 2, z: 3 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" },
    models: [{
      modelId: "robot-1",
      name: "六轴机器人",
      visible: true,
      opacity: 1,
      transform,
      rig: {
        bones: [],
        ik: [],
        robot: {
          enabled: true,
          baseBonePath: "base",
          joints: [{ bonePath: "base/j1", name: "J1", axis: "z", length: 1, minAngleDeg: -180, maxAngleDeg: 180 }],
          ...robotPatch,
        },
      },
    }],
    primitives: [],
    measurements: [],
  };
}
