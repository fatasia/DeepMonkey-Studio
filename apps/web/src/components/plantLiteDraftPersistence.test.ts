import { describe, expect, it } from "vitest";
import type { PlantLiteStudyRecord } from "@bim-studio/contracts";
import { createDefaultPlantLiteRequest } from "./plantLiteModelEditing";
import { plantLiteRequestFromStudy, readPlantLiteDraft, writePlantLiteDraft } from "./plantLiteDraftPersistence";

describe("plantLiteDraftPersistence", () => {
  it("keeps editable drafts isolated by project", () => {
    const storage = memoryStorage();
    const request = createDefaultPlantLiteRequest();
    request.name = "项目 A 草稿";

    expect(writePlantLiteDraft("project-a", request, storage)).toBe(true);
    expect(readPlantLiteDraft("project-a", storage)?.name).toBe("项目 A 草稿");
    expect(readPlantLiteDraft("project-b", storage)).toBeUndefined();
  });

  it("ignores corrupt or invalid browser data", () => {
    const storage = memoryStorage();
    storage.setItem("bim-studio:plant-lite-draft:broken", "{not-json");
    storage.setItem("bim-studio:plant-lite-draft:invalid", JSON.stringify({ name: "没有模型" }));

    expect(readPlantLiteDraft("broken", storage)).toBeUndefined();
    expect(readPlantLiteDraft("invalid", storage)).toBeUndefined();
  });

  it("restores editable input from the latest study without carrying comparison metadata", () => {
    const request = createDefaultPlantLiteRequest();
    request.model!.productionOrders = [{ id: "order-1", name: "订单 1", sourceNodeId: "source", quantity: 20, releaseMinute: 0, dueMinute: 120 }];
    const study = {
      name: "订单工况",
      templateId: "agv-line-v1",
      model: request.model,
      seed: "saved-seed",
      replications: 8,
      comparison: { groupId: "group", baselineStudyId: "base", parameterLabel: "缓冲", candidateLabel: "20" },
      acceptanceTargets: { minimumThroughputPerHour: 12 },
      execution: {
        limits: { durationMinutes: 600, warmupMinutes: 60, maxEvents: 90_000, maxResources: 120 },
        trace: { replication: 0, maxEvents: 12_000, maxItems: 2_000 },
      },
    } as unknown as PlantLiteStudyRecord;

    expect(plantLiteRequestFromStudy(study)).toMatchObject({
      name: "订单工况",
      seed: "saved-seed",
      replications: 8,
      limits: { durationMinutes: 600, warmupMinutes: 60 },
      acceptanceTargets: { minimumThroughputPerHour: 12 },
      model: { productionOrders: [{ id: "order-1", quantity: 20 }] },
    });
    expect(plantLiteRequestFromStudy(study)).not.toHaveProperty("comparison");
  });
});

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}
