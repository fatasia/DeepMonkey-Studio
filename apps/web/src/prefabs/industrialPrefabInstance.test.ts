import { describe, expect, it } from "vitest";
import { industrialPrefabDefinition } from "./industrialPrefabCatalog";
import { createIndustrialPrefabInstance, industrialPrefabPrimitiveVisual } from "./industrialPrefabInstance";

describe("industrial prefab insertion", () => {
  it("creates a route-ready instance from catalog defaults", () => {
    const definition = industrialPrefabDefinition("agv.carrier");
    expect(definition).toBeDefined();
    let id = 0;
    const instance = createIndustrialPrefabInstance(definition!, { x: 2, y: 0, z: 4 }, () => `point-${++id}`);

    expect(instance).toMatchObject({ definitionId: "agv.carrier", kind: "agv", operatingState: "idle" });
    expect(instance.motionRoute?.points).toEqual([
      { id: "point-1", position: { x: 2, y: 0, z: 4 } },
      { id: "point-2", position: { x: 7, y: 0, z: 4 } },
    ]);
    expect(instance.motionRoute?.loopMode).toBe("loop");
  });

  it("uses restrained blue-green editable proxies for built-in resources", () => {
    expect(industrialPrefabPrimitiveVisual("robot-arm")).toMatchObject({ primitive: "cylinder", color: "#2f80ed" });
    expect(industrialPrefabPrimitiveVisual("conveyor")).toMatchObject({ primitive: "box", color: "#2b9c8b" });
    expect(industrialPrefabPrimitiveVisual("sensor")).toMatchObject({ primitive: "sphere", color: "#35b7a2" });
  });
});
