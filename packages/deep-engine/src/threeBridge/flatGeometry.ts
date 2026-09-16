import type { GeometryResource } from "../renderPacket.js";
import { invalid, unsupported } from "./types.js";

/**
 * flatShading 的几何派生合同：索引几何展开为非索引几何并写入面法线，渲染端不需要
 * flat shader 变体。派生只看三角形绕序（对象局部空间）；镜像 / 非均匀缩放等实例
 * 变换不在此处，正背面语义由渲染端的 ccw 绕序 + mirrored 批次翻转承接。
 * 输入必须先经 projectGeometry 打包与校验；退化面（零面积）按合同拒绝。
 */
export function flattenGeometry(source: Omit<GeometryResource, "id" | "revision">): Omit<GeometryResource, "id" | "revision"> {
  if (source.tangents) unsupported("flat shading with a tangent basis");
  const triangles = source.indices.length / 3, sourceVertexCount = source.vertices.length / 6;
  const vertices = new Float32Array(source.indices.length * 6);
  const uv0 = source.uv0 ? new Float32Array(source.indices.length * 2) : undefined;
  const uv1 = source.uv1 ? new Float32Array(source.indices.length * 2) : undefined;
  const colors = source.colors ? new Float32Array(source.indices.length * 4) : undefined;
  const indices = new Uint32Array(source.indices.length);
  for (let triangle = 0; triangle < triangles; triangle++) {
    const base = triangle * 3, a = source.indices[base]!, b = source.indices[base + 1]!, c = source.indices[base + 2]!;
    if (a >= sourceVertexCount || b >= sourceVertexCount || c >= sourceVertexCount) invalid("flat geometry index");
    const ax = source.vertices[a * 6]!, ay = source.vertices[a * 6 + 1]!, az = source.vertices[a * 6 + 2]!;
    const e1x = source.vertices[b * 6]! - ax, e1y = source.vertices[b * 6 + 1]! - ay, e1z = source.vertices[b * 6 + 2]! - az;
    const e2x = source.vertices[c * 6]! - ax, e2y = source.vertices[c * 6 + 1]! - ay, e2z = source.vertices[c * 6 + 2]! - az;
    // 面法线 = normalize(cross(edge AB, edge AC))；方向由绕序唯一决定。
    let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const length = Math.hypot(nx, ny, nz);
    if (!(length >= 1e-8)) invalid("degenerate flat face");
    nx /= length; ny /= length; nz /= length;
    // 叉积可能留下 -0；加 0 归一为 +0，保证派生法线的跨实现字节稳定（-0 + 0 === +0）。
    nx += 0; ny += 0; nz += 0;
    for (let corner = 0; corner < 3; corner++) {
      const sourceVertex = [a, b, c][corner]!, target = (base + corner) * 6, old = sourceVertex * 6;
      indices[base + corner] = base + corner;
      vertices[target] = source.vertices[old]!; vertices[target + 1] = source.vertices[old + 1]!;
      vertices[target + 2] = source.vertices[old + 2]!;
      vertices[target + 3] = nx; vertices[target + 4] = ny; vertices[target + 5] = nz;
      if (uv0) uv0[(base + corner) * 2] = source.uv0![sourceVertex * 2]!,
        uv0[(base + corner) * 2 + 1] = source.uv0![sourceVertex * 2 + 1]!;
      if (uv1) uv1[(base + corner) * 2] = source.uv1![sourceVertex * 2]!,
        uv1[(base + corner) * 2 + 1] = source.uv1![sourceVertex * 2 + 1]!;
      if (colors) colors.set(source.colors!.subarray(sourceVertex * 4, sourceVertex * 4 + 4), (base + corner) * 4);
    }
  }
  return { vertices, ...(uv0 ? { uv0 } : {}), ...(uv1 ? { uv1 } : {}), ...(colors ? { colors } : {}), indices };
}
