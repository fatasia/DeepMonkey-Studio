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

  it("keeps initial velocity on dynamic bodies and clears it when their type changes", () => {
    const velocity = { x: 80, y: 0, z: 0 };
    const dynamic = mergeScenePhysicsBodyPatch({ type: "dynamic", mass: 1, friction: 0.5, restitution: 0 }, { initialLinearVelocity: velocity });
    expect(dynamic.initialLinearVelocity).toEqual(velocity);
    expect(mergeScenePhysicsBodyPatch(dynamic, { type: "fixed" })).not.toHaveProperty("initialLinearVelocity");
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

describe("材质预设命令(编辑器刀 5)", () => {
  const stainless = { color: "#c8c8c8", metalness: 1, roughness: 0.22 };

  function presetContext(extra: Record<string, unknown> = {}) {
    const engine = { setSelectionMaterial: vi.fn(), setModelMaterial: vi.fn(), listModels: () => [] };
    const recordSceneEdit = vi.fn();
    const setUserMaterialPresets = vi.fn();
    const context = {
      engine,
      selected: { id: "part-a" },
      selectedLayerId: undefined,
      sceneOrganizationSelection: new Set<string>(),
      setRevision: vi.fn(),
      setMessage: vi.fn(),
      showError: vi.fn(),
      recordSceneEdit,
      userMaterialPresets: [] as unknown[],
      setUserMaterialPresets,
      ...extra,
    } as unknown as SceneEditorControllerContext;
    return { engine, recordSceneEdit, setUserMaterialPresets, showError: context.showError as ReturnType<typeof vi.fn>, commands: createSceneAppearanceCommands(context, vi.fn()) };
  }

  it("套用预设展开为全量外观 patch 并走既有材质命令 + 撤销记录", () => {
    const { engine, recordSceneEdit, commands } = presetContext();
    commands.materialPresetActions.applyMaterialPreset(stainless, "不锈钢");
    expect(engine.setSelectionMaterial).toHaveBeenCalledExactlyOnceWith({
      color: "#c8c8c8", metalness: 1, roughness: 0.22,
      emissive: "#000000", emissiveIntensity: 0,
      transmission: 0, thickness: 0,
      clearcoat: 0, clearcoatRoughness: 0,
      sheen: 0, sheenRoughness: 1, iridescence: 0,
    });
    expect(recordSceneEdit).toHaveBeenCalledOnce();
    expect(String(recordSceneEdit.mock.calls[0]![0])).toContain("套用材质预设");
  });

  it("套用玻璃预设保留透射域且不发 undefined 键", () => {
    const { engine, commands } = presetContext();
    commands.materialPresetActions.applyMaterialPreset(
      { color: "#e6eef0", metalness: 0, roughness: 0.6, transmission: 0.85, thickness: 0.5, ior: 1.52 }, "磨砂玻璃");
    const patch = engine.setSelectionMaterial.mock.calls[0]![0] as Record<string, unknown>;
    expect(patch.transmission).toBe(0.85);
    expect(patch.thickness).toBe(0.5);
    expect(patch.ior).toBe(1.52);
    for (const [key, value] of Object.entries(patch)) expect(value, key).not.toBeUndefined();
  });

  it("存为预设:合法参数入库,越界参数拒绝且不入库", () => {
    const good = presetContext();
    const saved = good.commands.materialPresetActions.saveUserMaterialPreset("我的涂层", stainless);
    expect(saved).toMatchObject({ name: "我的涂层", values: stainless });
    expect(String(saved!.id)).toMatch(/^matpreset:/);
    expect(good.setUserMaterialPresets).toHaveBeenCalledOnce();

    const bad = presetContext();
    expect(bad.commands.materialPresetActions.saveUserMaterialPreset("坏预设", { ...stainless, metalness: 2 })).toBeUndefined();
    expect(bad.setUserMaterialPresets).not.toHaveBeenCalled();
    expect(bad.showError).toHaveBeenCalledOnce();
  });

  it("存为预设:空名称不入库", () => {
    const h = presetContext();
    expect(h.commands.materialPresetActions.saveUserMaterialPreset("   ", stainless)).toBeUndefined();
    expect(h.setUserMaterialPresets).not.toHaveBeenCalled();
  });

  it("删除预设按 id 移除;未知 id 为空操作", () => {
    const existing = { id: "matpreset:x", name: "x", createdAt: "t", updatedAt: "t", values: stainless };
    const h = presetContext({ userMaterialPresets: [existing] });
    h.commands.materialPresetActions.deleteUserMaterialPreset("matpreset:x");
    expect(h.setUserMaterialPresets).toHaveBeenCalledExactlyOnceWith(expect.any(Function));
    const updater = h.setUserMaterialPresets.mock.calls[0]![0] as (current: unknown[]) => unknown[];
    expect(updater([existing, { id: "matpreset:y" }])).toEqual([{ id: "matpreset:y" }]);

    const quiet = presetContext({ userMaterialPresets: [existing] });
    quiet.commands.materialPresetActions.deleteUserMaterialPreset("matpreset:missing");
    expect(quiet.setUserMaterialPresets).not.toHaveBeenCalled();
  });
});
