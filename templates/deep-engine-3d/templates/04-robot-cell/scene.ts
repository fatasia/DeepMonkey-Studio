import type { GeometryResource, PbrMaterial, RenderInstance } from "@bim-studio/deep-engine";
import type { TemplateSceneSpec } from "../../sceneTypes.js";

type Vec3 = readonly [number, number, number];
type Mat4 = readonly number[];

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

const trs = (x: number, y: number, z: number, sx = 1, sy = 1, sz = 1): number[] =>
  [sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, x, y, z, 1];

/** 列主序 mat4 乘法 out = a·b。 */
function mul4(a: Mat4, b: Mat4): number[] {
  const out = new Array<number>(16);
  for (let col = 0; col < 4; col++) for (let row = 0; row < 4; row++) {
    let sum = 0;
    for (let k = 0; k < 4; k++) sum += a[k * 4 + row]! * b[col * 4 + k]!;
    out[col * 4 + row] = sum;
  }
  return out;
}

const rotY = (a: number): number[] => {
  const c = Math.cos(a), s = Math.sin(a);
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
};
const rotZ = (a: number): number[] => {
  const c = Math.cos(a), s = Math.sin(a);
  return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
};

const geometries: readonly GeometryResource[] = [
  boxGeometry("slab", 16, 0.3, 12),
  cylinderGeometry("base", 0.9, 1.1),
  cylinderGeometry("joint", 0.34, 0.7),
  boxGeometry("link1", 2.4, 0.46, 0.5),
  boxGeometry("link2", 1.8, 0.38, 0.42),
  boxGeometry("gripper", 0.6, 0.28, 0.24),
  boxGeometry("post", 0.16, 1.2, 0.16),
  boxGeometry("rail", 7.4, 0.08, 0.08),
  boxGeometry("worktable", 2.6, 0.16, 1.6),
  boxGeometry("workpiece", 0.7, 0.5, 0.7),
];
const materials: readonly PbrMaterial[] = [
  { id: "robot-orange", baseColor: [0.82, 0.32, 0.05], metallic: 0.35, roughness: 0.42 },
  { id: "joint-dark", baseColor: [0.14, 0.15, 0.17], metallic: 0.7, roughness: 0.35 },
  { id: "gripper-steel", baseColor: [0.55, 0.58, 0.62], metallic: 0.9, roughness: 0.28 },
  { id: "fence-yellow", baseColor: [0.82, 0.6, 0.05], metallic: 0.15, roughness: 0.6,
    emissiveFactor: [0.6, 0.42, 0.02], emissiveStrength: 0.9 },
  { id: "floor-grey", baseColor: [0.21, 0.225, 0.26], metallic: 0.05, roughness: 0.85 },
  { id: "workpiece-blue", baseColor: [0.2, 0.4, 0.66], metallic: 0.3, roughness: 0.45 },
];

const FENCE_POSTS: readonly Vec3[] = [
  [-3.6, 0.6, -3.2], [-1.2, 0.6, -3.2], [1.2, 0.6, -3.2], [3.6, 0.6, -3.2],
  [3.6, 0.6, 3.2], [1.2, 0.6, 3.2], [-1.2, 0.6, 3.2], [-3.6, 0.6, 3.2],
];

const staticInstances: readonly RenderInstance[] = [
  { id: "floor", geometry: "slab", material: "floor-grey", transform: trs(0, -0.15, 0) },
  { id: "robot-base", geometry: "base", material: "joint-dark", transform: trs(0, 0.55, 0) },
  ...FENCE_POSTS.map((post, index): RenderInstance =>
    ({ id: `fence-post-${index}`, geometry: "post", material: "fence-yellow", transform: trs(...post) })),
  { id: "fence-rail-north", geometry: "rail", material: "fence-yellow", transform: trs(0, 1.05, -3.2) },
  { id: "fence-rail-south", geometry: "rail", material: "fence-yellow", transform: trs(0, 1.05, 3.2) },
  { id: "worktable", geometry: "worktable", material: "joint-dark", transform: trs(3.1, 0.55, 0) },
  { id: "workpiece", geometry: "workpiece", material: "workpiece-blue", transform: trs(3.1, 0.88, 0) },
];

export interface RobotPose {
  readonly shoulder: Mat4;
  readonly elbow: Mat4;
  readonly wrist: Mat4;
}

/** 关节角→各连杆世界变换的层级链：base→肩(yaw)→大臂→肘(pitch)→小臂→腕(pitch)→夹爪。 */
export function pose(elapsedMs: number): RobotPose {
  const a1 = Math.sin(elapsedMs * 0.0009) * 0.7;
  const a2 = 0.55 + Math.sin(elapsedMs * 0.0013) * 0.4;
  const a3 = -0.9 - Math.sin(elapsedMs * 0.0007) * 0.3;
  const shoulder = mul4(trs(0, 1.25, 0), rotY(a1));
  const elbow = mul4(mul4(shoulder, trs(2.2, 0, 0)), rotZ(a2));
  const wrist = mul4(mul4(elbow, trs(1.75, 0, 0)), rotZ(a3));
  return { shoulder, elbow, wrist };
}

/** 机器人单元：六关节层级动画（单 RenderInstance 扁平变换承载世界矩阵）。 */
export function createScene(): TemplateSceneSpec {
  const { shoulder, elbow, wrist } = pose(0);
  const instances: readonly RenderInstance[] = [
    ...staticInstances,
    { id: "shoulder-joint", geometry: "joint", material: "joint-dark", transform: shoulder },
    { id: "arm-link1", geometry: "link1", material: "robot-orange",
      transform: mul4(shoulder, trs(1.1, 0, 0)) },
    { id: "elbow-joint", geometry: "joint", material: "joint-dark", transform: elbow },
    { id: "arm-link2", geometry: "link2", material: "robot-orange",
      transform: mul4(elbow, trs(0.85, 0, 0)) },
    { id: "wrist-joint", geometry: "joint", material: "joint-dark", transform: wrist },
    { id: "gripper", geometry: "gripper", material: "gripper-steel",
      transform: mul4(wrist, trs(0.35, 0, 0)) },
  ];
  return {
    packet: { geometries, materials, instances },
    eye(elapsedMs: number): Vec3 {
      const angle = 0.9 + elapsedMs * 0.00014;
      return [Math.cos(angle) * 9.5, 5.2, Math.sin(angle) * 9.5];
    },
    target: [0.6, 1.4, 0], extent: 10.5,
    background: [0.012, 0.021, 0.04], floor: [0.045, 0.052, 0.075],
    exposure: 1.15, roughness: 0.42,
    update(elapsedMs: number) {
      const p = pose(elapsedMs);
      return { materials, instances: [
        ...staticInstances,
        { id: "shoulder-joint", geometry: "joint", material: "joint-dark", transform: p.shoulder },
        { id: "arm-link1", geometry: "link1", material: "robot-orange",
          transform: mul4(p.shoulder, trs(1.1, 0, 0)) },
        { id: "elbow-joint", geometry: "joint", material: "joint-dark", transform: p.elbow },
        { id: "arm-link2", geometry: "link2", material: "robot-orange",
          transform: mul4(p.elbow, trs(0.85, 0, 0)) },
        { id: "wrist-joint", geometry: "joint", material: "joint-dark", transform: p.wrist },
        { id: "gripper", geometry: "gripper", material: "gripper-steel",
          transform: mul4(p.wrist, trs(0.35, 0, 0)) },
      ] };
    },
  };
}
