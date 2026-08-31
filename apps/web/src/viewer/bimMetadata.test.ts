import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { flattenProperties, hydrateNativeBimMetadata, isVectorValue, nearestBimElement, uniqueComponentRecords } from "./bimMetadata";

describe("BIM metadata", () => {
  it("hydrates converted instance, type and material metadata onto the matching element", () => {
    const root = new THREE.Group();
    const element = new THREE.Group();
    element.userData = { ElementId: "42", NodeType: "Element" };
    root.add(element);
    hydrateNativeBimMetadata(root, {
      model: { source: "ifc" },
      elements: { "42": { elementId: "42", uniqueId: "guid-42", typeId: "type-1", materialIds: ["mat-1"], instanceParameters: [{ name: "Mark", value: "A-42" }] } },
      types: { "type-1": { displayProperties: { "类型.名称": "Wall" } } },
      materials: { "mat-1": { name: "Concrete" } }
    });
    expect(root.userData.BimModel).toEqual({ source: "ifc" });
    expect(element.userData).toMatchObject({ ElementId: "42", UniqueId: "guid-42", "实例.Mark": "A-42", "类型.名称": "Wall" });
    expect(element.userData.BimMetadata.materials).toEqual([{ name: "Concrete" }]);
  });

  it("keeps property flattening bounded and component identities unique", () => {
    const output: Record<string, string> = {};
    flattenProperties({ identity: { name: "Pump", nested: { ignored: true } }, tags: ["A", "B"] }, output);
    expect(output).toEqual({ "identity.name": "Pump", "identity.nested.ignored": "true", tags: "A, B" });
    const records = [{ modelId: "m1", id: "1" }, { modelId: "m1", id: "1" }, { modelId: "m2", id: "1" }] as never[];
    expect(uniqueComponentRecords(records)).toHaveLength(2);
  });

  it("finds the nearest semantic element and validates finite vectors", () => {
    const element = new THREE.Group();
    element.userData.NodeType = "Element";
    const mesh = new THREE.Mesh();
    element.add(mesh);
    expect(nearestBimElement(mesh)).toBe(element);
    expect(isVectorValue({ x: 1, y: 2, z: 3 })).toBe(true);
    expect(isVectorValue({ x: 1, y: Number.NaN, z: 3 })).toBe(false);
  });
});
