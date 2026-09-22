import type { RenderPacket } from "@bim-studio/deep-engine";

const GRID_HALF_SIZE = 100;
const GRID_MINOR_STEP = 1;
const GRID_MAJOR_STEP = 10;
const GRID_Y = 0.002;

type GridLayer = {
  readonly id: string;
  readonly width: number;
  readonly alpha: number;
  readonly color: readonly [number, number, number];
  readonly coordinates: readonly number[];
  readonly axes: "both" | "x" | "z";
};

/**
 * 将作者辅助网格降低为普通 RenderPacket 绘制数据。
 * Three WebView 直接消费 scene.environment.gridVisible；Native 消费这里生成的保留 ID，
 * 因而不需要第二套宿主开关或特殊 GPU 管线。
 */
export function compileSceneAuxiliaryGrid(
  visible: boolean,
  origin: { readonly x: number; readonly y: number; readonly z: number } = { x: 0, y: 0, z: 0 },
): Pick<RenderPacket, "geometries" | "materials" | "instances"> {
  if (!visible) return { geometries: [], materials: [], instances: [] };
  const minor: number[] = [], major: number[] = [];
  for (let coordinate = -GRID_HALF_SIZE; coordinate <= GRID_HALF_SIZE; coordinate += GRID_MINOR_STEP) {
    if (coordinate === 0) continue;
    (coordinate % GRID_MAJOR_STEP === 0 ? major : minor).push(coordinate);
  }
  const layers: readonly GridLayer[] = [
    { id: "minor", width: 0.025, alpha: 0.075, color: [0.208, 0.323, 0.371], coordinates: minor, axes: "both" },
    { id: "major", width: 0.045, alpha: 0.18, color: [0.275, 0.407, 0.456], coordinates: major, axes: "both" },
    { id: "axis-x", width: 0.06, alpha: 0.46, color: [0.624, 0.122, 0.107], coordinates: [0], axes: "x" },
    { id: "axis-z", width: 0.06, alpha: 0.46, color: [0.078, 0.275, 0.546], coordinates: [0], axes: "z" },
  ];
  const geometries = layers.map(layer => gridGeometry(layer));
  const materials = layers.map(layer => ({
    id: `scene.auxiliary-grid.material.${layer.id}`,
    shadingModel: "unlit" as const,
    baseColor: layer.color,
    metallic: 0,
    roughness: 1,
    baseColorAlpha: layer.alpha,
    alphaMode: "BLEND" as const,
    doubleSided: true,
    fog: false,
  }));
  const transform = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0,
    origin.x, origin.y, origin.z, 1]);
  const instances = layers.map(layer => ({
    id: `scene.auxiliary-grid.instance.${layer.id}`,
    geometry: `scene.auxiliary-grid.geometry.${layer.id}`,
    material: `scene.auxiliary-grid.material.${layer.id}`,
    transform,
    castShadow: false,
    receiveShadow: false,
  }));
  return { geometries, materials, instances };
}

function gridGeometry(layer: GridLayer): RenderPacket["geometries"][number] {
  const quads = layer.coordinates.length * (layer.axes === "both" ? 2 : 1);
  const vertices = new Float32Array(quads * 4 * 6);
  const indices = new Uint32Array(quads * 6);
  let quad = 0;
  const write = (x0: number, z0: number, x1: number, z1: number, x2: number, z2: number, x3: number, z3: number) => {
    const vertex = quad * 24;
    vertices.set([x0, GRID_Y, z0, 0, 1, 0, x1, GRID_Y, z1, 0, 1, 0,
      x2, GRID_Y, z2, 0, 1, 0, x3, GRID_Y, z3, 0, 1, 0], vertex);
    const base = quad * 4;
    indices.set([base, base + 1, base + 2, base, base + 2, base + 3], quad * 6);
    quad += 1;
  };
  for (const coordinate of layer.coordinates) {
    const halfWidth = layer.width / 2;
    if (layer.axes === "both" || layer.axes === "x") {
      write(-GRID_HALF_SIZE, coordinate - halfWidth, -GRID_HALF_SIZE, coordinate + halfWidth,
        GRID_HALF_SIZE, coordinate + halfWidth, GRID_HALF_SIZE, coordinate - halfWidth);
    }
    if (layer.axes === "both" || layer.axes === "z") {
      write(coordinate - halfWidth, -GRID_HALF_SIZE, coordinate - halfWidth, GRID_HALF_SIZE,
        coordinate + halfWidth, GRID_HALF_SIZE, coordinate + halfWidth, -GRID_HALF_SIZE);
    }
  }
  return { id: `scene.auxiliary-grid.geometry.${layer.id}`, revision: 1, vertices, indices };
}
