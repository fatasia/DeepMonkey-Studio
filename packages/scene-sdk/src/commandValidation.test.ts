import { describe, expect, it } from "vitest";
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
  }
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
    [{ id: "x", type: "selection.set", targets: [{ kind: "object", sceneId: "scene:1" }] }, "$.targets[0].objectId", "missing-property"],
    [{ id: "x", type: "camera.set", sceneId: "scene:1", position: [0, 0, 0], target: [0, 0, 0], near: 10, far: 1 }, "$.far", "invalid-value"],
    [{ id: "x", type: "camera.set", sceneId: "scene:1", position: [0, 0, 0], target: [0, 0, 0], fov: 180 }, "$.fov", "invalid-value"],
    [{ id: "x", type: "camera.fly-to", sceneId: "scene:1", target: objectTarget, durationMs: -1 }, "$.durationMs", "invalid-value"],
    [{ id: "x", type: "animation.control", target: objectTarget, action: "rewind" }, "$.action", "invalid-value"],
    [{ id: "x", type: "animation.control", target: objectTarget, action: "seek", time: -0.1 }, "$.time", "invalid-value"],
    [{ id: "x", type: "selection.set", targets: [], debug: true }, "$.debug", "unknown-property"],
    [{ id: "x", type: "data.apply", target: objectTarget, values: { bad: Number.POSITIVE_INFINITY }, timestamp: "now" }, "$.values.bad", "invalid-value"]
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
