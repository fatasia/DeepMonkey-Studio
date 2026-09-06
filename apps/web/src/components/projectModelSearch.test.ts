import { describe, expect, it } from "vitest";
import type { ModelRecord } from "@bim-studio/contracts";
import { projectModelMatchesSearch } from "./projectModelSearch";

describe("project model search", () => {
  const robot = { name: "一号机械臂", format: "zip", manifest: { sourceName: "original.zip", robot: { name: "test_arm", entryPath: "pkg/urdf/arm.urdf" } } } as ModelRecord;
  it.each(["", "ZIP", ".zip", "URDF", "机器人", "robot", "test_arm", "pkg/urdf", "机械臂 zip", "ＺＩＰ"]) ("finds renamed robot metadata by %s", query => {
    expect(projectModelMatchesSearch(robot, query)).toBe(true);
  });
  it("keeps ordinary name/format search without labeling all meshes as robots", () => {
    const model = { name: "Pump station", format: "glb" } as ModelRecord;
    expect(projectModelMatchesSearch(model, "pump GLB")).toBe(true);
    expect(projectModelMatchesSearch(model, "robot")).toBe(false);
    expect(projectModelMatchesSearch(robot, "stl")).toBe(false);
  });
});
