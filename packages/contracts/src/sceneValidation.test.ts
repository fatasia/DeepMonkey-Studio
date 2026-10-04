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

  describe("fire particle curves, blend and budget", () => {
    const sceneWithFire = (fire: Record<string, unknown>) => ({
      id: "scene-fire", name: "消防演练",
      camera: { position: { x: 1, y: 2, z: 3 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" },
      models: [{
        modelId: "tank-1", name: "储罐", visible: true, opacity: 1, transform,
        effects: {
          outline: false, glow: false, xray: false, scanline: false, heatmap: false, dissolve: 0, edgeLight: false,
          color: "#ff6a22", intensity: 1,
          fire: { enabled: true, color: "#ff6a22", intensity: 2, height: 3, density: 1, ...fire },
        },
      }],
      primitives: [], measurements: [],
    });

    it("accepts valid curves, blend mode and particle cap", () => {
      expect(() => validateScene(sceneWithFire({
        blend: "alpha", maxParticles: 128,
        curves: {
          size: [{ time: 0, value: 0.5 }, { time: 1, value: 2 }],
          alpha: [{ time: 0, value: 0 }, { time: 0.2, value: 1 }, { time: 1, value: 0 }],
          color: [{ time: 0, value: 1 }],
        },
      }), "scene")).not.toThrow();
    });

    it.each([
      ["blend", { blend: "multiply" }],
      ["maxParticles", { maxParticles: 4096 }],
      ["value", { curves: { alpha: [{ time: 0, value: 2 }] } }],
      ["time", { curves: { size: [{ time: 0.5, value: 1 }, { time: 0.5, value: 1 }] } }],
      ["关键帧数量", { curves: { size: [] } }],
      ["time", { curves: { color: [{ time: 1.5, value: 1 }] } }],
    ])("rejects invalid %s", (needle, fire) => {
      expect(() => validateScene(sceneWithFire(fire), "scene")).toThrow(needle);
    });
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

describe("scene animation keyframe validation", () => {
  const camera = (x: number) => ({ position: { x, y: 0, z: 5 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" as const });

  function animationScene(animation: unknown) {
    return {
      id: "scene-kf", name: "巡检",
      camera: camera(0),
      models: [{ modelId: "pump-1", name: "循环泵", visible: true, opacity: 1, transform }],
      primitives: [],
      measurements: [],
      animation,
    };
  }

  it("roundtrips UI-authored easings, bezier params, visibility and emissive intensity", () => {
    // UI 面板允许的完整写出集合：ease-in-out 轨道默认 + cubic-bezier 帧过渡 + 自发光/可见性帧。
    expect(() => validateScene(animationScene({
      duration: 10, loop: true,
      modelInterpolation: "ease-in-out",
      cameraInterpolation: "spline",
      camera: [
        { id: "k1", time: 0, camera: camera(0), transition: "cubic-bezier", easing: [0.42, 0, 0.58, 1] },
        { id: "k2", time: 10, camera: camera(8), transition: "ease-in-out" },
      ],
      models: [
        { id: "m1", time: 0, modelId: "pump-1", transform, transition: "cubic-bezier", easing: [0.5, 0, 0.5, 1], visibility: true, emissiveIntensity: 0.2 },
        { id: "m2", time: 10, modelId: "pump-1", transform, emissiveIntensity: 2.4, visibility: false },
      ],
    }), "scene")).not.toThrow();
  });

  it("keeps rejecting unknown interpolation and malformed bezier payloads", () => {
    expect(() => validateScene(animationScene({ duration: 4, loop: true, camera: [], models: [], modelInterpolation: "bounce" }), "scene")).toThrow("modelInterpolation");
    expect(() => validateScene(animationScene({
      duration: 4, loop: true, camera: [], models: [
        { id: "m1", time: 0, modelId: "pump-1", transform, transition: "cubic-bezier", easing: [0.4, 0, 0.6] },
      ],
    }), "scene")).toThrow();
    expect(() => validateScene(animationScene({
      duration: 4, loop: true, camera: [], models: [
        { id: "m1", time: 0, modelId: "pump-1", transform, transition: "spring" },
      ],
    }), "scene")).toThrow("transition");
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


describe("material slot persistence validation", () => {
  const scene = (slotOverrides: unknown) => ({ id: "slots", name: "Slots",
    camera: { position: { x: 0, y: 2, z: 3 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" },
    models: [{ modelId: "a", name: "A", visible: true, opacity: 1, transform, material: { slotOverrides } }],
    primitives: [], measurements: [] });
  it("accepts typed stable slot overrides after JSON persistence", () => {
    expect(() => validateScene(JSON.parse(JSON.stringify(scene({ "gltf:0": { roughness: 0.4, ior: 2.4 } }))), "scene")).not.toThrow();
  });
  it.each([0, -1, NaN, Infinity, 1e100, "1.5"])("rejects invalid source or authored IOR %s", ior => {
    expect(() => validateScene(scene({ "gltf:0": { ior } }), "scene")).toThrow();
  });
  it.each([{ "runtime-uuid": {} }, { "gltf:0": { roughness: "wrong" } }, { "gltf:0": { slotOverrides: {} } }])(
    "rejects unstable, mistyped and nested overrides", slots => {
      expect(() => validateScene(scene(slots), "scene")).toThrow();
    });
  it("accepts MeshPhysicalMaterial lobes in range and rejects out-of-range or malformed values", () => {
    const lobes = { clearcoat: 1, clearcoatRoughness: 0.2, sheen: 0.5, sheenRoughness: 0.4, sheenColor: "#ff8800",
      iridescence: 1, iridescenceIOR: 1.3, iridescenceThicknessMax: 400, transmission: 0.9, thickness: 1.2,
      attenuationColor: "#80ff80", attenuationDistance: 2.5 };
    expect(() => validateScene(JSON.parse(JSON.stringify(scene({ "gltf:0": lobes }))), "scene")).not.toThrow();
    for (const bad of [{ clearcoat: 1.5 }, { sheen: -0.1 }, { iridescenceIOR: 0.5 }, { iridescenceThicknessMax: 1e5 },
      { thickness: -1 }, { attenuationDistance: 0 }, { attenuationDistance: Infinity }, { sheenColor: "red" }, { attenuationColor: "#fff" }]) {
      expect(() => validateScene(scene({ "gltf:0": bad }), "scene")).toThrow();
    }
  });
});
