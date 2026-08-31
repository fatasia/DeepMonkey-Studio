import { describe, expect, it } from "vitest";
import { createPprPlanDraft } from "./pprPlanTemplate";

describe("PD Lite 默认工艺计划", () => {
  it("只写入当前上下文实际提供的 scene/object/script/study ID", () => {
    const draft = createPprPlanDraft("project-1", {
      sceneId: "scene-1",
      objectId: "object-1",
      scriptId: "script-1",
      studyId: "study-1",
    });

    expect(draft.references).toEqual([
      { kind: "scene", id: "scene-1" },
      { kind: "object", id: "object-1" },
      { kind: "script", id: "script-1" },
      { kind: "study", id: "study-1" },
    ]);
    expect(draft.operations.map((operation) => operation.standardTimeMinutes)).toEqual([4, 8]);
  });
});
