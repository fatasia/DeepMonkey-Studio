import type { GeometryResource, PbrMaterial, RenderInstance } from "@bim-studio/deep-engine";
import type { TemplateSceneSpec } from "../../sceneTypes.js";

type Vec3 = readonly [number, number, number];

function geometry(id: string, vertices: number[], indices: number[]): GeometryResource {
  return { id, revision: 1, vertices: new Float32Array(vertices), indices: new Uint32Array(indices) };
}

function quad(verts: number[], indices: number[], origin: Vec3, u: Vec3, v: Vec3, n: Vec3): void {
  const base = verts.length / 6;
  for (const [su, sv] of [[0, 0], [1, 0], [1, 1], [0, 1]] as const) {
    verts.push(origin[0]! + su * u[0]! + sv * v[0]!, origin[1]! + su * u[1]! + sv * v[1]!,
      origin[2]! + su * u[2]! + sv * v[2]!, n[0]!, n[1]!, n[2]!);
  }
  indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

function boxGeometry(id: string, w: number, h: number, d: number): GeometryResource {
  const x = w / 2, y = h / 2, z = d / 2;
  const verts: number[] = [], indices: number[] = [];
  const faces: readonly { origin: Vec3; u: Vec3; v: Vec3; n: Vec3 }[] = [
    { origin: [-x, -y, z], u: [w, 0, 0], v: [0, h, 0], n: [0, 0, 1] },
    { origin: [x, -y, -z], u: [-w, 0, 0], v: [0, h, 0], n: [0, 0, -1] },
    { origin: [x, -y, z], u: [0, 0, -d], v: [0, h, 0], n: [1, 0, 0] },
    { origin: [-x, -y, -z], u: [0, 0, d], v: [0, h, 0], n: [-1, 0, 0] },
    { origin: [-x, y, z], u: [w, 0, 0], v: [0, 0, -d], n: [0, 1, 0] },
    { origin: [-x, -y, -z], u: [w, 0, 0], v: [0, 0, d], n: [0, -1, 0] },
  ];
  for (const face of faces) quad(verts, indices, face.origin, face.u, face.v, face.n);
  return geometry(id, verts, indices);
}

function cylinderGeometry(id: string, radius: number, height: number, segments = 16): GeometryResource {
  const verts: number[] = [], indices: number[] = [];
  const half = height / 2, step = (Math.PI * 2) / segments;
  const pushSideRing = (y: number): number => {
    const start = verts.length / 6;
    for (let i = 0; i <= segments; i++) {
      const a = i * step, c = Math.cos(a), s = Math.sin(a);
      verts.push(c * radius, y, s * radius, c, 0, s);
    }
    return start;
  };
  const bottom = pushSideRing(-half), top = pushSideRing(half);
  for (let i = 0; i < segments; i++) {
    indices.push(bottom + i, top + i + 1, bottom + i + 1, bottom + i, top + i, top + i + 1);
  }
  const cap = (y: number, ny: number, flip: boolean): void => {
    const center = verts.length / 6;
    verts.push(0, y, 0, 0, ny, 0);
    const ring = verts.length / 6;
    for (let i = 0; i <= segments; i++) {
      const a = i * step;
      verts.push(Math.cos(a) * radius, y, Math.sin(a) * radius, 0, ny, 0);
    }
    for (let i = 0; i < segments; i++) {
      if (flip) indices.push(center, ring + i + 1, ring + i);
      else indices.push(center, ring + i, ring + i + 1);
    }
  };
  cap(half, 1, true); cap(-half, -1, false);
  return geometry(id, verts, indices);
}

function trs(x: number, y: number, z: number, ry = 0, sx = 1, sy = 1, sz = 1): number[] {
  const c = Math.cos(ry), s = Math.sin(ry);
  return [c * sx, 0, -s * sx, 0, 0, sy, 0, 0, s * sz, 0, c * sz, 0, x, y, z, 1];
}

const geometries: readonly GeometryResource[] = [
  boxGeometry("slab", 26, 0.3, 16),
  boxGeometry("machine-body", 2.4, 2.0, 1.6),
  cylinderGeometry("stack", 0.18, 1.4),
  boxGeometry("stripe", 3.4, 0.02, 0.28),
  boxGeometry("cart", 1.5, 0.8, 1.1),
];
const materials: readonly PbrMaterial[] = [
  { id: "concrete", baseColor: [0.185, 0.20, 0.23], metallic: 0.05, roughness: 0.85 },
  { id: "machine-blue", baseColor: [0.22, 0.36, 0.58], metallic: 0.55, roughness: 0.4 },
  { id: "stack-steel", baseColor: [0.45, 0.47, 0.50], metallic: 0.85, roughness: 0.35 },
  { id: "safety-yellow", baseColor: [0.85, 0.62, 0.05], metallic: 0.1, roughness: 0.6,
    emissiveFactor: [0.72, 0.5, 0.03], emissiveStrength: 1.1 },
  { id: "cart-orange", baseColor: [0.78, 0.34, 0.06], metallic: 0.3, roughness: 0.5 },
];

const MACHINE_ROWS: readonly { x: number; zs: readonly number[] }[] = [
  { x: -8, zs: [-5, -1.6, 1.8, 5.2] }, { x: 8, zs: [-5, -1.6, 1.8, 5.2] },
];
const instances: readonly RenderInstance[] = [
  { id: "floor", geometry: "slab", material: "concrete", transform: trs(0, -0.15, 0),
    receiveShadow: false, castShadow: false },
  ...MACHINE_ROWS.flatMap((row, rowIndex) => row.zs.map((z, index): RenderInstance[] => [
    { id: `machine-${rowIndex}-${index}`, geometry: "machine-body", material: "machine-blue",
      transform: trs(row.x, 1.0, z) },
    { id: `stack-${rowIndex}-${index}`, geometry: "stack", material: "stack-steel",
      transform: trs(row.x + 0.8, 2.7, z - 0.5) },
  ])).flat(),
  ...[-2.4, 0, 2.4].map((z, index): RenderInstance =>
    ({ id: `stripe-${index}`, geometry: "stripe", material: "safety-yellow",
      transform: trs(0, 0.02, z) })),
  { id: "cart-a", geometry: "cart", material: "cart-orange", transform: trs(-2.5, 0.4, -6.2, Math.PI / 2) },
  { id: "cart-b", geometry: "cart", material: "cart-orange", transform: trs(2.5, 0.4, 6.2, Math.PI / 2) },
];

/** 工厂车间：设备阵列 + 通道标线 + 雾效纵深，静态场景 + 环绕巡检相机。 */
export function createScene(): TemplateSceneSpec {
  return {
    packet: { geometries, materials, instances },
    eye(elapsedMs: number): Vec3 {
      const angle = Math.PI * 0.5 + elapsedMs * 0.00011;
      return [Math.cos(angle) * 16.5, 7.6, Math.sin(angle) * 13];
    },
    target: [0, 1.2, 0], extent: 18,
    background: [0.012, 0.022, 0.042], floor: [0.045, 0.055, 0.08],
    exposure: 1.05, roughness: 0.42,
  };
}
