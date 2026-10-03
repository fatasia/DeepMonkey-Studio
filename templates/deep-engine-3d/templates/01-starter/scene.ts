import type { GeometryResource, PbrMaterial, RenderInstance, RenderPacket } from "@bim-studio/deep-engine";
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

/** TRS（Y 轴旋转 + 缩放 + 平移），列主序，与 RenderInstance.transform 对齐。 */
function trs(x: number, y: number, z: number, ry = 0, sx = 1, sy = 1, sz = 1): number[] {
  const c = Math.cos(ry), s = Math.sin(ry);
  return [c * sx, 0, -s * sx, 0, 0, sy, 0, 0, s * sz, 0, c * sz, 0, x, y, z, 1];
}

const ORBIT_RADIUS = 9, ORBIT_HEIGHT = 4.4;
const eye = (elapsedMs: number): Vec3 => {
  const angle = elapsedMs * 0.00016;
  return [Math.cos(angle) * ORBIT_RADIUS, ORBIT_HEIGHT, Math.sin(angle) * ORBIT_RADIUS];
};

const geometries: readonly GeometryResource[] = [
  boxGeometry("crate", 1.4, 1.4, 1.4),
  boxGeometry("pedestal", 2.2, 0.35, 2.2),
  cylinderGeometry("bollard", 0.22, 1.1),
];
const materials: readonly PbrMaterial[] = [
  { id: "steel-blue", baseColor: [0.30, 0.46, 0.72], metallic: 0.75, roughness: 0.3 },
  { id: "machine-dark", baseColor: [0.16, 0.18, 0.22], metallic: 0.6, roughness: 0.45 },
  { id: "accent-amber", baseColor: [0.92, 0.58, 0.10], metallic: 0.2, roughness: 0.5,
    emissiveFactor: [0.85, 0.4, 0.06], emissiveStrength: 1.4 },
];
const instances: readonly RenderInstance[] = [
  { id: "pedestal", geometry: "pedestal", material: "machine-dark", transform: trs(0, 0.18, 0) },
  { id: "crate", geometry: "crate", material: "steel-blue", transform: trs(0, 1.05, 0, Math.PI / 8) },
  { id: "bollard-east", geometry: "bollard", material: "accent-amber", transform: trs(2.6, 0.55, 1.4) },
  { id: "bollard-west", geometry: "bollard", material: "accent-amber", transform: trs(-2.6, 0.55, -1.4) },
];

/** 通用起步模板：最小可运行场景 + 单实例浮动动画 + 环绕相机。 */
export function createScene(): TemplateSceneSpec {
  return {
    packet: { geometries, materials, instances },
    eye, target: [0, 1.0, 0], extent: 7.5,
    background: [0.014, 0.026, 0.048], floor: [0.05, 0.062, 0.088],
    exposure: 1.1, roughness: 0.4,
    update(elapsedMs: number) {
      const bob = 1.05 + Math.sin(elapsedMs * 0.0022) * 0.18;
      return { materials, instances: [
        instances[0]!, { ...instances[1]!, transform: trs(0, bob, 0, Math.PI / 8) },
        instances[2]!, instances[3]!,
      ] };
    },
  };
}
