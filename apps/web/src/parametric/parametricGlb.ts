import { Document, WebIO } from "@gltf-transform/core";
import type { ParametricCadBuildResult } from "./parametricCadTypes";

/** CAD 为毫米/Z 向上，场景 GLB 为米/Y 向上，转换实体坐标而非丢失单位。 */
export async function createParametricGlb(result: ParametricCadBuildResult, name: string): Promise<ArrayBuffer> {
  const document = new Document();
  const buffer = document.createBuffer();
  const positions = new Float32Array(result.vertices.length);
  const normals = new Float32Array(result.normals.length);
  for (let index = 0; index < positions.length; index += 3) {
    positions[index] = result.vertices[index]! / 1000;
    positions[index + 1] = result.vertices[index + 2]! / 1000;
    positions[index + 2] = -result.vertices[index + 1]! / 1000;
  }
  for (let index = 0; index < normals.length; index += 3) {
    normals[index] = result.normals[index]!;
    normals[index + 1] = result.normals[index + 2]!;
    normals[index + 2] = -result.normals[index + 1]!;
  }
  const primitive = document.createPrimitive()
    .setAttribute("POSITION", document.createAccessor().setType("VEC3").setArray(positions).setBuffer(buffer))
    .setIndices(document.createAccessor().setType("SCALAR").setArray(result.triangles.slice()).setBuffer(buffer))
    .setMaterial(document.createMaterial("Machined metal").setBaseColorFactor([0.65, 0.69, 0.72, 1]).setMetallicFactor(0.65).setRoughnessFactor(0.3));
  if (normals.length === positions.length) primitive.setAttribute("NORMAL", document.createAccessor().setType("VEC3").setArray(normals).setBuffer(buffer));
  const node = document.createNode(name).setMesh(document.createMesh(name).addPrimitive(primitive));
  document.createScene(name).addChild(node);
  const bytes = await new WebIO().writeBinary(document);
  return bytes.slice().buffer as ArrayBuffer;
}

export function downloadParametricStep(step: ArrayBuffer, name: string): void {
  const url = URL.createObjectURL(new Blob([step], { type: "model/step" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${safeParametricName(name)}.step`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadParametricGlb(glb: ArrayBuffer, name: string): void {
  const url = URL.createObjectURL(new Blob([glb], { type: "model/gltf-binary" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${safeParametricName(name)}.glb`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function safeParametricName(name: string): string {
  return (name.trim() || "参数化模型").replace(/[\\/:*?"<>|]/g, "-").slice(0, 80);
}
