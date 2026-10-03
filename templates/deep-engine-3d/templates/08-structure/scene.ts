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

const trs = (x: number, y: number, z: number, sx = 1, sy = 1, sz = 1): number[] =>
  [sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, x, y, z, 1];

const GRID_X: readonly number[] = [-6, -2, 2, 6];
const GRID_Z: readonly number[] = [-4.5, 0, 4.5];
const STORY = 1.5, LEVELS = 3;

const geometries: readonly GeometryResource[] = [
  boxGeometry("foundation", 15, 0.4, 11),
  boxGeometry("column", 0.26, STORY, 0.26),
  boxGeometry("beam-x", 4.26, 0.2, 0.2),
  boxGeometry("beam-z", 0.2, 0.2, 4.76),
  boxGeometry("slab", 12.6, 0.12, 9.6),
  boxGeometry("glass-panel", 3.9, 1.3, 0.06),
  boxGeometry("lift", 1.4, 0.1, 1.4),
];
const materials: readonly PbrMaterial[] = [
  { id: "concrete-column", baseColor: [0.44, 0.46, 0.49], metallic: 0.1, roughness: 0.75 },
  { id: "steel-beam", baseColor: [0.55, 0.36, 0.14], metallic: 0.6, roughness: 0.45 },
  { id: "slab-grey", baseColor: [0.38, 0.40, 0.43], metallic: 0.08, roughness: 0.8 },
  { id: "glass-curtain", baseColor: [0.42, 0.62, 0.82], metallic: 0.15, roughness: 0.12,
    alphaMode: "BLEND", baseColorAlpha: 0.34, doubleSided: true },
  { id: "lift-yellow", baseColor: [0.85, 0.6, 0.06], metallic: 0.3, roughness: 0.5,
    emissiveFactor: [0.62, 0.42, 0.03], emissiveStrength: 1.0 },
  { id: "column-highlight", baseColor: [0.20, 0.46, 0.78], metallic: 0.3, roughness: 0.5,
    emissiveFactor: [0.1, 0.32, 0.66], emissiveStrength: 2.2 },
];

export const COLUMN_COUNT = GRID_X.length * GRID_Z.length * LEVELS;

const staticInstances: readonly RenderInstance[] = [
  { id: "foundation", geometry: "foundation", material: "slab-grey", transform: trs(0, -0.2, 0) },
  ...GRID_X.flatMap((x, xi) => GRID_Z.flatMap((z, zi) => Array.from({ length: LEVELS },
    (_, level): RenderInstance => ({
      id: `column-${xi}-${zi}-${level}`,
      geometry: "column",
      material: xi === 3 && zi === 2 && level === 1 ? "column-highlight" : "concrete-column",
      transform: trs(x, level * STORY + STORY / 2, z),
    })))),
  ...Array.from({ length: LEVELS }, (_, level) => level).flatMap((level): readonly RenderInstance[] => {
    const y = (level + 1) * STORY;
    return [
      ...GRID_Z.flatMap((z, zi) => Array.from({ length: GRID_X.length - 1 }, (_, span): RenderInstance =>
        ({ id: `beam-x-${zi}-${span}-${level}`, geometry: "beam-x", material: "steel-beam",
          transform: trs((GRID_X[span]! + GRID_X[span + 1]!) / 2, y, z) }))),
      ...GRID_X.map((x, xi): RenderInstance =>
        ({ id: `beam-z-${xi}-${level}`, geometry: "beam-z", material: "steel-beam",
          transform: trs(x, y, 0) })),
      { id: `slab-${level}`, geometry: "slab", material: "slab-grey",
        transform: trs(0, y + 0.16, 0), castShadow: true },
      ...Array.from({ length: GRID_Z.length - 1 }, (_, span): RenderInstance =>
        ({ id: `glass-${span}-${level}`, geometry: "glass-panel", material: "glass-curtain",
          transform: trs(0, y + 0.55, 4.9) })),
    ];
  }),
];

export function liftY(elapsedMs: number): number {
  return 0.55 + (Math.sin(elapsedMs * 0.0035 - Math.PI / 2) * 0.5 + 0.5) * (LEVELS * STORY - 0.9);
}

/** 结构框架：三层梁柱板 + 南立面 BLEND 玻璃幕墙 + 施工升降平台动画 + 构件 outline 高亮。 */
export function createScene(): TemplateSceneSpec {
  return {
    packet: { geometries, materials, instances: [...staticInstances,
      { id: "lift", geometry: "lift", material: "lift-yellow", transform: trs(6, liftY(0), 4.9) }] },
    eye(elapsedMs: number): Vec3 {
      const angle = elapsedMs * 0.00011 + 2.6;
      return [Math.cos(angle) * 19, 5.6, Math.sin(angle) * 16];
    },
    target: [0, 2.4, 0], extent: 18.5,
    background: [0.012, 0.021, 0.04], floor: [0.044, 0.052, 0.078],
    exposure: 1.12, roughness: 0.4,
    update(elapsedMs: number) {
      return { materials, instances: [...staticInstances,
        { id: "lift", geometry: "lift", material: "lift-yellow",
          transform: trs(6, liftY(elapsedMs), 4.9) }] };
    },
  };
}
