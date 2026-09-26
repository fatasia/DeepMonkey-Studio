import { Accessor, type Buffer, type Document, type Material, type Primitive } from "@gltf-transform/core";

export interface IndexedTriangleGeometry {
  positions: ArrayLike<number>;
  indices: ArrayLike<number>;
  normals?: ArrayLike<number>;
  uvs?: ArrayLike<number> | undefined;
  colors?: ArrayLike<number> | undefined;
}

/**
 * STEP、X_T 与 JT 共用的索引三角图元构造器。
 * 输入在各格式解析器中完成边界校验；这里仅负责稳定写入 glTF accessor。
 */
export function createIndexedTrianglePrimitive(
  document: Document,
  buffer: Buffer,
  material: Material,
  geometry: IndexedTriangleGeometry,
): Primitive {
  const primitive = document.createPrimitive()
    .setAttribute("POSITION", document.createAccessor()
      .setType(Accessor.Type.VEC3!)
      .setArray(new Float32Array(geometry.positions))
      .setBuffer(buffer))
    .setIndices(document.createAccessor()
      .setType(Accessor.Type.SCALAR!)
      .setArray(new Uint32Array(geometry.indices))
      .setBuffer(buffer))
    .setMaterial(material);
  if (geometry.normals?.length === geometry.positions.length) {
    primitive.setAttribute("NORMAL", document.createAccessor()
      .setType(Accessor.Type.VEC3!)
      .setArray(new Float32Array(geometry.normals))
      .setBuffer(buffer));
  }
  if (geometry.uvs && geometry.uvs.length === (geometry.positions.length / 3) * 2) {
    primitive.setAttribute("TEXCOORD_0", document.createAccessor()
      .setType(Accessor.Type.VEC2!)
      .setArray(new Float32Array(geometry.uvs))
      .setBuffer(buffer));
  }
  if (geometry.colors && geometry.colors.length === (geometry.positions.length / 3) * 4) {
    primitive.setAttribute("COLOR_0", document.createAccessor()
      .setType(Accessor.Type.VEC4!)
      .setArray(new Float32Array(geometry.colors))
      .setBuffer(buffer));
  }
  return primitive;
}

/** 按当前三角子集生成平滑法线；分组图元分别调用即可保留面组硬边。 */
export function calculateVertexNormals(positions: ArrayLike<number>, indices: ArrayLike<number>): number[] {
  const normals = new Array<number>(positions.length).fill(0);
  for (let offset = 0; offset + 2 < indices.length; offset += 3) {
    const a = indices[offset]! * 3;
    const b = indices[offset + 1]! * 3;
    const c = indices[offset + 2]! * 3;
    const ab = vectorBetween(positions, a, b);
    const ac = vectorBetween(positions, a, c);
    const normal = cross(ab, ac);
    for (const vertex of [a, b, c]) {
      normals[vertex] = normals[vertex]! + normal[0];
      normals[vertex + 1] = normals[vertex + 1]! + normal[1];
      normals[vertex + 2] = normals[vertex + 2]! + normal[2];
    }
  }
  for (let offset = 0; offset < normals.length; offset += 3) {
    const length = Math.hypot(normals[offset]!, normals[offset + 1]!, normals[offset + 2]!);
    if (length <= Number.EPSILON) continue;
    normals[offset] = normals[offset]! / length;
    normals[offset + 1] = normals[offset + 1]! / length;
    normals[offset + 2] = normals[offset + 2]! / length;
  }
  return normals;
}

function vectorBetween(values: ArrayLike<number>, from: number, to: number): [number, number, number] {
  return [values[to]! - values[from]!, values[to + 1]! - values[from + 1]!, values[to + 2]! - values[from + 2]!];
}

function cross(left: [number, number, number], right: [number, number, number]): [number, number, number] {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}
