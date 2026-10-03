import { describe, expect, it } from "vitest";
import { prepareSceneCommandTransaction } from "./sceneCommandTransaction.js";
import type { SceneCommand } from "./protocol.js";
import {
  isSceneCommand,
  parseSceneCommand,
  SCENE_COMMAND_VALIDATION_LIMITS,
  SceneCommandValidationError,
  validateSceneCommand
} from "./commandValidation.js";

const objectTarget = { kind: "object", sceneId: "scene:1", objectId: "object:1" } as const;

const validCommands: SceneCommand[] = [
  { id: "visibility", type: "object.set-visibility", target: objectTarget, visible: false },
  {
    id: "transform",
    type: "object.set-transform",
    target: { kind: "mesh", sceneId: "scene:1", objectId: "object:1", meshId: "mesh:1" },
    position: [1, 2, 3],
    rotation: [0, Math.PI, 0],
    scale: [-1, 1, 1]
  },
  {
    id: "material",
    type: "material.set",
    target: objectTarget,
    patch: { color: "#2f81f7", roughness: 0.35, metalness: 0.8, textureRepeatX: 2, doubleSided: true }
  },
  { id: "selection", type: "selection.set", targets: [{ kind: "scene", sceneId: "scene:1" }, objectTarget] },
  {
    id: "camera",
    type: "camera.set",
    sceneId: "scene:1",
    position: [1, 2, 3],
    target: [0, 0, 0],
    near: 0.1,
    far: 10_000,
    fov: 60
  },
  { id: "fly-position", type: "camera.fly-to", sceneId: "scene:1", target: { position: [1, 2, 3] }, durationMs: 0 },
  { id: "fly-object", type: "camera.fly-to", sceneId: "scene:1", target: objectTarget, durationMs: 500 },
  { id: "animation", type: "animation.control", target: objectTarget, action: "seek", clipId: "clip:1", time: 1.5 },
  {
    id: "data",
    type: "data.apply",
    target: objectTarget,
    values: { temperature: 21, enabled: true, metadata: [null, "online", { quality: 0.98 }] },
    timestamp: "2026-08-25T00:00:00.000Z"
  },
  { id: "component", type: "component.update", componentId: "widget:1", patch: { visible: true, frame: { x: 12, y: 20 } } },
  { id: "unity-properties", type: "unity.properties.set", componentId: "unity:1", values: { visible: true, lightIntensity: 2.5 } },
  { id: "unity-action", type: "unity.action.invoke", componentId: "unity:1", action: "play", objectId: "robot:1", value: { speed: 1.2 } },
  { id: "unity-scene", type: "unity.scene.switch", componentId: "unity:1", scene: "Factory" }
];

