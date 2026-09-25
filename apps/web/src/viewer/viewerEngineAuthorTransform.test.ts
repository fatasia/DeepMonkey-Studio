import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { ViewerEngine } from "./ViewerEngine";

describe("author transform authority", () => {
  it("reads persisted model transforms from the author store after the Three projection mutates", () => {
    const object = new THREE.Group();
    object.position.set(1, 2, 3);
    const engine = Object.create(ViewerEngine.prototype) as ViewerEngine & {
      models: Map<string, { object: THREE.Object3D }>;
      authorModelTransforms: Map<string, unknown>;
    };
    Object.assign(engine, { models: new Map([["m", { object }]]), authorModelTransforms: new Map([["m", {
      position: { x: 10, y: 20, z: 30 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    }]]) });

    object.position.set(99, 98, 97);
    expect(engine.getModelTransform("m")).toEqual({
      position: { x: 10, y: 20, z: 30 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    });
  });
});
