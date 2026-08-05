import { Document } from "@gltf-transform/core";
import { describe, expect, it } from "vitest";
import { bakeVertexLighting } from "./modelOptimizer";

describe("bakeVertexLighting", () => {
  it("stores fixed lighting in COLOR_0 without changing geometry", () => {
    const document = new Document();
    const buffer = document.createBuffer();
    const positions = document.createAccessor().setType("VEC3").setBuffer(buffer).setArray(new Float32Array([
      0, 0, 0,
      1, 0, 0,
      0, 1, 0
    ]));
    const normals = document.createAccessor().setType("VEC3").setBuffer(buffer).setArray(new Float32Array([
      0, 1, 0,
      0, -1, 0,
      1, 0, 0
    ]));
    const primitive = document.createPrimitive()
      .setAttribute("POSITION", positions)
      .setAttribute("NORMAL", normals);
    document.createMesh().addPrimitive(primitive);

    bakeVertexLighting(document, 0.5);

    const colors = primitive.getAttribute("COLOR_0");
    expect(colors?.getCount()).toBe(3);
    expect(colors?.getType()).toBe("VEC3");
    expect(colors?.getElement(0, [])[0]).toBeGreaterThan(colors?.getElement(1, [])[0] ?? 1);
    expect(positions.getArray()).toEqual(new Float32Array([
      0, 0, 0,
      1, 0, 0,
      0, 1, 0
    ]));
  });

  it("leaves primitives without normals unchanged", () => {
    const document = new Document();
    const positions = document.createAccessor().setType("VEC3").setArray(new Float32Array([0, 0, 0]));
    const primitive = document.createPrimitive().setAttribute("POSITION", positions);
    document.createMesh().addPrimitive(primitive);

    bakeVertexLighting(document, 0.5);

    expect(primitive.getAttribute("COLOR_0")).toBeNull();
  });
});
