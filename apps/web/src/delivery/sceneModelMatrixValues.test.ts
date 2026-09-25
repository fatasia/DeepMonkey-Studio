import { describe, expect, it } from "vitest";
import type { ModelTransform } from "@bim-studio/contracts";
import { Euler, Matrix4, Quaternion, Vector3 } from "three";
import { sceneModelMatrixValues } from "./sceneModelMatrixValues";

describe("sceneModelMatrixValues", () => {
  it("matches the legacy Three XYZ author transform across varied rotations and mirrored scales", () => {
    for (let index = 0; index < 128; index += 1) {
      const transform: ModelTransform = {
        position: { x: index - 64, y: Math.sin(index) * 100, z: index * -0.25 },
        rotation: { x: Math.sin(index * 0.7) * Math.PI, y: Math.cos(index * 0.3) * Math.PI,
          z: Math.sin(index * 0.19) * Math.PI },
        scale: { x: index % 3 === 0 ? -2 : 0.5, y: index % 5 === 0 ? -3 : 1.25,
          z: index % 7 === 0 ? -4 : 2.75 },
      };
      const { position: p, rotation: r, scale: s } = transform;
      const reference = new Matrix4().compose(
        new Vector3(p.x, p.y, p.z),
        new Quaternion().setFromEuler(new Euler(r.x, r.y, r.z, "XYZ")),
        new Vector3(s.x, s.y, s.z),
      );
      const values = sceneModelMatrixValues(transform, `object-${index}`);
      values.forEach((value, component) => expect(value).toBeCloseTo(reference.elements[component]!, 11));
    }
  });

  it("preserves non-finite and float32-range rejections", () => {
    const transform: ModelTransform = {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    };
    expect(() => sceneModelMatrixValues({ ...transform, position: { ...transform.position, x: Infinity } }, "bad"))
      .toThrow("对象 bad 包含非有限数值");
    expect(() => sceneModelMatrixValues({ ...transform, scale: { ...transform.scale, x: 1e39 } }, "large"))
      .toThrow("对象 large 的变换超出运行时范围");
  });
});
