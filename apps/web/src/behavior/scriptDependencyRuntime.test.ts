import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplicationScriptDependency } from "@bim-studio/contracts";
import { clearScriptDependencyRuntimeCache, loadScriptDependencyModules } from "./scriptDependencyRuntime";

describe("loadScriptDependencyModules", () => {
  beforeEach(() => clearScriptDependencyRuntimeCache());

  it("读取项目内缓存依赖并转换为 Worker 模块", async () => {
    const read = vi.fn(async () => "export const value = 1;");
    const dependency = fixture();

    const first = await loadScriptDependencyModules("project-1", [dependency], read);
    const second = await loadScriptDependencyModules("project-1", [dependency], read);

    expect(first).toEqual([{ specifier: "@plant/math", code: "export const value = 1;", integrity: dependency.integrity }]);
    expect(second).toEqual(first);
    expect(read).toHaveBeenCalledOnce();
  });

  it("哈希变化后重新读取，不复用旧版本", async () => {
    const read = vi.fn(async () => `export const revision = ${read.mock.calls.length};`);
    const dependency = fixture();
    await loadScriptDependencyModules("project-1", [dependency], read);
    await loadScriptDependencyModules("project-1", [{ ...dependency, integrity: "sha256-updated=" }], read);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("拒绝空的项目依赖", async () => {
    await expect(loadScriptDependencyModules("project-1", [fixture()], async () => "  ")).rejects.toThrow("内容为空");
  });
});

function fixture(): ApplicationScriptDependency {
  return {
    id: "dependency-1",
    specifier: "@plant/math",
    source: "upload",
    requested: "plant-math.js",
    fileName: "index.mjs",
    assetUrl: "/api/projects/project-1/script-dependencies/dependency-1/content",
    integrity: "sha256-test=",
    size: 23,
    installedAt: "2026-09-04T00:00:00.000Z",
  };
}
