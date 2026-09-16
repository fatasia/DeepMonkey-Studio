import { describe, expect, it } from "vitest";
import {
  SCENE_API_VERSION as CONTRACT_VERSION,
  SCENE_CAPABILITIES as CONTRACT_CAPABILITIES,
  SCENE_PERMISSIONS as CONTRACT_PERMISSIONS,
  resolveSceneScriptProtocolCompatibility,
  type ScriptModule,
} from "@bim-studio/contracts";
import { SCENE_API_VERSION, SCENE_CAPABILITIES, SCENE_PERMISSIONS } from "./protocol.js";
import { resolveSceneBehaviorModule } from "./scriptModuleAdapter.js";

function script(): ScriptModule {
  return { id: "worker", name: "Worker", enabled: true, runtime: "worker-sandbox", apiVersion: "1.0",
    entrypoint: "behavior", code: "opaqueCode()", lifecycle: [], capabilities: ["studio.scene"], permissions: ["scene.read"] };
}

describe("persisted script protocol and SDK adapter", () => {
  it("retains the SDK exports as the exact shared contract definitions", () => {
    expect(SCENE_API_VERSION).toBe(CONTRACT_VERSION);
    expect(SCENE_CAPABILITIES).toBe(CONTRACT_CAPABILITIES);
    expect(SCENE_PERMISSIONS).toBe(CONTRACT_PERMISSIONS);
  });

  it.each([
    ["disabled", { enabled: false }, "skipped", "脚本已禁用"],
    ["legacy", { runtime: "legacy-trusted-main-thread" }, "skipped", "旧版可信脚本"],
    ["future version", { apiVersion: "2.0" }, "rejected", "不支持 Scene API 2.0"],
    ["unknown capability", { capabilities: ["studio.unknown"] }, "rejected", "未知能力"],
    ["unknown permission", { permissions: ["unknown.read"] }, "rejected", "未知权限"],
  ] as const)("rejects or skips %s identically before module assembly", (_, patch, status, message) => {
    // 持久化的未来协议字段可能早于当前 TypeScript 合同到达运行边界。
    const input = { ...script(), ...patch } as ScriptModule;
    const expected = resolveSceneScriptProtocolCompatibility(input);
    expect(expected).toMatchObject({ status, message: expect.stringContaining(message) });
    expect(resolveSceneBehaviorModule(input)).toEqual(expected);
  });

  it("assembles an isolated ready module without changing the persisted script", () => {
    const input = script();
    expect(resolveSceneScriptProtocolCompatibility(input)).toEqual({ status: "ready" });
    const result = resolveSceneBehaviorModule(input);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("Expected ready module");
    result.module.capabilities.push("studio.camera");
    result.module.permissions.push("scene.write");
    expect(input.capabilities).toEqual(["studio.scene"]);
    expect(input.permissions).toEqual(["scene.read"]);
  });
});
