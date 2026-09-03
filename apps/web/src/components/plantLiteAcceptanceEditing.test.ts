import { describe, expect, it } from "vitest";
import { createDefaultPlantLiteRequest } from "./plantLiteModelEditing";
import {
  plantLiteAcceptanceTargetIssues,
  updatePlantLiteAcceptanceBasis,
  updatePlantLiteAcceptanceTarget,
} from "./plantLiteAcceptanceEditing";

describe("plantLiteAcceptanceEditing", () => {
  it("keeps optional targets sparse and removes the empty object", () => {
    const request = createDefaultPlantLiteRequest();
    const withTarget = updatePlantLiteAcceptanceTarget(request, "minimumThroughputPerHour", 60);
    expect(withTarget.acceptanceTargets).toEqual({ minimumThroughputPerHour: 60 });
    const withBasis = updatePlantLiteAcceptanceBasis(withTarget, "规划冻结版");
    expect(withBasis.acceptanceTargets?.basis).toBe("规划冻结版");
    const withoutTarget = updatePlantLiteAcceptanceTarget(withBasis, "minimumThroughputPerHour", undefined);
    expect(withoutTarget.acceptanceTargets).toEqual({ basis: "规划冻结版" });
    expect(updatePlantLiteAcceptanceBasis(withoutTarget, "").acceptanceTargets).toBeUndefined();
  });

  it("rejects non-positive and excessive acceptance values", () => {
    const request = createDefaultPlantLiteRequest();
    request.acceptanceTargets = { minimumThroughputPerHour: 0, maximumAverageLeadTimeMinutes: 600_000 };
    expect(plantLiteAcceptanceTargetIssues(request)).toEqual([
      "最低吞吐必须大于 0 且不超过 1000000000",
      "最大平均交付周期必须大于 0 且不超过 525600",
    ]);
  });
});
