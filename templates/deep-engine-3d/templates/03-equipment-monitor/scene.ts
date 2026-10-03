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

function trs(x: number, y: number, z: number, ry = 0, sx = 1, sy = 1, sz = 1): number[] {
  const c = Math.cos(ry), s = Math.sin(ry);
  return [c * sx, 0, -s * sx, 0, 0, sy, 0, 0, s * sz, 0, c * sz, 0, x, y, z, 1];
}

const geometries: readonly GeometryResource[] = [
  boxGeometry("slab", 18, 0.3, 10),
  boxGeometry("cabinet", 1.8, 2.6, 1.2),
  boxGeometry("screen", 1.3, 0.9, 0.06),
  boxGeometry("lamp-strip", 0.9, 0.12, 0.12),
  boxGeometry("plinth", 2.0, 0.24, 1.4),
  boxGeometry("select-band", 2.06, 0.06, 1.46),
];
/** 设备状态语义三色 + unlit 屏幕面板；告警红由 update() 呼吸调制。 */
const materials: readonly PbrMaterial[] = [
  { id: "cabinet-shell", baseColor: [0.20, 0.24, 0.30], metallic: 0.6, roughness: 0.42 },
  { id: "screen-unlit", baseColor: [0.05, 0.24, 0.46], metallic: 0, roughness: 1,
    shadingModel: "unlit" },
  { id: "status-ok", baseColor: [0.08, 0.62, 0.28], metallic: 0.1, roughness: 0.5,
    emissiveFactor: [0.06, 0.85, 0.3], emissiveStrength: 2 },
  { id: "status-warn", baseColor: [0.85, 0.55, 0.06], metallic: 0.1, roughness: 0.5,
    emissiveFactor: [0.9, 0.5, 0.03], emissiveStrength: 2 },
  { id: "status-alarm", baseColor: [0.78, 0.10, 0.08], metallic: 0.1, roughness: 0.5,
    emissiveFactor: [0.9, 0.07, 0.05], emissiveStrength: 2 },
  { id: "plinth-dark", baseColor: [0.13, 0.15, 0.18], metallic: 0.4, roughness: 0.6 },
  { id: "select-halo", baseColor: [0.88, 0.55, 0.06], metallic: 0.15, roughness: 0.5,
    emissiveFactor: [0.85, 0.45, 0.03], emissiveStrength: 2.6 },
];

const CABINETS: readonly { id: string; x: number; status: "ok" | "warn" | "alarm" }[] = [
  { id: "cnc-01", x: -3.4, status: "ok" },
  { id: "cnc-02", x: 0, status: "warn" },
  { id: "cnc-03", x: 3.4, status: "alarm" },
];
const STATUS_MATERIAL: Record<"ok" | "warn" | "alarm", string> =
  { ok: "status-ok", warn: "status-warn", alarm: "status-alarm" };

const instances: readonly RenderInstance[] = [
  { id: "floor", geometry: "slab", material: "plinth-dark", transform: trs(0, -0.15, 0) },
  ...CABINETS.flatMap((cabinet): readonly RenderInstance[] => [
    { id: `${cabinet.id}-plinth`, geometry: "plinth", material: "plinth-dark",
      transform: trs(cabinet.x, 0.12, 0) },
    { id: `${cabinet.id}-body`, geometry: "cabinet", material: "cabinet-shell",
      transform: trs(cabinet.x, 1.54, 0) },
    { id: `${cabinet.id}-screen`, geometry: "screen", material: "screen-unlit",
      transform: trs(cabinet.x, 2.05, 0.63) },
    { id: `${cabinet.id}-lamp`, geometry: "lamp-strip", material: STATUS_MATERIAL[cabinet.status],
      transform: trs(cabinet.x, 3.0, 0.62) },
  ]),
  // 选中语义：告警柜底部琥珀光环带（WebGPU 运行面已验证的自发光方案）。
  { id: "cnc-03-select-band", geometry: "select-band", material: "select-halo",
    transform: trs(3.4, 0.62, 0) },
];

/** 设备监控：告警红呼吸（emissiveStrength 1.2..4.8，周期 1.6s）；选中柜 outline 常亮。 */
export function createScene(): TemplateSceneSpec {
  return {
    packet: { geometries, materials, instances },
    eye(elapsedMs: number): Vec3 {
      const angle = elapsedMs * 0.00013 + 0.6;
      return [Math.cos(angle) * 9.4, 5.0, Math.sin(angle) * 9.4];
    },
    target: [0, 1.7, 0], extent: 9,
    background: [0.013, 0.022, 0.04], floor: [0.042, 0.05, 0.07],
    exposure: 1.15, roughness: 0.4,
    update(elapsedMs: number) {
      const pulse = 3 + Math.sin((elapsedMs % 1600) / 1600 * Math.PI * 2) * 1.8;
      const animated: PbrMaterial[] = materials.map(material =>
        material.id === "status-alarm" ? { ...material, emissiveStrength: pulse } : material);
      return { materials: animated, instances };
    },
  };
}
