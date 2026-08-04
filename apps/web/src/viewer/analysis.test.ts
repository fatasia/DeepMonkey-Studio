import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { buildComponentRecords, closestPointsBetweenObjects, componentFacets, filterComponents, preciseIntersection } from "./analysis";

describe("component analysis", () => {
  it("indexes semantic properties and filters components", () => {
    const root = new THREE.Group();
    root.name = "办公楼";
    root.userData = { modelId: "model-1", layerNodeId: "root" };
    const wall = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    wall.name = "外墙 A";
    wall.userData = {
      modelId: "model-1",
      layerNodeId: "root/0",
      GlobalId: "wall-guid",
      Level: "一层",
      Category: "墙"
    };
    root.add(wall);
    const objects = new Map<string, THREE.Object3D>([["root", root], ["root/0", wall]]);
    const records = buildComponentRecords("model-1", "办公楼", objects);

    expect(filterComponents(records, { query: "wall-guid" })).toHaveLength(1);
    expect(filterComponents(records, { level: "一层", category: "墙" })[0]?.name).toBe("外墙 A");
    expect(componentFacets(records)).toMatchObject({ levels: ["一层"], categories: ["墙"] });
  });

  it("uses triangle geometry after the broad bounding-box check", () => {
    const first = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
    const second = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
    first.userData.layerNodeId = "first";
    second.userData.layerNodeId = "second";
    second.position.set(1, 0, 0);
    expect(preciseIntersection(first, second)).toMatchObject({ nodeIdA: "first", nodeIdB: "second" });

    second.position.set(5, 0, 0);
    expect(preciseIntersection(first, second)).toBeUndefined();
  });

  it("finds the closest surface points between separated meshes", () => {
    const first = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    const second = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    second.position.set(3, 0, 0);
    const result = closestPointsBetweenObjects(first, second);
    expect(result?.distance).toBeCloseTo(2, 5);
    expect(result?.pointA.x).toBeCloseTo(0.5, 5);
    expect(result?.pointB.x).toBeCloseTo(2.5, 5);
  });
});
