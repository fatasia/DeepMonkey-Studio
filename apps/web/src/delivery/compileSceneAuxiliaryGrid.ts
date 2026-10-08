import type { RenderPacket } from "@bim-studio/deep-engine";

const HALF = 100, SIZE = 256, Y = 0.002;
type Texture = NonNullable<RenderPacket["textures"]>[number];
const layers = [
  { id: "minor", width: 200 / 2048, alpha: .07, color: [.208, .323, .371], axis: false },
  { id: "major", width: 1.2 * 200 / 2048, alpha: .17, color: [.275, .407, .456], axis: false },
  { id: "axis-x", width: 1.5 * 200 / 2048, alpha: .46, color: [.624, .122, .107], axis: true },
  { id: "axis-z", width: 1.5 * 200 / 2048, alpha: .46, color: [.078, .275, .546], axis: true },
] as const;

/** Pixel-area coverage survives minification; thin geometry cannot be mip filtered. */
function gridTexture(layer: typeof layers[number]): Texture {
  const height = layer.axis ? 1 : SIZE, period = layer.axis ? 2 : 10;
  const coordinates = layer.id === "minor" ? [1,2,3,4,5,6,7,8,9] : layer.axis ? [1] : [0,10];
  const coverage = (pixel: number) => {
    const start = pixel * period / SIZE, end = (pixel + 1) * period / SIZE;
    return Math.min(1, coordinates.reduce((sum, c) => sum + Math.max(0,
      Math.min(end, c + layer.width / 2) - Math.max(start, c - layer.width / 2)), 0) / (end - start));
  };
  const data = new Uint8Array(SIZE * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < SIZE; x++) {
    const a = coverage(x), b = layer.axis ? 0 : coverage(y), offset = (y * SIZE + x) * 4;
    data.set([255, 255, 255, Math.round(255 * (a + b - a * b))], offset);
  }
  const mipmaps: { width: number; height: number; data: Uint8Array }[] = [];
  let previous = { width: SIZE, height, data };
  while (previous.width > 1 || previous.height > 1) {
    const width = Math.max(1, previous.width / 2), height = Math.max(1, previous.height / 2);
    const data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      let alpha = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++)
        alpha += previous.data[(Math.min(previous.height - 1, y * 2 + dy) * previous.width + Math.min(previous.width - 1, x * 2 + dx)) * 4 + 3]!;
      data.set([255,255,255,Math.round(alpha / 4)], (y * width + x) * 4);
    }
    previous = { width, height, data }; mipmaps.push(previous);
  }
  return { id: `scene.auxiliary-grid.texture.${layer.id}`, revision: 1, semantic: "baseColor", width: SIZE,
    height, data, mipmaps, sampler: { addressModeU: layer.axis ? "clamp-to-edge" : "repeat",
      addressModeV: layer.axis ? "clamp-to-edge" : "repeat", magFilter: "linear", minFilter: "linear",
      mipmapFilter: "linear", maxAnisotropy: 8 } };
}

// Immutable compiler-owned pixels are shared across scene versions.
let textures: Texture[] | undefined;
export function compileSceneAuxiliaryGrid(visible: boolean,
  origin: { readonly x: number; readonly y: number; readonly z: number } = { x: 0, y: 0, z: 0 },
): Pick<RenderPacket, "geometries" | "materials" | "instances" | "textures"> {
  if (!visible) return { geometries: [], materials: [], instances: [] };
  textures ??= layers.map(gridTexture);
  const geometries = layers.map(layer => {
    // Match sceneGrid's Canvas plane: its red center column runs along world Z.
    const x = layer.id === "axis-x" ? 1 : HALF, z = layer.id === "axis-z" ? 1 : HALF;
    const vertices = new Float32Array([-x,Y,-z,0,1,0, -x,Y,z,0,1,0, x,Y,z,0,1,0, x,Y,-z,0,1,0]);
    const uv0 = new Float32Array(layer.id === "axis-z" ? [0,0,1,0,1,1,0,1]
      : layer.id === "axis-x" ? [0,0,0,1,1,1,1,0] : [0,0,0,20,20,20,20,0]);
    return { id: `scene.auxiliary-grid.geometry.${layer.id}`, revision: 1, vertices, uv0,
      indices: new Uint32Array([0,1,2,0,2,3]) };
  });
  const materials = layers.map(layer => ({ id: `scene.auxiliary-grid.material.${layer.id}`,
    shadingModel: "unlit" as const, baseColor: layer.color, metallic: 0, roughness: 1,
    baseColorAlpha: layer.alpha, alphaMode: "BLEND" as const, doubleSided: true, fog: true,
    baseColorTexture: { texture: `scene.auxiliary-grid.texture.${layer.id}` } }));
  const transform = new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,origin.x,origin.y,origin.z,1]);
  const instances = layers.map(layer => ({ id: `scene.auxiliary-grid.instance.${layer.id}`,
    geometry: `scene.auxiliary-grid.geometry.${layer.id}`, material: `scene.auxiliary-grid.material.${layer.id}`,
    transform, castShadow: false, receiveShadow: false }));
  return { geometries, materials, instances, textures };
}
