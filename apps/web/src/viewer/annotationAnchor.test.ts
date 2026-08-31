import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { SceneAnnotationState } from "@bim-studio/contracts";
import { annotationLocalAnchor, annotationWorldAnchor } from "./annotationAnchor";

const annotation: SceneAnnotationState = {
  id: "temperature-label",
  name: "温度",
  position: { x: 12, y: 4, z: -3 },
  color: "#2f8fff",
  visible: true,
  locked: false,
  modelId: "agv-1",
};

describe("annotationAnchor", () => {
  it("keeps a bound annotation on the same model-local point", () => {
    const target = new THREE.Group();
    target.position.set(10, 2, -5);
    target.rotation.y = Math.PI / 2;
    target.scale.set(2, 2, 2);

    const local = annotationLocalAnchor(annotation, target);
    const restored = annotationWorldAnchor(target, local)!;
    expect(restored.x).toBeCloseTo(12);
    expect(restored.y).toBeCloseTo(4);
    expect(restored.z).toBeCloseTo(-3);

    target.position.x += 6;
    target.rotation.y = Math.PI;
    const followed = annotationWorldAnchor(target, local)!;
    expect(followed.x).not.toBe(annotation.position.x);
    expect(followed.distanceTo(target.position)).toBeCloseTo(local!.length() * 2);
  });

  it("does not create a follow anchor for a free scene annotation", () => {
    const { modelId: _modelId, ...freeAnnotation } = annotation;
    expect(annotationLocalAnchor(freeAnnotation, new THREE.Group())).toBeUndefined();
    expect(annotationWorldAnchor(undefined, new THREE.Vector3())).toBeUndefined();
  });
});
