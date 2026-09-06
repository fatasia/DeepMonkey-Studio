import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import { robotImportEntries, selectRobotImports } from "./robotImportSelection";

async function pack(...paths: string[]) {
  const zip = new JSZip();
  for (const path of paths) zip.file(path, "<robot/>");
  return new File([await zip.generateAsync({ type: "arraybuffer" })], "robot.zip");
}

describe("robot import entry selection", () => {
  it("keeps ordinary model uploads unchanged and automatically selects a unique URDF", async () => {
    const glb = new File([], "model.glb");
    const urdf = new File([], "robot.urdf");
    const zip = await pack("robot/meshes/body.stl", "robot/arm.URDF");
    const choose = vi.fn();
    expect(await robotImportEntries(glb)).toBeUndefined();
    const selected = await selectRobotImports([glb, urdf, zip], choose);
    expect(selected?.get(urdf)).toBe("robot.urdf");
    expect(selected?.get(zip)).toBe("robot/arm.URDF");
    expect(choose).not.toHaveBeenCalled();
  });
  it("requires an explicit choice for multiple URDF files and cancels the whole batch", async () => {
    const zip = await pack("a.urdf", "b.urdf");
    expect((await selectRobotImports([zip], async () => "b.urdf"))?.get(zip)).toBe("b.urdf");
    expect(await selectRobotImports([zip], async () => undefined)).toBeUndefined();
    await expect(selectRobotImports([zip], async () => "missing.urdf")).rejects.toThrow("包内");
  });
  it("rejects stale selection before submitting and reports empty/broken packages", async () => {
    const zip = await pack("a.urdf", "b.urdf");
    let valid = true;
    await expect(selectRobotImports([zip], async () => { valid = false; return "a.urdf"; }, () => { if (!valid) throw new Error("stale"); })).rejects.toThrow("stale");
    await expect(robotImportEntries(await pack("README.md"))).rejects.toThrow("没有 URDF");
    await expect(robotImportEntries(new File(["bad"], "bad.zip"))).rejects.toThrow();
  });
});
