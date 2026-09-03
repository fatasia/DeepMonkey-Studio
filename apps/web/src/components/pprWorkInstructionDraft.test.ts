import { describe, expect, it } from "vitest";
import {
  addPprQualityControl,
  availablePprVisualReferences,
  createPprWorkInstruction,
  duplicatePprQualityControl,
  nextPprInstructionItemId,
  togglePprVisualReference,
} from "./pprWorkInstructionDraft";

describe("PPR work instruction draft helpers", () => {
  it("reuses only unique scene/object references and ignores non-visual context", () => {
    const references = availablePprVisualReferences(
      [{ kind: "scene", id: "scene-1" }, { kind: "study", id: "study-1" }],
      [{ kind: "object", id: " fixture-1 " }, { kind: "scene", id: "scene-1" }],
    );
    expect(references).toEqual([
      { kind: "object", id: "fixture-1" },
      { kind: "scene", id: "scene-1" },
    ]);
    expect(createPprWorkInstruction([{ kind: "scene", id: "scene-1" }], references).visualReferences).toEqual([
      { kind: "object", id: "fixture-1" },
      { kind: "scene", id: "scene-1" },
    ]);
  });

  it("adds and copies quality controls with stable IDs and an isolated sampling object", () => {
    let instruction = addPprQualityControl(createPprWorkInstruction(undefined, undefined));
    instruction.qualityChecks[0] = {
      id: "quality-1",
      checkpoint: "扭矩",
      specificationKind: "tolerance",
      targetValue: 12,
      tolerance: 1,
      inspectionMethod: "扭矩枪",
      samplingFrequency: { mode: "every-n-items", interval: 20 },
      outOfControlReaction: "停止并隔离",
    };
    instruction = duplicatePprQualityControl(instruction, "quality-1");
    expect(instruction.qualityChecks).toHaveLength(2);
    expect(instruction.qualityChecks[1]).toMatchObject({ id: "quality-2", checkpoint: "扭矩", samplingFrequency: { interval: 20 } });
    expect(instruction.qualityChecks[1]!.samplingFrequency).not.toBe(instruction.qualityChecks[0]!.samplingFrequency);
  });

  it("keeps stable item IDs and supports explicitly deselecting visual context", () => {
    const instruction = createPprWorkInstruction([{ kind: "scene", id: "scene-1" }], undefined);
    expect(nextPprInstructionItemId(instruction, "step")).toBe("step-2");
    expect(togglePprVisualReference(instruction, { kind: "scene", id: "scene-1" }, false).visualReferences).toEqual([]);
  });
});
