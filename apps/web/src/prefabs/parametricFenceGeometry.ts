import * as THREE from "three";

export interface FenceShape {
  heightM: number;
  postSpacingM: number;
  gateWidthM: number;
  panel: "mesh" | "solid" | "glass" | "electronic";
}
export interface FenceMaterials {
  metal: THREE.Material;
  dark: THREE.Material;
  panel: THREE.Material;
  warning: THREE.Material;
}

/** Bounds match the existing fence parameter contract; malformed snapshots remain finite. */
export function fenceShape(parameters: Record<string, unknown> = {}): FenceShape {
  const finite = (key: string, fallback: number, min: number, max: number) => {
    const value = parameters[key];
    return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  };
  const panel = parameters.panel;
  return {
    heightM: finite("heightM", 1.8, 0.5, 8),
    postSpacingM: finite("postSpacingM", 2, 0.2, 10),
    gateWidthM: finite("gateWidthM", 1.2, 0, 12),
    panel: panel === "solid" || panel === "glass" || panel === "electronic" ? panel : "mesh",
  };
}

/** Two bays and an optional central gate, in metres, grounded at y=0. */
export function buildParametricFence(shape: FenceShape, materials: FenceMaterials): THREE.Group {
  const group = new THREE.Group();
  const { heightM: h, postSpacingM: spacing, gateWidthM: gate, panel } = shape;
  const box = (name: string, material: THREE.Material, w: number, height: number, depth: number, x: number, y: number, z = 0) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, height, depth), material);
    mesh.name = name;
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  };
  const halfGate = gate / 2;
  const posts = gate > 0 ? [-halfGate - spacing, -halfGate, halfGate, halfGate + spacing] : [-spacing, 0, spacing];
  for (const x of posts) {
    box("围栏立柱", materials.metal, 0.05, h, 0.05, x, h / 2);
    box("立柱底板", materials.dark, 0.1, 0.03, 0.1, x, 0.015);
  }
  const bays = [{ center: -halfGate - spacing / 2, width: spacing }, { center: halfGate + spacing / 2, width: spacing }];
  if (gate > 0) bays.push({ center: 0, width: gate });
  for (const { center, width } of bays) {
    const inner = width - 0.06;
    if (inner <= 0) continue;
    box("围栏横梁", materials.metal, inner, 0.04, 0.04, center, h - 0.04);
    box("围栏下梁", materials.metal, inner, 0.04, 0.04, center, 0.1);
    if (panel === "glass" || panel === "solid") {
      box("围栏面板", materials.panel, inner, h - 0.18, 0.02, center, h / 2 + 0.01);
    } else {
      const count = Math.max(1, Math.ceil(inner / 0.15));
      for (let i = 0; i < count; i++) {
        box("围栏网条", materials.metal, 0.016, h - 0.18, 0.016, center - inner / 2 + (i + 0.5) * inner / count, h / 2 + 0.01);
      }
      for (const ratio of [0.25, 0.5, 0.75]) box("围栏横筋", materials.metal, inner, 0.016, 0.02, center, h * ratio);
    }
    if (panel === "electronic") box("电子围栏警示线", materials.warning, inner, 0.02, 0.02, center, h - 0.1, 0.03);
  }
  return group;
}
