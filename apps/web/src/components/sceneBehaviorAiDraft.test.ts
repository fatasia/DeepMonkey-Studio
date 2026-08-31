import type { ScriptModule } from "@bim-studio/contracts";
import { describe, expect, it } from "vitest";
import type { AiSceneScriptDraftResult } from "../ai/sceneScriptDraft";
import { acceptAiSceneScriptDraft } from "./sceneBehaviorAiDraft";

describe("acceptAiSceneScriptDraft", () => {
  it("returns an isolated local editor draft after a ready review", () => {
    const current = script("function onStart() {}", "robot-1");
    const generated = script("function onStart() {\n  // generated\n}", "robot-1");
    const accepted = acceptAiSceneScriptDraft(current, result(generated));

    expect(accepted.code).toContain("generated");
    expect(accepted).not.toBe(generated);
    expect(current.code).not.toContain("generated");
  });

  it("rejects stale reviews when the selected script or target changed", () => {
    const current = script("function onStart() {}", "robot-1");
    const staleScript = { ...script("generated", "robot-1"), id: "other-script" };
    expect(() => acceptAiSceneScriptDraft(current, result(staleScript))).toThrow("当前脚本已切换");
    expect(() => acceptAiSceneScriptDraft(current, result(script("generated", "robot-2")))).toThrow("挂载目标已变化");
  });

  it("never accepts a draft that has not passed static gates", () => {
    const current = script("function onStart() {}", "robot-1");
    const { draftScript: _draftScript, ...blocked } = result(current);
    expect(() => acceptAiSceneScriptDraft(current, { ...blocked, status: "blocked" })).toThrow("静态检查");
  });
});

function result(draftScript: ScriptModule): AiSceneScriptDraftResult {
  return {
    status: "ready",
    risk: "low",
    requiresConfirmation: true,
    target: { id: "robot-1", name: "机器人", kind: "object", context: "产线" },
    lifecycle: "onStart",
    actionLabels: ["隐藏对象"],
    codeFragment: "",
    draftScript,
    commandTypes: ["object.set-visibility"],
    diff: { summary: "新增 1 行", addedLines: 1, removedLines: 0, preview: ["target?.hide();"], declarationsAdded: [] },
    issues: [],
    evidenceFingerprint: "fnv1a64-canonical-v1:test-draft",
    fingerprintAlgorithm: "fnv1a64-canonical-v1",
  };
}

function script(code: string, targetId: string): ScriptModule {
  return {
    id: "script-1",
    name: "设备行为",
    enabled: true,
    apiVersion: "1.0",
    entrypoint: "behavior",
    runtime: "worker-sandbox",
    code,
    lifecycle: ["onStart"],
    capabilities: ["studio.object"],
    permissions: ["scene.read", "scene.write"],
    target: { kind: "object", id: targetId },
  };
}
