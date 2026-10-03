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

function cylinderGeometry(id: string, radius: number, height: number, segments = 14): GeometryResource {
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

const trs = (x: number, y: number, z: number, ry = 0, sx = 1, sy = 1, sz = 1): number[] => {
  const c = Math.cos(ry), s = Math.sin(ry);
  return [c * sx, 0, -s * sx, 0, 0, sy, 0, 0, s * sz, 0, c * sz, 0, x, y, z, 1];
};

const RACK_X: readonly number[] = [-4.8, -1.6, 1.6, 4.8];
const LEVELS: readonly number[] = [0.55, 1.55, 2.55];

const geometries: readonly GeometryResource[] = [
  boxGeometry("slab", 22, 0.3, 14),
  boxGeometry("upright", 0.18, 3.1, 1.4),
  boxGeometry("shelf", 3.2, 0.1, 1.4),
  boxGeometry("pallet", 1.15, 0.16, 1.0),
  boxGeometry("cargo", 0.95, 0.7, 0.85),
  boxGeometry("agv-body", 1.7, 0.5, 1.15),
  boxGeometry("agv-lamp", 0.5, 0.1, 0.14),
  cylinderGeometry("roller", 0.16, 1.5),
  boxGeometry("conveyor-frame", 3.4, 0.16, 1.0),
];
const materials: readonly PbrMaterial[] = [
  { id: "floor-grey", baseColor: [0.21, 0.225, 0.26], metallic: 0.05, roughness: 0.85 },
  { id: "rack-orange", baseColor: [0.72, 0.30, 0.06], metallic: 0.4, roughness: 0.5 },
  { id: "pallet-wood", baseColor: [0.55, 0.40, 0.22], metallic: 0.05, roughness: 0.8 },
  { id: "cargo-teal", baseColor: [0.13, 0.38, 0.42], metallic: 0.2, roughness: 0.6 },
  { id: "cargo-blue", baseColor: [0.18, 0.34, 0.60], metallic: 0.2, roughness: 0.6 },
  { id: "agv-yellow", baseColor: [0.85, 0.62, 0.06], metallic: 0.35, roughness: 0.45 },
  { id: "agv-lamp", baseColor: [0.10, 0.85, 0.35], metallic: 0.1, roughness: 0.4,
    emissiveFactor: [0.08, 0.9, 0.3], emissiveStrength: 2.4 },
  { id: "roller-steel", baseColor: [0.5, 0.53, 0.57], metallic: 0.85, roughness: 0.35 },
];

function buildRack(rack: "north" | "south", z: number): readonly RenderInstance[] {
  const parts: RenderInstance[] = RACK_X.map((x, index): RenderInstance =>
    ({ id: `${rack}-upright-${index}`, geometry: "upright", material: "rack-orange",
      transform: trs(x, 1.55, z) }));
  LEVELS.forEach((y, level) => {
    for (let bay = 0; bay < 3; bay++) {
      const x = (RACK_X[bay]! + RACK_X[bay + 1]!) / 2;
      parts.push({ id: `${rack}-shelf-${level}-${bay}`, geometry: "shelf", material: "rack-orange",
        transform: trs(x, y, z) });
      const cargoMaterial = (level + bay) % 2 === 0 ? "cargo-teal" : "cargo-blue";
      parts.push({ id: `${rack}-pallet-${level}-${bay}`, geometry: "pallet", material: "pallet-wood",
        transform: trs(x - 0.4, y + 0.13, z), castShadow: true });
      parts.push({ id: `${rack}-cargo-${level}-${bay}`, geometry: "cargo",
        material: cargoMaterial, transform: trs(x + 0.55, y + 0.51, z), castShadow: true });
    }
  });
  return parts;
}

export function agvX(elapsedMs: number, phase: number): number {
  return Math.sin(elapsedMs * 0.0008 + phase) * 6.2;
}

const staticInstances: readonly RenderInstance[] = [
  { id: "floor", geometry: "slab", material: "floor-grey", transform: trs(0, -0.15, 0) },
  ...buildRack("north", -3.6),
  ...buildRack("south", 3.6),
  { id: "conveyor-frame", geometry: "conveyor-frame", material: "roller-steel",
    transform: trs(-9.2, 0.55, 0) },
  ...Array.from({ length: 8 }, (_, index): RenderInstance =>
    ({ id: `roller-${index}`, geometry: "roller", material: "roller-steel",
      transform: mulRotZ(trs(-10.5 + index * 0.38, 0.75, 0)) })),
];

function mulRotZ(m: readonly number[]): number[] {
  const c = Math.cos(Math.PI / 2), s = Math.sin(Math.PI / 2);
  const r: readonly number[] = [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const out = new Array<number>(16);
  for (let col = 0; col < 4; col++) for (let row = 0; row < 4; row++) {
    let sum = 0;
    for (let k = 0; k < 4; k++) sum += r[k * 4 + row]! * m[col * 4 + k]!;
    out[col * 4 + row] = sum;
  }
  return out;
}

function agvInstances(elapsedMs: number): readonly RenderInstance[] {
  const x1 = agvX(elapsedMs, 0), x2 = agvX(elapsedMs, Math.PI);
  return [
    { id: "agv-1", geometry: "agv-body", material: "agv-yellow",
      transform: trs(x1, 0.42, 0), castShadow: true },
    { id: "agv-1-lamp", geometry: "agv-lamp", material: "agv-lamp", transform: trs(x1, 0.72, 0) },
    { id: "agv-2", geometry: "agv-body", material: "agv-yellow",
      transform: trs(x2, 0.42, 0, Math.PI), castShadow: true },
    { id: "agv-2-lamp", geometry: "agv-lamp", material: "agv-lamp",
      transform: trs(x2, 0.72, 0, Math.PI) },
  ];
}

/** 物流仓储：双 AGV 巷道往返 + 三层货架托盘 + 输送辊道（辊道共享单几何实例化）。 */
export function createScene(): TemplateSceneSpec {
  return {
    packet: { geometries, materials, instances: [...staticInstances, ...agvInstances(0)] },
    eye(elapsedMs: number): Vec3 {
      const angle = elapsedMs * 0.0001 + 0.4;
      return [Math.cos(angle) * 13, 7.5, Math.sin(angle) * 12];
    },
    target: [-1, 1.5, 0], extent: 15,
    background: [0.012, 0.022, 0.042], floor: [0.045, 0.054, 0.08],
    exposure: 1.12, roughness: 0.42,
    update(elapsedMs: number) {
      return { materials, instances: [...staticInstances, ...agvInstances(elapsedMs)] };
    },
  };
}
