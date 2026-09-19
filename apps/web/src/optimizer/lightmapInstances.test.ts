import { expect, it } from "vitest";
import { giFixture } from "../../scripts/gi-bake-fixture";
import { separateLightmapInstances } from "./lightmapInstances";

it("separates shared mesh primitives without changing transforms, identity or source geometry", () => {
  const document = giFixture(), scene = document.getRoot().listScenes()[0]!;
  const source = scene.listChildren()[0]!, mesh = source.getMesh()!, primitive = mesh.listPrimitives()[0]!;
  const instance = document.createNode("second floor").setMesh(mesh).setTranslation([10, 2, -3]).setScale([-1, 2, 1]).setExtras({ sourceId: "instance-2" });
  scene.addChild(instance);
  const matrix = instance.getWorldMatrix();
  expect(separateLightmapInstances(document)).toBe(true);
  const copy = instance.getMesh()!.listPrimitives()[0]!;
  expect(instance.getMesh()).not.toBe(mesh);expect(copy).not.toBe(primitive);
  expect(copy.getAttribute("POSITION")).toBe(primitive.getAttribute("POSITION"));
  expect(copy.getMaterial()).toBe(primitive.getMaterial());
  expect(instance.getWorldMatrix()).toEqual(matrix);expect(instance.getExtras()).toEqual({ sourceId: "instance-2" });
  copy.setAttribute("TEXCOORD_1", primitive.getAttribute("POSITION"));
  expect(primitive.getAttribute("TEXCOORD_1")).toBeNull();
  expect(separateLightmapInstances(document)).toBe(false);
});

it("also separates a primitive shared by distinct meshes, preserving primitive order", () => {
  const document = giFixture(), source = document.getRoot().listMeshes()[0]!;
  const primitives = source.listPrimitives();
  const other = document.createMesh().addPrimitive(primitives[0]!);
  document.getRoot().listScenes()[0]!.addChild(document.createNode().setMesh(other));
  expect(separateLightmapInstances(document)).toBe(true);
  expect(other.listPrimitives()).toHaveLength(1);
  expect(other.listPrimitives()[0]).not.toBe(primitives[0]);
  expect(source.listPrimitives()).toEqual(primitives);
});
