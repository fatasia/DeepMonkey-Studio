import { describe, expect, it, vi } from "vitest";
import { prepareSceneCommandTransaction, validateSceneCommand } from "./index.js";

const command = { id: "create", type: "object.create-primitive", target: { kind: "object", sceneId: "s", objectId: "new" }, name: "设备", kind: "box", color: "#1683ff" };
const request = (commands: unknown[], overrides: object = {}) => ({ id: "tx", sceneId: "s", baseRevision: 0,
  module: { id: "author", capabilities: ["studio.object" as const], permissions: ["scene.write" as const] }, commands, ...overrides });

describe("primitive creation command", () => {
  it.each(["box", "sphere", "cylinder", "cone", "torus", "plane", "capsule"])("accepts existing %s kind and detaches target", kind => {
    const input = { ...command, kind, target: { ...command.target } };
    const result = validateSceneCommand(input);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    input.target.objectId = "changed";
    expect("target" in result.command && result.command.target).toEqual(command.target);
  });
  it.each([{ kind: "custom" }, { color: "red" }, { color: "#fff" }, { name: " " }, { name: undefined },
    { target: { kind: "scene", sceneId: "s" } }, { position: [1, 2, 3] }])("rejects unsupported or malformed fields %j", patch => {
    expect(validateSceneCommand({ ...command, ...patch }).valid).toBe(false);
  });
  it("never evaluates accessors", () => {
    const getter = vi.fn(() => "box");
    const input = { ...command };
    Object.defineProperty(input, "kind", { get: getter, enumerable: true });
    expect(validateSceneCommand(input).valid).toBe(false); expect(getter).not.toHaveBeenCalled();
  });
  it("uses existing scope and studio.object permission gates", () => {
    const accepted = prepareSceneCommandTransaction(request([command]));
    expect(accepted.status).toBe("prepared");
    if (accepted.status === "prepared") {
      expect(accepted.plan.requiredCapabilities).toEqual(["studio.object"]);
      expect(accepted.plan.diff[0]!.target).toBe("object:new");
    }
    for (const module of [{ id: "a", capabilities: [], permissions: ["scene.write"] }, { id: "a", capabilities: ["studio.object"], permissions: [] }]) {
      expect(prepareSceneCommandTransaction(request([command], { module })).status).toBe("rejected");
    }
    const mismatch = prepareSceneCommandTransaction(request([{ ...command, target: { ...command.target, sceneId: "other" } }]));
    expect(mismatch.status).toBe("rejected");
    if (mismatch.status === "rejected") expect(mismatch.issues[0]!.reason).toBe("scene-mismatch");
  });
});
