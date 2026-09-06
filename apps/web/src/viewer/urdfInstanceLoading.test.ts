import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelManifest } from "@bim-studio/contracts";
import { loadUrdfModel } from "./urdfModelLoader";
import { modelInstanceHarness, manifest, deferred } from "./modelInstanceEngineTestFixture";
import { robotDefinition, robotPoseFixture } from "./robotPoseTestFixture";
import { readRobotPose, writeRobotPose } from "./robotPoseRuntime";

vi.mock("./urdfModelLoader", () => ({ loadUrdfModel: vi.fn() }));
beforeEach(() => vi.mocked(loadUrdfModel).mockReset());
function robotManifest(): ModelManifest { return { ...manifest(), sourceFormat: "urdf", viewerKind: "urdf", robot: robotDefinition() }; }
function harness() {
  const result = modelInstanceHarness(), old = robotPoseFixture();
  result.original.object.removeFromParent(); result.original.object = old.object; result.modelRoot.add(old.object);
  writeRobotPose(old.object, { hinge: .35, turn: 7, slide: .12 }, true);
  const apply = result.applyModelState.getMockImplementation()!;
  result.applyModelState.mockImplementation((id, state) => { apply(id, state); writeRobotPose(result.models.get(id)?.object, state.robotPose ?? {}, true, true); });
  return { ...result, old };
}

describe("URDF loading uses stable instance and replacement transaction contracts", () => {
  it("loads same resource as two independent objects and does not fit alias copies", async () => {
    const test = modelInstanceHarness();
    vi.mocked(loadUrdfModel).mockImplementation(async () => robotPoseFixture().object);
    const one = await test.engine.loadManifest(robotManifest(), "one"), two = await test.engine.loadManifest(robotManifest(), "two");
    test.engine.setRobotPose("one", { hinge: .8 });
    expect(one.object).not.toBe(two.object); expect(one.assetModelId).toBe("asset-new"); expect(two.assetModelId).toBe("asset-new");
    expect(test.engine.getRobotPose("two")?.hinge).toBe(0); expect(test.fitAll).not.toHaveBeenCalled();
  });
  it("replaces visuals while preserving authored pose and stable instance identity", async () => {
    const test = harness(), candidate = robotPoseFixture(); vi.mocked(loadUrdfModel).mockResolvedValue(candidate.object);
    const next = await test.engine.replaceModelManifest("instance", robotManifest());
    expect(next.id).toBe("instance"); expect(next.assetModelId).toBe("asset-new");
    expect(readRobotPose(next.object)).toEqual({ hinge: .35, turn: 7, slide: .12 });
  });
  it("rejects joint semantics even if Three.js child names and types match", async () => {
    const test = harness(), definition = robotDefinition(); definition.joints[1]!.axis = { x: 1, y: 0, z: 0 };
    const candidate = robotPoseFixture(definition); vi.mocked(loadUrdfModel).mockResolvedValue(candidate.object);
    await expect(test.engine.replaceModelManifest("instance", robotManifest())).rejects.toThrow("关节结构");
    expect(test.models.get("instance")?.object).toBe(test.old.object); expect(readRobotPose(test.old.object)?.hinge).toBe(.35);
  });
  it("restores both authored state and live telemetry after candidate apply failure", async () => {
    const test = harness(), candidate = robotPoseFixture(); vi.mocked(loadUrdfModel).mockResolvedValue(candidate.object);
    writeRobotPose(test.old.object, { hinge: -.65 }, false);
    const apply = test.applyModelState.getMockImplementation()!;
    test.applyModelState.mockImplementationOnce((id, state) => { apply(id, state); throw new Error("candidate state failure"); });
    await expect(test.engine.replaceModelManifest("instance", robotManifest())).rejects.toThrow("原实例已恢复");
    expect(test.models.get("instance")?.object).toBe(test.old.object);
    expect(test.old.robot.joints.hinge!.angle).toBe(-.65); expect(readRobotPose(test.old.object)?.hinge).toBe(.35);
    expect(test.disposeObject).not.toHaveBeenCalledWith(test.old.object);
  });
  it("disposes late candidates and preserves original object on network failure", async () => {
    const test = harness(); vi.mocked(loadUrdfModel).mockRejectedValueOnce(new Error("503"));
    await expect(test.engine.replaceModelManifest("instance", robotManifest())).rejects.toThrow("503");
    expect(test.models.get("instance")?.object).toBe(test.old.object);
    const wait = deferred<ReturnType<typeof robotPoseFixture>["object"]>(), candidate = robotPoseFixture();
    vi.mocked(loadUrdfModel).mockReturnValueOnce(wait.promise);
    const pending = test.engine.replaceModelManifest("instance", robotManifest()); await Promise.resolve(); test.modelLoads.invalidate(); wait.resolve(candidate.object);
    await expect(pending).rejects.toThrow(); expect(test.disposeObject).toHaveBeenCalledWith(candidate.object);
    expect(test.models.get("instance")?.object).toBe(test.old.object);
  });
});