describe("validateSceneCommand", () => {
  it.each(validCommands)("accepts and detaches $type", (command) => {
    const result = validateSceneCommand(command);

    expect(result).toEqual({ valid: true, command, issues: [] });
    expect(result.valid && result.command).not.toBe(command);
    if (result.valid && "target" in command && "target" in result.command && typeof command.target === "object") {
      expect(result.command.target).not.toBe(command.target);
    }
  });

  it.each([
    [{ type: "selection.set", targets: [] }, "$.id", "missing-property"],
    [{ id: "", type: "selection.set", targets: [] }, "$.id", "invalid-value"],
    [{ id: "x", type: "renderer.take-over" }, "$.type", "invalid-value"],
    [{ id: "x", type: "object.set-visibility", target: objectTarget, visible: "yes" }, "$.visible", "invalid-type"],
    [{ id: "x", type: "object.set-transform", target: objectTarget, position: [0, 1] }, "$.position", "invalid-value"],
    [{ id: "x", type: "object.set-transform", target: objectTarget, rotation: [0, Number.NaN, 0] }, "$.rotation[1]", "invalid-type"],
    [{ id: "x", type: "material.set", target: objectTarget, patch: {} }, "$.patch", "invalid-value"],
    [{ id: "x", type: "material.set", target: objectTarget, patch: { color: "red" } }, "$.patch.color", "invalid-value"],
    [{ id: "x", type: "material.set", target: objectTarget, patch: { roughness: 1.5 } }, "$.patch.roughness", "invalid-value"],
    [{ id: "x", type: "material.set", target: objectTarget, patch: { baseColorMapUrl: "https://untrusted.test/map.png" } }, "$.patch.baseColorMapUrl", "unknown-property"],
    [{ id: "x", type: "selection.set", targets: [{ kind: "object", sceneId: "scene:1" }] }, "$.targets[0].objectId", "missing-property"],
    [{ id: "x", type: "camera.set", sceneId: "scene:1", position: [0, 0, 0], target: [0, 0, 0], near: 10, far: 1 }, "$.far", "invalid-value"],
    [{ id: "x", type: "camera.set", sceneId: "scene:1", position: [0, 0, 0], target: [0, 0, 0], fov: 180 }, "$.fov", "invalid-value"],
    [{ id: "x", type: "camera.fly-to", sceneId: "scene:1", target: objectTarget, durationMs: -1 }, "$.durationMs", "invalid-value"],
    [{ id: "x", type: "animation.control", target: objectTarget, action: "rewind" }, "$.action", "invalid-value"],
    [{ id: "x", type: "animation.control", target: objectTarget, action: "seek", time: -0.1 }, "$.time", "invalid-value"],
    [{ id: "x", type: "selection.set", targets: [], debug: true }, "$.debug", "unknown-property"],
    [{ id: "x", type: "data.apply", target: objectTarget, values: { bad: Number.POSITIVE_INFINITY }, timestamp: "now" }, "$.values.bad", "invalid-value"],
    [{ id: "x", type: "unity.properties.set", componentId: "unity:1", values: { bad: Number.NaN } }, "$.values.bad", "invalid-value"],
    [{ id: "x", type: "unity.action.invoke", componentId: "unity:1", action: "" }, "$.action", "invalid-value"],
    [{ id: "x", type: "unity.scene.switch", componentId: "unity:1", scene: 2 }, "$.scene", "invalid-type"]
  ] as const)("rejects malformed command %# with a precise issue", (command, path, code) => {
    const result = validateSceneCommand(command);

    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path, code })]));
  });

  it("rejects cycles, prototype-pollution keys, sparse arrays, and oversized identifiers", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const polluted = JSON.parse('{"__proto__":{"admin":true}}') as unknown;
    const sparseTargets = new Array(1);
    const longId = "x".repeat(SCENE_COMMAND_VALIDATION_LIMITS.maxIdentifierLength + 1);

    const inputs = [
      { id: "cycle", type: "data.apply", target: objectTarget, values: cycle, timestamp: "now" },
      { id: "pollution", type: "data.apply", target: objectTarget, values: polluted, timestamp: "now" },
      { id: "sparse", type: "selection.set", targets: sparseTargets },
      { id: longId, type: "selection.set", targets: [] }
    ];

    for (const input of inputs) expect(validateSceneCommand(input).valid).toBe(false);
  });

  it("does not execute accessors or mutate the input", () => {
    let getterCalls = 0;
    const command = {
      id: "visibility",
      type: "object.set-visibility",
      target: objectTarget,
      get visible() {
        getterCalls += 1;
        return true;
      }
    };
    const snapshot = Object.getOwnPropertyDescriptors(command);

    const result = validateSceneCommand(command);

    expect(result.valid).toBe(false);
    expect(getterCalls).toBe(0);
    expect(Object.getOwnPropertyDescriptors(command)).toEqual(snapshot);
    if (!result.valid) expect(result.issues).toContainEqual(expect.objectContaining({ path: "$.visible", code: "unsafe-object" }));
  });

  it("never throws when object reflection fails", () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const throwing = new Proxy({}, {
      getPrototypeOf: () => { throw new Error("hostile prototype"); },
      ownKeys: () => { throw new Error("hostile keys"); }
    });

    expect(() => validateSceneCommand(revoked.proxy)).not.toThrow();
    expect(() => validateSceneCommand(throwing)).not.toThrow();
    expect(validateSceneCommand(revoked.proxy).valid).toBe(false);
    expect(validateSceneCommand(throwing).valid).toBe(false);
  });
});

