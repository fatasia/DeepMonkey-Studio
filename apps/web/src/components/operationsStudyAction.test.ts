import { describe, expect, it } from "vitest";
import type { IndustrialStudyRecord } from "@bim-studio/contracts";
import { resolveOperationsStudyAction } from "./operationsStudyAction";

describe("unified Study workflow action", () => {
  it.each([
    ["plant-lite", "reproduce-plant-lite"],
    ["what-if", "reproduce-what-if"],
    ["workcell-audit", "open-validation-workbench"],
    ["virtual-commissioning", "open-validation-workbench"],
  ] as const)("routes %s through its existing real workflow", (type, kind) => {
    const study = { type, sourceRecordId: "source-1" } as IndustrialStudyRecord;
    expect(resolveOperationsStudyAction(study)).toEqual({ kind, sourceRecordId: "source-1" });
  });
});
