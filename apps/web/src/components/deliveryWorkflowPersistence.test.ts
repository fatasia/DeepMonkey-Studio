import { describe, expect, it } from "vitest";
import { readDeliveryWorkflowMemory, writeDeliveryWorkflowMemory } from "./deliveryWorkflowPersistence";

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value)
  };
}

describe("deliveryWorkflowPersistence", () => {
  it("按项目隔离并恢复最近步骤", () => {
    const browserStorage = storage();
    writeDeliveryWorkflowMemory("project-a", { activeStep: "simulation", previousStep: "behavior", updatedAt: "2026-08-29T00:00:00.000Z" }, browserStorage);
    expect(readDeliveryWorkflowMemory("project-a", browserStorage)).toEqual({ activeStep: "simulation", previousStep: "behavior", updatedAt: "2026-08-29T00:00:00.000Z" });
    expect(readDeliveryWorkflowMemory("project-b", browserStorage)).toBeUndefined();
  });

  it("忽略损坏或未知步骤，不阻塞工作区打开", () => {
    const browserStorage = storage();
    browserStorage.setItem("bim-studio.delivery-workflow.v1:project-a", JSON.stringify({ activeStep: "unknown", updatedAt: 42 }));
    expect(readDeliveryWorkflowMemory("project-a", browserStorage)).toEqual({ updatedAt: "" });
  });
});
