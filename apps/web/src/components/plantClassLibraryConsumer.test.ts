import { describe, expect, it } from "vitest";
import { createAgvLinePlantLiteModel, validatePlantLiteModel } from "@bim-studio/plant-lite-simulation";
import type { PlantLiteStudyRequest } from "@bim-studio/contracts";
import { createStationClass, insertStationClassInstance } from "./plantClassLibraryConsumer";
import { runPlantLiteExperiment } from "@bim-studio/plant-lite-simulation";

function request(): PlantLiteStudyRequest { return { name: "类库工位", seed: "n7", replications: 2, model: createAgvLinePlantLiteModel() }; }

describe("Plant class-library production consumer", () => {
  it("creates and wires a reusable station instance in the authoritative model", () => {
    const original = request();
    const withClass = createStationClass(original, "station-a", "assembly");
    expect(original.model?.classLibrary).toBeUndefined();
    const inserted = insertStationClassInstance(withClass, "assembly");
    expect(inserted.model?.classLibrary?.[0]?.classId).toBe("assembly");
    const instance = inserted.model?.nodes.find((node) => node.id === "assembly.1.station");
    expect(instance?.kind).toBe("station");
    expect(inserted.model?.edges.some((edge) => edge.to === instance?.id)).toBe(true);
    expect(validatePlantLiteModel(inserted.model).valid).toBe(true);
    const outcome = runPlantLiteExperiment({ model: inserted.model!, seed: inserted.seed!, replications: 2, limits: { durationMinutes: 60 } });
    expect(outcome.replications).toHaveLength(2);
  });
  it("refuses duplicate class, resource-bound station and non-linear insertion", () => {
    const original = request();
    expect(() => createStationClass(original, "station-a", "bad class")).toThrow(/类 ID/);
    const source = original.model!.nodes.find((node) => node.id === "station-a");
    if (!source || source.kind !== "station") throw new Error("fixture station missing");
    source.resourceId = "equipment";
    expect(() => createStationClass(original, "station-a", "assembly")).toThrow(/共享设备/);
    delete source.resourceId;
    const withClass = createStationClass(original, "station-a", "assembly");
    expect(() => createStationClass(withClass, "station-a", "assembly")).toThrow(/已存在/);
    withClass.model!.edges = [];
    expect(() => insertStationClassInstance(withClass, "assembly")).toThrow(/串行流程/);
  });
});