describe("parseSceneCommand", () => {
  it("returns a clean command and preserves JSON serialization", () => {
    const parsed = parseSceneCommand(validCommands.at(-1));

    expect(parsed).toEqual(validCommands.at(-1));
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(parsed);
  });

  it("throws an actionable typed error", () => {
    let thrown: unknown;
    try {
      parseSceneCommand({ id: "bad", type: "camera.fly-to", sceneId: "scene:1", target: { position: [0, "high", 0] }, durationMs: 500 });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SceneCommandValidationError);
    expect(thrown).toMatchObject({
      name: "SceneCommandValidationError",
      issues: expect.arrayContaining([expect.objectContaining({ path: "$.target.position[1]" })])
    });
    expect((thrown as Error).message).toContain("$.target.position[1]");
  });
});

describe("isSceneCommand", () => {
  it("provides a boolean boundary check", () => {
    expect(isSceneCommand(validCommands[0])).toBe(true);
    expect(isSceneCommand({ id: "bad", type: "selection.set", targets: "all" })).toBe(false);
  });
});

describe("H-C7-P4 B5 命令面:lighting.set / environment.set", () => {
  it("lighting.set 合法 patch 解析,至少一字段合同", () => {
    const result = validateSceneCommand({ id: "l1", type: "lighting.set", sceneId: "s", patch: { intensity: 1.5, globalIlluminationEnabled: true } });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.command).toMatchObject({ type: "lighting.set", sceneId: "s", patch: { intensity: 1.5, globalIlluminationEnabled: true } });
    }
    expect(validateSceneCommand({ id: "l2", type: "lighting.set", sceneId: "s", patch: {} }).valid).toBe(false);
    expect(validateSceneCommand({ id: "l3", type: "lighting.set", sceneId: "s", patch: { intensity: -1 } }).valid).toBe(false);
    expect(validateSceneCommand({ id: "l4", type: "lighting.set", sceneId: "s", patch: { unknown: 1 } }).valid).toBe(false);
  });

  it("environment.set 合法 patch 解析,weather 枚举与 backgroundColor", () => {
    const result = validateSceneCommand({ id: "e1", type: "environment.set", sceneId: "s", patch: { weather: "fog", backgroundColor: "#101418", environmentIntensity: 0.5 } });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.command).toMatchObject({ patch: { weather: "fog", backgroundColor: "#101418", environmentIntensity: 0.5 } });
    }
    expect(validateSceneCommand({ id: "e2", type: "environment.set", sceneId: "s", patch: { weather: "sandstorm" } }).valid).toBe(false);
    expect(validateSceneCommand({ id: "e3", type: "environment.set", sceneId: "s", patch: {} }).valid).toBe(false);
  });

  it("场景不匹配与 capability:lighting/environment 走 studio.scene", () => {
    expect(validateSceneCommand({ id: "l5", type: "lighting.set", sceneId: "wrong", patch: { enabled: true } }).valid).toBe(true); // 校验层不管场景匹配
    expect(prepareSceneCommandTransaction({
      id: "tx-l", sceneId: "s", baseRevision: 0,
      module: { id: "m", capabilities: ["studio.object"], permissions: ["scene.write"] },
      commands: [{ id: "l6", type: "lighting.set", sceneId: "s", patch: { enabled: true } }],
    }).status).toBe("rejected");
    const prepared = prepareSceneCommandTransaction({
      id: "tx-l2", sceneId: "s", baseRevision: 0,
      module: { id: "m", capabilities: ["studio.scene"], permissions: ["scene.write"] },
      commands: [{ id: "l7", type: "lighting.set", sceneId: "s", patch: { enabled: true } }, { id: "e4", type: "environment.set", sceneId: "s", patch: { weather: "rain" } }],
    });
    expect(prepared.status).toBe("prepared");
    if (prepared.status === "prepared") {
      expect(prepared.plan.requiredCapabilities).toEqual(["studio.scene"]);
      expect(prepared.plan.diff.map(d => d.type)).toEqual(["lighting.set", "environment.set"]);
    }
  });
});

