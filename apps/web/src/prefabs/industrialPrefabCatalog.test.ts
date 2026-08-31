import { describe, expect, it } from "vitest";
import type { IndustrialPrefabParameterDefinition } from "@bim-studio/contracts";
import { INDUSTRIAL_PREFAB_CATALOG } from "./industrialPrefabCatalog";

describe("industrial prefab catalog", () => {
  it("contains at least sixty distinct configurable industrial prefabs", () => {
    const ids = INDUSTRIAL_PREFAB_CATALOG.map((item) => item.id);

    expect(INDUSTRIAL_PREFAB_CATALOG.length).toBeGreaterThanOrEqual(60);
    expect(new Set(ids).size).toBe(ids.length);
    expect(INDUSTRIAL_PREFAB_CATALOG.every((item) => item.parameters.length > 0 && item.actions.length > 0 && item.dataPorts.length > 0)).toBe(true);
  });

  it("keeps every parameter key and default value valid", () => {
    for (const prefab of INDUSTRIAL_PREFAB_CATALOG) {
      const keys = prefab.parameters.map((parameter) => parameter.key);
      expect(new Set(keys).size).toBe(keys.length);
      expect(prefab.parameters.every(validParameter)).toBe(true);
    }
  });

  it("covers high-value manufacturing capability families", () => {
    const ids = new Set(INDUSTRIAL_PREFAB_CATALOG.map((item) => item.id));
    const expected = [
      "robot.welding-6",
      "robot.palletizer-4-heavy",
      "conveyor.roller-accumulation",
      "conveyor.sorter",
      "conveyor.vertical-lift",
      "agv.tugger",
      "agv.amr-shelf",
      "vehicle.forklift",
      "access.interlock-door",
      "machine.cnc-mill",
      "utility.pump.centrifugal",
      "utility.cabinet.mcc",
      "sensor.safety-lidar",
      "camera.vision",
      "display.wall",
      "storage.asrs-shuttle",
    ];

    expect([...ids]).toEqual(expect.arrayContaining(expected));
  });

  it("gives route-capable assets and robots operational controls", () => {
    const routeAssets = INDUSTRIAL_PREFAB_CATALOG.filter((item) => item.routeCapable);
    const robots = INDUSTRIAL_PREFAB_CATALOG.filter((item) => item.kind === "robot-arm");

    expect(routeAssets).toHaveLength(16);
    expect(routeAssets.every((item) => item.actions.some((action) => action.id === "dispatch") && item.dataPorts.includes("routeProgress"))).toBe(true);
    expect(robots.every((item) => item.rigCapable && item.actions.some((action) => action.id === "move-tool") && item.dataPorts.includes("jointAngles"))).toBe(true);
  });
});

function validParameter(parameter: IndustrialPrefabParameterDefinition): boolean {
  if (parameter.kind === "number") {
    return typeof parameter.defaultValue === "number"
      && (parameter.min === undefined || parameter.defaultValue >= parameter.min)
      && (parameter.max === undefined || parameter.defaultValue <= parameter.max)
      && (parameter.step === undefined || parameter.step > 0);
  }
  if (parameter.kind === "select") return typeof parameter.defaultValue === "string" && parameter.options?.includes(parameter.defaultValue) === true;
  return parameter.kind === "boolean" ? typeof parameter.defaultValue === "boolean" : typeof parameter.defaultValue === "string";
}
