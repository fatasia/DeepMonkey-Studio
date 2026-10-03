import { describe, expect, it } from "vitest";
import { validateSceneCommand } from "./commandValidation.js";
import { prepareSceneCommandTransaction } from "./sceneCommandTransaction.js";
import type { SceneCommandTransactionRequest } from "./sceneCommandTransaction.js";

const target = { kind: "object", sceneId: "scene", objectId: "box" } as const;
const source = "shader deep.material { surface standard; }";
const command = (customShader: unknown) => ({ id: "shader", type: "material.set", target, patch: { customShader } });

describe("material source command", () => {
  it("accepts a detached bounded source and keeps its exact whitespace", () => {
    const input = command({ source: `  ${source}\n` });
    const result = validateSceneCommand(input);
    expect(result.valid).toBe(true);
    if (result.valid && result.command.type === "material.set") {
      expect(result.command.patch.customShader).toEqual(input.patch.customShader);
      expect(result.command.patch.customShader).not.toBe(input.patch.customShader);
    }
  });

  it.each([null, false, { source: 2 }, { source: "" }, { source: "  " }, { source, debug: true }, { source: "中".repeat(11_000) }])("rejects malformed or oversized source %#", (value) => {
    expect(validateSceneCommand(command(value)).valid).toBe(false);
  });

  it("does not execute a nested source accessor", () => {
    let calls = 0;
    expect(validateSceneCommand(command({ get source() { calls += 1; return source; } })).valid).toBe(false);
    expect(calls).toBe(0);
  });

  it("rejects prototype keys and reflection errors without executing them", () => {
    const unsafe = JSON.parse(`{"source":${JSON.stringify(source)},"__proto__":{}}`);
    expect(validateSceneCommand(command(unsafe)).valid).toBe(false);
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    expect(() => validateSceneCommand(command(revoked.proxy))).not.toThrow();
    expect(validateSceneCommand(command(revoked.proxy)).valid).toBe(false);
  });

  it("keeps material/object capability and scene-scoped authorization", () => {
    const request: SceneCommandTransactionRequest = { id: "source-tx", sceneId: "scene", baseRevision: 0,
      module: { id: "script", capabilities: ["studio.material", "studio.object"], permissions: ["scene.write"] },
      commands: [command({ source })] };
    const prepared = prepareSceneCommandTransaction(request);
    expect(prepared.status).toBe("prepared");
    expect(prepareSceneCommandTransaction({ ...request, module: { ...request.module, capabilities: ["studio.object"] } }))
      .toMatchObject({ status: "rejected", issues: [expect.objectContaining({ reason: "capability-denied" })] });
    expect(prepareSceneCommandTransaction({ ...request, module: { ...request.module, permissions: [] } }))
      .toMatchObject({ status: "rejected", issues: [expect.objectContaining({ reason: "permission-denied" })] });
    expect(prepareSceneCommandTransaction({ ...request, sceneId: "other" }))
      .toMatchObject({ status: "rejected", issues: [expect.objectContaining({ reason: "scene-mismatch" })] });
  });
});
