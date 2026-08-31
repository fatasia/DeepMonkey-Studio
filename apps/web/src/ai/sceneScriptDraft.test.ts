import type { ScriptModule } from "@bim-studio/contracts";
import { describe, expect, it } from "vitest";
import type { SceneScriptIntelligenceContext, SceneScriptTarget } from "../studio/sceneScriptContext";
import { createAiSceneScriptDraft } from "./sceneScriptDraft";

const robot: SceneScriptTarget = { id: "robot-1", name: "搬运机器人", kind: "object", context: "装配线" };
const widget: SceneScriptTarget = { id: "status-card", name: "状态卡片", kind: "component", context: "总览" };
const unity: SceneScriptTarget = { id: "unity-line", name: "Unity 产线", kind: "component", runtime: "unity", context: "总览" };
const intelligence: SceneScriptIntelligenceContext = {
  targets: [robot, widget, unity],
  references: [{ id: "scene-1", name: "装配线", kind: "scene", context: "装配线" }],
  dataKeys: ["robot.temperature", "robot.speed"],
  eventNames: ["click", "alarm"],
};

describe("createAiSceneScriptDraft", () => {
  it("compiles multiple object actions through the script analyzer and command policy", () => {
    const result = createAiSceneScriptDraft({
      intent: "定位搬运机器人并播放动画",
      sceneId: "scene-1",
      target: robot,
      intelligence,
    });

    expect(result.evidenceFingerprint).toMatch(/^fnv1a64-canonical-v1:[a-f0-9]{16}$/);
    expect(result.status).toBe("ready");
    expect(result.requiresConfirmation).toBe(true);
    expect(result.actionLabels).toEqual(["定位对象", "播放动画"]);
    expect(result.commandTypes).toEqual(["camera.fly-to", "animation.control"]);
    expect(result.draftScript).toMatchObject({ enabled: false, runtime: "worker-sandbox" });
    expect(result.draftScript?.capabilities).toEqual(expect.arrayContaining(["studio.object", "studio.camera", "studio.animation"]));
    expect(result.analysis?.issues.filter((item) => item.severity === "error")).toEqual([]);
  });

  it("creates a data-triggered draft only for a real project data key", () => {
    const result = createAiSceneScriptDraft({
      intent: "当 robot.temperature > 80 时颜色改为 #ef4444",
      sceneId: "scene-1",
      target: robot,
      intelligence,
    });

    expect(result.status).toBe("ready");
    expect(result.lifecycle).toBe("onData");
    expect(result.codeFragment).toContain('ctx.getData("robot.temperature")');
    expect(result.draftScript?.permissions).toEqual(expect.arrayContaining(["data.read", "scene.write"]));
    expect(result.draftScript?.capabilities).toEqual(expect.arrayContaining(["studio.data", "studio.object"]));
  });

  it("injects into a standard lifecycle without replacing existing behavior", () => {
    const existing = script(`function onStart(ctx) {
  const note = "brace } inside a string";
  ctx.log(note);
}`);
    const result = createAiSceneScriptDraft({
      intent: "显示对象",
      sceneId: "scene-1",
      target: robot,
      intelligence,
      existingScript: existing,
    });

    expect(result.status).toBe("ready");
    expect(result.draftScript?.code).toContain("ctx.log(note)");
    expect(result.draftScript?.code).toContain("target?.show()");
    expect(result.diff.removedLines).toBeGreaterThanOrEqual(0);
  });

  it("blocks automatic merge when an existing script uses raw commands", () => {
    const result = createAiSceneScriptDraft({
      intent: "隐藏对象",
      sceneId: "scene-1",
      target: robot,
      intelligence,
      existingScript: script('function onStart(ctx) { ctx.command({ type: "custom" }); }'),
    });

    expect(result.status).toBe("blocked");
    expect(result.draftScript).toBeUndefined();
    expect(result.issues[0]?.message).toContain("原始 command");
  });

  it("asks for clarification instead of choosing between conflicting states", () => {
    const result = createAiSceneScriptDraft({
      intent: "显示后再隐藏对象",
      sceneId: "scene-1",
      target: robot,
      intelligence,
    });

    expect(result.status).toBe("needs-input");
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "ambiguous-intent" }));
  });

  it("blocks stale target identities", () => {
    const result = createAiSceneScriptDraft({
      intent: "定位对象",
      sceneId: "scene-1",
      target: { ...robot, id: "retired-robot" },
      intelligence,
    });

    expect(result.status).toBe("blocked");
    expect(result.issues[0]?.code).toBe("unknown-target");
  });

  it("marks coordinate changes high risk and keeps them behind confirmation", () => {
    const result = createAiSceneScriptDraft({
      intent: "移动到 12, 0, -6",
      sceneId: "scene-1",
      target: robot,
      intelligence,
    });

    expect(result.status).toBe("ready");
    expect(result.risk).toBe("high");
    expect(result.commandTypes).toEqual(["object.set-transform"]);
    expect(result.codeFragment).toContain("setPosition(12, 0, -6)");
  });

  it("uses dedicated component and Unity command capabilities", () => {
    const componentDraft = createAiSceneScriptDraft({ intent: "隐藏组件", sceneId: "scene-1", target: widget, intelligence });
    const unityDraft = createAiSceneScriptDraft({ intent: "灯光强度设为 2.5", sceneId: "scene-1", target: unity, intelligence });

    expect(componentDraft).toMatchObject({ status: "ready", commandTypes: ["component.update"] });
    expect(componentDraft.draftScript?.capabilities).toContain("studio.component");
    expect(unityDraft).toMatchObject({ status: "ready", commandTypes: ["unity.properties.set"] });
    expect(unityDraft.draftScript?.capabilities).toContain("studio.unity");
  });
});

function script(code: string): ScriptModule {
  return {
    id: "existing-script",
    name: "现有行为",
    enabled: true,
    apiVersion: "1.0",
    entrypoint: "behavior",
    runtime: "worker-sandbox",
    code,
    lifecycle: ["onStart"],
    capabilities: ["studio.runtime"],
    permissions: ["scene.read", "scene.write"],
    target: { kind: "object", id: robot.id },
  };
}
