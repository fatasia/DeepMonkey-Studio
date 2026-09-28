export interface SdfMesh {
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
}

export interface SdfGrid {
  readonly origin: readonly [number, number, number];
  readonly cellSize: number;
  readonly dimensions: readonly [number, number, number];
  /** Metres; negative inside closed source geometry, positive outside. */
  readonly distances: Float32Array<ArrayBuffer>;
  readonly maxSamplingError: number;
}

const MAX_CELLS = 262_144;
const MAX_TRIANGLES = 16_384;
const MAX_TRIANGLE_SAMPLES = 16_777_216;

/** A bounded, deterministic reference for closed CAD meshes. It does not mutate Rapier's collider. */
export function buildSdfGrid(mesh: SdfMesh, origin: readonly [number, number, number],
  dimensions: readonly [number, number, number], cellSize: number): SdfGrid {
  const [nx, ny, nz] = dimensions;
  const cells = nx * ny * nz;
  if (!Number.isFinite(cellSize) || cellSize <= 0 || ![...origin].every(Number.isFinite)
    || !dimensions.every(value => Number.isSafeInteger(value) && value >= 2 && value <= 128)
    || !Number.isSafeInteger(cells) || cells > MAX_CELLS) throw new RangeError("SDF 网格尺寸或内存预算无效");
  if (!mesh.indices.length || mesh.indices.length % 3 !== 0 || mesh.indices.length / 3 > MAX_TRIANGLES
    || cells * (mesh.indices.length / 3) > MAX_TRIANGLE_SAMPLES
    || mesh.positions.length % 3 !== 0 || !mesh.positions.every(Number.isFinite)
    || !mesh.indices.every(index => index < mesh.positions.length / 3)) throw new TypeError("SDF 网格需要有效三角形顶点及索引");
  const triangles = Array.from({ length: mesh.indices.length / 3 }, (_, index) => {
    const point = (corner: number): [number, number, number] => {
      const offset = mesh.indices[index * 3 + corner]! * 3;
      return [mesh.positions[offset]!, mesh.positions[offset + 1]!, mesh.positions[offset + 2]!];
    };
    return [point(0), point(1), point(2)] as const;
  });
  const distances = new Float32Array(cells);
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const p: [number, number, number] = [origin[0] + x * cellSize, origin[1] + y * cellSize, origin[2] + z * cellSize];
    let nearest = Infinity;
    const intersections: number[] = [];
    for (const [a, b, c] of triangles) {
      nearest = Math.min(nearest, triangleDistance(p, a, b, c));
      const hit = rayX(p, a, b, c);
      if (hit !== undefined) intersections.push(hit);
    }
    intersections.sort((a, b) => a - b);
    let crossings = 0, previous = -Infinity;
    for (const hit of intersections) {
      if (hit - previous > 1e-6 * cellSize) crossings++;
      previous = hit;
    }
    distances[(z * ny + y) * nx + x] = Math.fround((crossings % 2 ? -1 : 1) * nearest);
  }
  return { origin, cellSize, dimensions, distances, maxSamplingError: Math.sqrt(3) * cellSize * 0.5 };
}

/** Trilinear query. Outside the voxel domain is unknown, not a false 'no collision'. */
export function sampleSdfGrid(grid: SdfGrid, point: readonly [number, number, number]): number {
  if (!point.every(Number.isFinite)) throw new TypeError("SDF 查询点必须是有限数值");
  const [nx, ny, nz] = grid.dimensions;
  const coords = point.map((value, axis) => (value - grid.origin[axis]!) / grid.cellSize);
  if (coords.some((value, axis) => value < 0 || value > grid.dimensions[axis]! - 1)) throw new RangeError("SDF 查询点超出有界网格");
  const [x, y, z] = coords.map(Math.floor), [u, v, w] = coords.map((value, axis) => value - [x, y, z][axis]!);
  const at = (dx: number, dy: number, dz: number) => grid.distances[
    (Math.min(z! + dz, nz - 1) * ny + Math.min(y! + dy, ny - 1)) * nx + Math.min(x! + dx, nx - 1)]!;
  const mix = (a: number, b: number, t: number) => a + (b - a) * t;
  return mix(mix(mix(at(0, 0, 0), at(1, 0, 0), u!), mix(at(0, 1, 0), at(1, 1, 0), u!), v!),
    mix(mix(at(0, 0, 1), at(1, 0, 1), u!), mix(at(0, 1, 1), at(1, 1, 1), u!), v!), w!);
}

function sub(a: readonly number[], b: readonly number[]): [number, number, number] {
  return [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
}
function dot(a: readonly number[], b: readonly number[]): number { return a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!; }
function triangleDistance(p: readonly number[], a: readonly number[], b: readonly number[], c: readonly number[]): number {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return Math.hypot(...ap);
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return Math.hypot(...bp);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return Math.hypot(...sub(p, ab.map((v, i) => a[i]! + v * d1 / (d1 - d3))));
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return Math.hypot(...cp);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return Math.hypot(...sub(p, ac.map((v, i) => a[i]! + v * d2 / (d2 - d6))));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const bc = sub(c, b), t = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    return Math.hypot(...sub(p, bc.map((v, i) => b[i]! + v * t)));
  }
  const normal = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
  const magnitude = Math.hypot(...normal);
  if (magnitude <= 1e-12) throw new TypeError("SDF 源网格包含退化三角形");
  return Math.abs(dot(ap, normal)) / magnitude;
}
function rayX(p: readonly number[], a: readonly number[], b: readonly number[], c: readonly number[]): number | undefined {
  const e1 = sub(b, a), e2 = sub(c, a);
  const h: [number, number, number] = [0, -e2[2], e2[1]];
  const det = dot(e1, h);
  if (Math.abs(det) < 1e-10) return undefined;
  const f = 1 / det, s = sub(p, a), u = f * dot(s, h);
  if (u < -1e-8 || u > 1 + 1e-8) return undefined;
  const q: [number, number, number] = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
  const v = f * q[0];
  if (v < -1e-8 || u + v > 1 + 1e-8) return undefined;
  const t = f * dot(e2, q);
  return t > 1e-8 ? p[0]! + t : undefined;
}
