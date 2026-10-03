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

function mul4(a: Mat4, b: Mat4): number[] {
  const out = new Array<number>(16);
  for (let col = 0; col < 4; col++) for (let row = 0; row < 4; row++) {
    let sum = 0;
    for (let k = 0; k < 4; k++) sum += a[k * 4 + row]! * b[col * 4 + k]!;
    out[col * 4 + row] = sum;
  }
  return out;
}
const rotX = (a: number): number[] => {
  const c = Math.cos(a), s = Math.sin(a);
  return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1];
};
const rotZ = (a: number): number[] => {
  const c = Math.cos(a), s = Math.sin(a);
  return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
};

const geometries: readonly GeometryResource[] = [
  boxGeometry("slab", 20, 0.3, 12),
  cylinderGeometry("pipe-run-x", 0.26, 8),
  cylinderGeometry("pipe-riser", 0.26, 2.2),
  cylinderGeometry("pipe-run-z", 0.26, 6),
  sphereGeometry("elbow", 0.34),
  boxGeometry("pump-body", 1.6, 1.3, 1.2),
  cylinderGeometry("pump-motor", 0.42, 1.0),
  boxGeometry("marker", 0.22, 0.22, 0.22),
  boxGeometry("saddle", 0.5, 0.7, 1.0),
];
const materials: readonly PbrMaterial[] = [
  { id: "pipe-steel", baseColor: [0.48, 0.52, 0.56], metallic: 0.85, roughness: 0.32 },
  { id: "pipe-window", baseColor: [0.5, 0.68, 0.85], metallic: 0.1, roughness: 0.15,
    alphaMode: "BLEND", baseColorAlpha: 0.32, doubleSided: true },
  { id: "pump-teal", baseColor: [0.10, 0.42, 0.44], metallic: 0.5, roughness: 0.4 },
  { id: "flow-glow", baseColor: [0.95, 0.62, 0.10], metallic: 0.1, roughness: 0.5,
    emissiveFactor: [0.95, 0.5, 0.05], emissiveStrength: 3.2 },
  { id: "floor-dark", baseColor: [0.195, 0.21, 0.25], metallic: 0.05, roughness: 0.85 },
];

/** 管线路径：X 向 8m 主管(透明观察段) → 立管 2.2m → Z 向 6m；s∈[0,16.2)。 */
const RUN_X = 8, RISER = 2.2, RUN_Z = 6, TOTAL = RUN_X + RISER + RUN_Z;
export function pathPoint(s: number): Vec3 {
  const t = ((s % TOTAL) + TOTAL) % TOTAL;
  if (t < RUN_X) return [-6 + t, 1.3, -2.5];
  if (t < RUN_X + RISER) return [2, 1.3 + (t - RUN_X), -2.5];
  return [2, 1.3 + RISER, -2.5 + (t - RUN_X - RISER)];
}

const FLOW_MARKERS = 6, FLOW_SPEED = 2.4;
const staticInstances: readonly RenderInstance[] = [
  { id: "floor", geometry: "slab", material: "floor-dark", transform: trs(0, -0.15, 0) },
  { id: "pump-body", geometry: "pump-body", material: "pump-teal", transform: trs(-6.9, 0.65, -2.5) },
  { id: "pump-motor", geometry: "pump-motor", material: "pipe-steel",
    transform: mul4(trs(-6.9, 1.6, -2.5), rotX(Math.PI / 2)) },
  { id: "elbow-low", geometry: "elbow", material: "pipe-steel", transform: trs(2, 1.3, -2.5) },
  { id: "elbow-high", geometry: "elbow", material: "pipe-steel", transform: trs(2, 3.5, -2.5) },
  { id: "riser", geometry: "pipe-riser", material: "pipe-steel", transform: trs(2, 2.4, -2.5) },
  { id: "run-z", geometry: "pipe-run-z", material: "pipe-steel",
    transform: mul4(trs(2, 3.5, 0.5), rotX(Math.PI / 2)) },
  ...[-4.6, -1.2, 1.6].map((x, index): RenderInstance =>
    ({ id: `saddle-${index}`, geometry: "saddle", material: "pipe-steel",
      transform: trs(x, 0.5, -2.5) })),
];
const windowInstance: RenderInstance = { id: "run-x-window", geometry: "pipe-run-x",
  material: "pipe-window",
  transform: mul4(trs(-2, 1.3, -2.5), rotZ(Math.PI / 2)) };

export function markerTransforms(elapsedMs: number): RenderInstance[] {
  return Array.from({ length: FLOW_MARKERS }, (_, index): RenderInstance => {
    const s = elapsedMs * 0.001 * FLOW_SPEED + index * (TOTAL / FLOW_MARKERS);
    const [x, y, z] = pathPoint(s);
    return { id: `flow-${index}`, geometry: "marker", material: "flow-glow",
      transform: trs(x, y, z) };
  });
}

/** 管线输送：透明观察段内介质流动（路径参数化 markers）+ 泵站。 */
export function createScene(): TemplateSceneSpec {
  return {
    packet: { geometries, materials, instances: [...staticInstances, windowInstance,
      ...markerTransforms(0)] },
    eye(elapsedMs: number): Vec3 {
      const angle = elapsedMs * 0.00012 + 2.2;
      return [Math.cos(angle) * 12.5, 6.8, Math.sin(angle) * 11];
    },
    target: [-1.5, 1.8, -0.5], extent: 12,
    background: [0.011, 0.02, 0.038], floor: [0.04, 0.048, 0.072],
    exposure: 1.15, roughness: 0.4,
    update(elapsedMs: number) {
      return { materials, instances: [...staticInstances, windowInstance, ...markerTransforms(elapsedMs)] };
    },
  };
}
