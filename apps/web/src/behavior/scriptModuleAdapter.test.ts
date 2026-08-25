import type { ScriptModule } from "@bim-studio/contracts";
import { describe, expect, it } from "vitest";
import { resolveSceneBehaviorModule } from "./scriptModuleAdapter";

describe("resolveSceneBehaviorModule", () => {
  it("creates a detached SDK behavior module for enabled worker scripts", () => {
    const source = script();
    const result = resolveSceneBehaviorModule(source);
    expect(result).toMatchObject({ status: "ready", module: { id: "behavior:agv", lifecycle: ["onUpdate"] } });
    if (result.status === "ready") expect(result.module.lifecycle).not.toBe(source.lifecycle);
  });

  it("skips disabled and legacy scripts without silently trusting them", () => {
    expect(resolveSceneBehaviorModule({ ...script(), enabled: false })).toMatchObject({ status: "skipped", message: expect.stringContaining("禁用") });
    expect(resolveSceneBehaviorModule({ ...script(), runtime: "legacy-trusted-main-thread" })).toMatchObject({ status: "skipped", message: expect.stringContaining("不会自动") });
  });

  it("rejects capabilities that are not part of the public Scene SDK", () => {
    expect(resolveSceneBehaviorModule({ ...script(), capabilities: ["viewer.private"] })).toMatchObject({ status: "rejected", message: expect.stringContaining("viewer.private") });
  });
});

function script(): ScriptModule {
  return {
    id: "behavior:agv",
    name: "AGV 运动",
    enabled: true,
    apiVersion: "1.0",
    entrypoint: "behavior",
    runtime: "worker-sandbox",
    code: "function onUpdate(ctx) {}",
    lifecycle: ["onUpdate"],
    capabilities: ["studio.runtime"],
    permissions: ["scene.write"]
  };
}
