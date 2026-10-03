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

function cylinderGeometry(id: string, radius: number, height: number, segments = 20): GeometryResource {
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

function sphereGeometry(id: string, radius: number, widthSegments = 14, heightSegments = 10): GeometryResource {
  const verts: number[] = [], indices: number[] = [];
  for (let y = 0; y <= heightSegments; y++) {
    const phi = (y / heightSegments) * Math.PI;
    for (let x = 0; x <= widthSegments; x++) {
      const theta = (x / widthSegments) * Math.PI * 2;
      const nx = Math.sin(phi) * Math.cos(theta), ny = Math.cos(phi), nz = Math.sin(phi) * Math.sin(theta);
      verts.push(nx * radius, ny * radius, nz * radius, nx, ny, nz);
    }
  }
  const stride = widthSegments + 1;
  for (let y = 0; y < heightSegments; y++) for (let x = 0; x < widthSegments; x++) {
    const a = y * stride + x, b = a + 1, c = a + stride, d = c + 1;
    indices.push(a, b, c, b, d, c);
  }
  return geometry(id, verts, indices);
}

const trs = (x: number, y: number, z: number, sx = 1, sy = 1, sz = 1): number[] =>
  [sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, x, y, z, 1];

function mulRotZ(m: readonly number[], angle: number): number[] {
  const c = Math.cos(angle), s = Math.sin(angle);
  const r: readonly number[] = [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const out = new Array<number>(16);
  for (let col = 0; col < 4; col++) for (let row = 0; row < 4; row++) {
    let sum = 0;
    for (let k = 0; k < 4; k++) sum += r[k * 4 + row]! * m[col * 4 + k]!;
    out[col * 4 + row] = sum;
  }
  return out;
}

const geometries: readonly GeometryResource[] = [
  boxGeometry("slab", 22, 0.3, 15),
  cylinderGeometry("tank-shell", 2.2, 4.2),
  sphereGeometry("tank-cap", 2.2, 18, 8),
  cylinderGeometry("manifold", 0.2, 7.5),
  boxGeometry("transformer", 2.0, 1.9, 1.5),
  boxGeometry("fin", 0.08, 1.3, 0.5),
  cylinderGeometry("beacon-pole", 0.07, 3.4),
  sphereGeometry("beacon", 0.22, 10, 8),
  boxGeometry("dike", 8.6, 0.9, 0.4),
];
const materials: readonly PbrMaterial[] = [
  { id: "tank-white", baseColor: [0.72, 0.74, 0.76], metallic: 0.25, roughness: 0.5 },
  { id: "tank-band", baseColor: [0.16, 0.40, 0.62], metallic: 0.4, roughness: 0.45 },
  { id: "manifold-steel", baseColor: [0.5, 0.53, 0.57], metallic: 0.85, roughness: 0.32 },
  { id: "transformer-grey", baseColor: [0.36, 0.39, 0.43], metallic: 0.5, roughness: 0.55 },
  { id: "beacon-red", baseColor: [0.85, 0.10, 0.08], metallic: 0.1, roughness: 0.4,
    emissiveFactor: [0.95, 0.08, 0.05], emissiveStrength: 2.5 },
  { id: "dike-concrete", baseColor: [0.33, 0.35, 0.38], metallic: 0.05, roughness: 0.85 },
];

const TANKS: readonly { id: string; x: number; z: number }[] = [
  { id: "tank-a", x: -4.4, z: 0 }, { id: "tank-b", x: 4.4, z: 0 },
];

const staticInstances: readonly RenderInstance[] = [
  { id: "floor", geometry: "slab", material: "dike-concrete", transform: trs(0, -0.15, 0) },
  ...TANKS.flatMap((tank): readonly RenderInstance[] => [
    { id: `${tank.id}-shell`, geometry: "tank-shell", material: "tank-white",
      transform: trs(tank.x, 2.1, tank.z), castShadow: true },
    { id: `${tank.id}-cap`, geometry: "tank-cap", material: "tank-band",
      transform: trs(tank.x, 4.2, tank.z) },
  ]),
  { id: "dike-north", geometry: "dike", material: "dike-concrete", transform: trs(0, 0.45, -4.4) },
  { id: "dike-south", geometry: "dike", material: "dike-concrete", transform: trs(0, 0.45, 4.4) },
  { id: "dike-west", geometry: "dike", material: "dike-concrete",
    transform: trs(-8.9, 0.45, 0, 0.28, 1, 22) },
  { id: "dike-east", geometry: "dike", material: "dike-concrete",
    transform: trs(8.9, 0.45, 0, 0.28, 1, 22) },
  { id: "manifold", geometry: "manifold", material: "manifold-steel",
    transform: mulRotZ(trs(0, 1.15, 0), Math.PI / 2) },
  { id: "transformer", geometry: "transformer", material: "transformer-grey",
    transform: trs(0, 1.1, -6.2), castShadow: true },
  ...[-0.7, 0, 0.7].map((offset, index): RenderInstance =>
    ({ id: `fin-${index}`, geometry: "fin", material: "transformer-grey",
      transform: trs(offset, 1.15, -5.35) })),
  { id: "beacon-pole", geometry: "beacon-pole", material: "manifold-steel", transform: trs(0, 1.7, -6.2) },
  { id: "beacon", geometry: "beacon", material: "beacon-red", transform: trs(0, 3.55, -6.2) },
];

/** 能源站：储罐+围堰+变配电+警示信标呼吸（emissiveStrength 1..5，周期 1.2s）。 */
export function beaconStrength(elapsedMs: number): number {
  return 3 + Math.sin((elapsedMs % 1200) / 1200 * Math.PI * 2) * 2;
}

export function createScene(): TemplateSceneSpec {
  return {
    packet: { geometries, materials, instances: staticInstances },
    eye(elapsedMs: number): Vec3 {
      const angle = elapsedMs * 0.00009 + 1.2;
      return [Math.cos(angle) * 17, 9.2, Math.sin(angle) * 15.5];
    },
    target: [0, 2.4, -1.5], extent: 19,
    background: [0.012, 0.02, 0.038], floor: [0.042, 0.05, 0.074],
    exposure: 1.15, roughness: 0.42,
    update(elapsedMs: number) {
      const materials2 = materials.map(material =>
        material.id === "beacon-red" ? { ...material, emissiveStrength: beaconStrength(elapsedMs) } : material);
      return { materials: materials2, instances: staticInstances };
    },
  };
}