describe("H-C7-P3 命令面:animation.set-anchor(状态机锚迁移)", () => {
  it("合法锚解析:仅 initialStateId / 仅 activeStateId / 双锚", () => {
    const initialOnly = validateSceneCommand({ id: "a1", type: "animation.set-anchor", sceneId: "s", anchor: { initialStateId: "idle" } });
    expect(initialOnly.valid).toBe(true);
    if (initialOnly.valid) {
      expect(initialOnly.command).toMatchObject({ type: "animation.set-anchor", sceneId: "s", anchor: { initialStateId: "idle" } });
    }
    const activeOnly = validateSceneCommand({ id: "a2", type: "animation.set-anchor", sceneId: "s", anchor: { activeStateId: "work" } });
    expect(activeOnly.valid).toBe(true);
    if (activeOnly.valid) {
      expect(activeOnly.command).toMatchObject({ anchor: { activeStateId: "work" } });
    }
    const both = validateSceneCommand({ id: "a3", type: "animation.set-anchor", sceneId: "s", anchor: { initialStateId: "idle", activeStateId: "work" } });
    expect(both.valid).toBe(true);
    if (both.valid) {
      expect(both.command).toMatchObject({ anchor: { initialStateId: "idle", activeStateId: "work" } });
    }
  });

  it("非法锚拒绝:空 anchor / 空串 id / 未知字段 / 非串 id / 缺 sceneId", () => {
    expect(validateSceneCommand({ id: "a4", type: "animation.set-anchor", sceneId: "s", anchor: {} }).valid).toBe(false);
    expect(validateSceneCommand({ id: "a5", type: "animation.set-anchor", sceneId: "s", anchor: { initialStateId: "" } }).valid).toBe(false);
    expect(validateSceneCommand({ id: "a6", type: "animation.set-anchor", sceneId: "s", anchor: { unknownField: "x" } }).valid).toBe(false);
    expect(validateSceneCommand({ id: "a7", type: "animation.set-anchor", sceneId: "s", anchor: { initialStateId: 3 } }).valid).toBe(false);
    expect(validateSceneCommand({ id: "a8", type: "animation.set-anchor", anchor: { activeStateId: "work" } }).valid).toBe(false);
  });

  it("capability 走 studio.animation,场景不匹配拒绝", () => {
    expect(prepareSceneCommandTransaction({
      id: "tx-a1", sceneId: "s", baseRevision: 0,
      module: { id: "m", capabilities: ["studio.object"], permissions: ["scene.write"] },
      commands: [{ id: "a9", type: "animation.set-anchor", sceneId: "s", anchor: { initialStateId: "idle" } }],
    }).status).toBe("rejected");
    const prepared = prepareSceneCommandTransaction({
      id: "tx-a2", sceneId: "s", baseRevision: 0,
      module: { id: "m", capabilities: ["studio.animation"], permissions: ["scene.write"] },
      commands: [{ id: "a10", type: "animation.set-anchor", sceneId: "s", anchor: { initialStateId: "idle" } }],
    });
    expect(prepared.status).toBe("prepared");
    if (prepared.status === "prepared") {
      expect(prepared.plan.requiredCapabilities).toEqual(["studio.animation"]);
    }
    expect(validateSceneCommand({ id: "a11", type: "animation.set-anchor", sceneId: "wrong", anchor: { initialStateId: "idle" } }).valid).toBe(true); // 校验层不管场景匹配
  });
});
