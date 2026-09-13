import { sphereMesh, type GeometryResource, type RenderPacket } from "@bim-studio/deep-engine/webgpu";
import { tokenColor } from "./fixture.js";

function box(): GeometryResource {
  const vertices: number[] = [], indices: number[] = [];
  const faces = [
    { n: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] }, { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
    { n: [0, 1, 0], u: [0, 0, 1], v: [1, 0, 0] }, { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
    { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, { n: [0, 0, -1], u: [0, 1, 0], v: [1, 0, 0] },
  ];
  for (const { n, u, v } of faces) {
    const offset = vertices.length / 6;
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) vertices.push(...n.map((x, i) => (x + a! * u[i]! + b! * v[i]!) * 0.7), ...n);
    indices.push(offset, offset + 1, offset + 2, offset, offset + 2, offset + 3);
  }
  return { id: "box", revision: 0, vertices: new Float32Array(vertices), indices: new Uint32Array(indices) };
}

function cylinder(): GeometryResource {
  const vertices: number[] = [], indices: number[] = [], segments = 40;
  const add = (x: number, y: number, z: number, nx: number, ny: number, nz: number): number => {
    const id = vertices.length / 6; vertices.push(x, y, z, nx, ny, nz); return id;
  };
  for (let i = 0; i < segments; i++) {
    const a = i / segments * Math.PI * 2, b = (i + 1) / segments * Math.PI * 2;
    const ax = Math.cos(a), az = Math.sin(a), bx = Math.cos(b), bz = Math.sin(b);
    const loA = add(ax * 0.7, -0.7, az * 0.7, ax, 0, az), hiA = add(ax * 0.7, 0.7, az * 0.7, ax, 0, az);
    const loB = add(bx * 0.7, -0.7, bz * 0.7, bx, 0, bz), hiB = add(bx * 0.7, 0.7, bz * 0.7, bx, 0, bz);
    indices.push(loA, hiA, loB, loB, hiA, hiB);
    for (const sign of [-1, 1]) {
      const center = add(0, sign * 0.7, 0, 0, sign, 0), one = add(ax * 0.7, sign * 0.7, az * 0.7, 0, sign, 0), two = add(bx * 0.7, sign * 0.7, bz * 0.7, 0, sign, 0);
      indices.push(center, sign > 0 ? two : one, sign > 0 ? one : two);
    }
  }
  return { id: "cylinder", revision: 0, vertices: new Float32Array(vertices), indices: new Uint32Array(indices) };
}

const geometries: GeometryResource[] = [{ id: "sphere", revision: 0, ...sphereMesh() }, box(), cylinder()];

export function mixedPacket(count: number): RenderPacket {
  const side = Math.ceil(Math.sqrt(count));
  const colors = [tokenColor("--text-strong"), tokenColor("--accent"), tokenColor("--text-muted")];
  return { geometries, materials: colors.map((baseColor, index) => ({ id: String(index), baseColor, metallic: index === 0 ? 0.05 : 0.75, roughness: index === 1 ? 0.28 : 0.55 })),
    instances: Array.from({ length: count }, (_, i) => {
      const x = i % side, z = Math.floor(i / side), angle = i * 0.37, c = Math.cos(angle), s = Math.sin(angle);
      const sx = (i % 4 === 0 ? -1 : 1) * 0.8, sy = 0.8 + (i % 3) * 0.25, sz = 0.65;
      const shape = i % 3, height = shape === 0 ? 1 : 0.7;
      return { id: String(i), geometry: geometries[shape]!.id, material: String(Math.floor(i / 3) % 3),
        transform: [c * sx, 0, -s * sx, 0, 0, sy, 0, 0, s * sz, 0, c * sz, 0, (x - (side - 1) / 2) * 2.4, sy * height, (z - (side - 1) / 2) * 2.4, 1] };
    }) };
}
