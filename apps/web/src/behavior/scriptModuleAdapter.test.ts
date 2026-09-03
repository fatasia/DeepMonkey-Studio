import type { ScriptModule } from "@bim-studio/contracts";
import { describe, expect, it } from "vitest";
import { resolveSceneBehaviorModule } from "./scriptModuleAdapter";

describe("resolveSceneBehaviorModule", () => {
  it("creates a detached SDK behavior module for enabled worker scripts", () => {
    const source = { ...script(), target: { kind: "object" as const, id: "agv-01" } };
    const result = resolveSceneBehaviorModule(source);
    expect(result).toMatchObject({ status: "ready", module: { id: "behavior:agv", lifecycle: ["onUpdate"], target: { kind: "object", id: "agv-01" } } });
    if (result.status === "ready") {
      expect(result.module.lifecycle).not.toBe(source.lifecycle);
      expect(result.module.target).not.toBe(source.target);
    }
  });

  it("copies readonly dependency inputs into a detached mutable SDK array", () => {
    const dependencies = [{ specifier: "dayjs", code: "export default {};", integrity: "sha256-test" }] as const;
    const result = resolveSceneBehaviorModule(script(), dependencies);

    expect(result).toMatchObject({ status: "ready", module: { dependencies } });
    if (result.status === "ready") {
      expect(result.module.dependencies).not.toBe(dependencies);
      expect(result.module.dependencies?.[0]).not.toBe(dependencies[0]);
    }
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
