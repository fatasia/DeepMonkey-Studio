import { Document, WebIO } from "@gltf-transform/core";
import { describe, expect, it } from "vitest";
import { bakeVertexLighting, DEFAULT_BAKE_LIGHTS } from "./modelOptimizer";

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

    bakeVertexLighting(document, { strength: 0.5, ambient: 0.25, lights: DEFAULT_BAKE_LIGHTS });

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

    bakeVertexLighting(document, { strength: 0.5, ambient: 0.25, lights: DEFAULT_BAKE_LIGHTS });

    expect(primitive.getAttribute("COLOR_0")).toBeNull();
  });

  it("attenuates a point bake light using mesh-local position and range", () => {
    const document = new Document();
    const buffer = document.createBuffer();
    const positions = document.createAccessor().setType("VEC3").setBuffer(buffer).setArray(new Float32Array([
      0, 0, 0,
      8, 0, 0
    ]));
    const normals = document.createAccessor().setType("VEC3").setBuffer(buffer).setArray(new Float32Array([
      0, 1, 0,
      0, 1, 0
    ]));
    const primitive = document.createPrimitive().setAttribute("POSITION", positions).setAttribute("NORMAL", normals);
    document.createMesh().addPrimitive(primitive);

    bakeVertexLighting(document, {
      strength: 1,
      ambient: 0.05,
      lights: [{
        id: "point",
        name: "Point",
        type: "point",
        enabled: true,
        color: "#ffffff",
        intensity: 1,
        direction: [0, 1, 0],
        position: [0, 4, 0],
        range: 10
      }]
    });

    const colors = primitive.getAttribute("COLOR_0");
    expect(colors?.getElement(0, [])[0]).toBeGreaterThan(colors?.getElement(1, [])[0] ?? 1);
  });

  it("keeps baked vertex lighting after GLB export and reload", async () => {
    const document = new Document();
    const buffer = document.createBuffer();
    const positions = document.createAccessor().setType("VEC3").setBuffer(buffer).setArray(new Float32Array([
      0, 0, 0,
      1, 0, 0,
      0, 0, 1
    ]));
    const normals = document.createAccessor().setType("VEC3").setBuffer(buffer).setArray(new Float32Array([
      0, 1, 0,
      0, 1, 0,
      0, 1, 0
    ]));
    const primitive = document.createPrimitive().setAttribute("POSITION", positions).setAttribute("NORMAL", normals);
    const mesh = document.createMesh("exported-bake").addPrimitive(primitive);
    const node = document.createNode().setMesh(mesh);
    document.createScene().addChild(node);

    bakeVertexLighting(document, { strength: 0.7, ambient: 0.15, lights: DEFAULT_BAKE_LIGHTS });
    const io = new WebIO();
    const binary = await io.writeBinary(document);
    const exported = await io.readBinary(binary);
    const colors = exported.getRoot().listMeshes()[0]?.listPrimitives()[0]?.getAttribute("COLOR_0");

    expect(binary.byteLength).toBeGreaterThan(100);
    expect(colors?.getCount()).toBe(3);
    expect(colors?.getArray()).toBeInstanceOf(Float32Array);
    expect(Array.from(colors!.getArray()!)).not.toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1]);
  });
});
