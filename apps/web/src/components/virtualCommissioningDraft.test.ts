import { describe, expect, it } from "vitest";
import type { IndustrialValidationStudyRecord, SceneSnapshot } from "@bim-studio/contracts";
import { defaultVirtualDebugBindings, validationDraftFromStudy } from "./virtualCommissioningDraft";

describe("saved validation Study draft", () => {
  it("uses record identity and revision so linked runs reopen independently", () => {
    const base = {
      id: "study-1",
      revision: 2,
      sourceRefs: ["shared-evidence"],
      objective: "验证联锁",
      acceptanceCriteria: ["故障锁存"],
      sceneId: "scene-1",
      objectIds: ["robot-1"],
    } as IndustrialValidationStudyRecord;
    const next = { ...base, id: "study-2", revision: 1 };

    expect(validationDraftFromStudy(base)).toMatchObject({
      sourceAssessmentId: "study:study-1:v2",
      sceneId: "scene-1",
      objectId: "robot-1",
    });
    expect(validationDraftFromStudy(next).sourceAssessmentId).toBe("study:study-2:v1");
  });

  it("binds editor-launched validation to the selected scene object", () => {
    const scene = {
      id: "scene-1",
      models: [
        { modelId: "conveyor-1", name: "输送线" },
        { modelId: "robot-1", name: "机器人" },
      ],
      primitives: [],
    } as unknown as SceneSnapshot;

    expect(defaultVirtualDebugBindings(scene, "robot-1")).toHaveLength(2);
    expect(defaultVirtualDebugBindings(scene, "robot-1").every((binding) => binding.target.objectId === "robot-1")).toBe(true);
  });
});
