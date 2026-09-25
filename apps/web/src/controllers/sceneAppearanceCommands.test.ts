import { describe, expect, it, vi } from "vitest";
import { applyGroupedOrSelected } from "./sceneAppearanceDispatch";
import { createSceneAppearanceCommands, mergeScenePhysicsBodyPatch } from "./sceneAppearanceCommands";
import type { SceneEditorControllerContext } from "./sceneEditorControllerContext";

describe("场景外观命令分派", () => {
  it("uses the current selection for a single object", () => {
    const applyObject = vi.fn();
    const applySelection = vi.fn();
    applyGroupedOrSelected(
      [],
      vi.fn(() => false),
      applyObject,
      applySelection,
    );

    expect(applySelection).toHaveBeenCalledOnce();
    expect(applyObject).not.toHaveBeenCalled();
  });

  it("updates only unlocked objects in a group", () => {
    const applyObject = vi.fn();
    const applySelection = vi.fn();
    applyGroupedOrSelected(["a", "b", "c"], (id) => id === "b", applyObject, applySelection);

    expect(applyObject.mock.calls).toEqual([["a"], ["c"]]);
    expect(applySelection).not.toHaveBeenCalled();
  });
});

describe("场景对象物理补丁", () => {
  const character = {
    offset: 0.02,
    maxSlopeClimbAngle: Math.PI / 4,
    autostep: { enabled: true, maxHeight: 0.25, minWidth: 0.18, includeDynamicBodies: false },
    snapToGround: { enabled: true, distance: 0.2 },
  };
  const kinematic = { type: "kinematic" as const, mass: 1, friction: 0.6, restitution: 0.05, character };

  it("removes character settings when changing away from kinematic", () => {
    const next = mergeScenePhysicsBodyPatch(kinematic, { type: "dynamic" });
    expect(next.type).toBe("dynamic");
    expect(next).not.toHaveProperty("character");
  });

  it("supports explicitly disabling the controller and retains it for kinematic parameter edits", () => {
    expect(mergeScenePhysicsBodyPatch(kinematic, { character: undefined })).not.toHaveProperty("character");
    expect(mergeScenePhysicsBodyPatch(kinematic, { mass: 2 }).character).toEqual(character);
    expect(mergeScenePhysicsBodyPatch(kinematic, { character: { ...character, offset: 0.04 } }).character?.offset).toBe(0.04);
  });

  it("sends controller changes through the engine and existing scene-edit save chain", async () => {
    const setPhysicsBodyState = vi.fn().mockResolvedValue(undefined);
    const recordSceneEdit = vi.fn();
    const context = {
      engine: { setPhysicsBodyState },
      selected: { id: "equipment" },
      selectedPhysics: kinematic,
      setRevision: vi.fn(),
      setMessage: vi.fn(),
      showError: vi.fn(),
      recordSceneEdit,
    } as unknown as SceneEditorControllerContext;
    const commands = createSceneAppearanceCommands(context, vi.fn());

    const updatedCharacter = { ...character, offset: 0.04 };
    commands.changeSelectedPhysics({ character: updatedCharacter });
    await vi.waitFor(() => expect(recordSceneEdit).toHaveBeenCalledOnce());
    expect(setPhysicsBodyState).toHaveBeenNthCalledWith(1, "equipment", { ...kinematic, character: updatedCharacter });

    commands.changeSelectedPhysics({ character: undefined });
    await vi.waitFor(() => expect(recordSceneEdit).toHaveBeenCalledTimes(2));
    expect(setPhysicsBodyState).toHaveBeenNthCalledWith(2, "equipment", {
      type: "kinematic", mass: 1, friction: 0.6, restitution: 0.05,
    });
  });
});

describe("选中显隐收编(批 2:SetVisibility selection 模式)", () => {
  it("单选:经命令总线转交 engine.setSelectionVisible,参数与直调一致,revision 推进一次", () => {
    const calls: string[] = [];
    const setRevision = vi.fn();
    const setSceneObjectsVisible = vi.fn();
    const commands = createSceneAppearanceCommands({
      engine: { setSelectionVisible: (visible: boolean) => calls.push(`setSelectionVisible:${visible}`) },
      locale: "zh-CN",
      selected: { id: "m1" },
      selectedLayerId: undefined,
      sceneOrganizationSelection: new Set<string>(),
      setRevision,
    } as unknown as SceneEditorControllerContext, setSceneObjectsVisible);

    // 直调参照(收编前实现):engine.setSelectionVisible(false)
    commands.updateSelectionVisibility(false);

    expect(calls).toEqual(["setSelectionVisible:false"]);
    expect(setRevision).toHaveBeenCalledOnce();
    expect(setSceneObjectsVisible).not.toHaveBeenCalled();
  });

  it("编组多选:仍整批委托 setSceneObjectsVisible(组织命令链路,本批不改动其语义)", () => {
    const setRevision = vi.fn();
    const setSceneObjectsVisible = vi.fn();
    const commands = createSceneAppearanceCommands({
      engine: { setSelectionVisible: vi.fn() },
      locale: "zh-CN",
      selected: { id: "m1" },
      selectedLayerId: undefined,
      sceneOrganizationSelection: new Set(["m1", "m2"]),
      setRevision,
    } as unknown as SceneEditorControllerContext, setSceneObjectsVisible);

    commands.updateSelectionVisibility(true);

    expect(setSceneObjectsVisible).toHaveBeenCalledWith(["m1", "m2"], true);
    expect(setRevision).not.toHaveBeenCalled();
  });
});
