import * as THREE from "three";

const GRID_WORLD_SIZE = 200;
const GRID_TEXTURE_SIZE = 1024;
const MINOR_STEP = 1;
const MAJOR_STEP = 10;

export interface SceneGridLayout {
  worldSize: number;
  textureSize: number;
  minorStep: number;
  majorStep: number;
}

/** 工业场景网格的稳定语义；渲染实现和测试共用，避免后端专属魔数。 */
export function sceneGridLayout(): SceneGridLayout {
  return {
    worldSize: GRID_WORLD_SIZE,
    textureSize: GRID_TEXTURE_SIZE,
    minorStep: MINOR_STEP,
    majorStep: MAJOR_STEP,
  };
}

/**
 * 使用同一张带 mipmap 的纹理表达主/次网格和坐标轴。
 * 相比 LineSegments，可消除 WebGL/WebGPU 在线覆盖率上的差异，并降低远景摩尔纹。
 */
export function createSceneGrid(): THREE.Mesh {
  const layout = sceneGridLayout();
  const canvas = document.createElement("canvas");
  canvas.width = layout.textureSize;
  canvas.height = layout.textureSize;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建场景网格画布");

  drawGridLines(context, layout);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 8;

  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    side: THREE.DoubleSide,
  });
  const grid = new THREE.Mesh(new THREE.PlaneGeometry(layout.worldSize, layout.worldSize), material);
  grid.name = "helper:grid";
  grid.rotation.x = -Math.PI / 2;
  grid.position.y = 0.002;
  grid.renderOrder = -10;
  return grid;
}

function drawGridLines(context: CanvasRenderingContext2D, layout: SceneGridLayout): void {
  const half = layout.worldSize / 2;
  for (let coordinate = -half; coordinate <= half; coordinate += layout.minorStep) {
    if (coordinate % layout.majorStep === 0) continue;
    const pixel = worldToPixel(coordinate, layout);
    drawLine(context, pixel, false, "rgba(123, 133, 141, .12)");
    drawLine(context, pixel, true, "rgba(123, 133, 141, .12)");
  }
  for (let coordinate = -half; coordinate <= half; coordinate += layout.majorStep) {
    if (coordinate === 0) continue;
    const pixel = worldToPixel(coordinate, layout);
    drawLine(context, pixel, false, "rgba(156, 166, 172, .32)", 1.4);
    drawLine(context, pixel, true, "rgba(156, 166, 172, .32)", 1.4);
  }
  const center = worldToPixel(0, layout);
  drawLine(context, center, false, "rgba(191, 89, 89, .68)", 2);
  drawLine(context, center, true, "rgba(78, 128, 190, .68)", 2);
}

function worldToPixel(coordinate: number, layout: SceneGridLayout): number {
  return ((coordinate + layout.worldSize / 2) / layout.worldSize) * layout.textureSize;
}

function drawLine(
  context: CanvasRenderingContext2D,
  pixel: number,
  horizontal: boolean,
  color: string,
  width = 1,
): void {
  context.beginPath();
  context.strokeStyle = color;
  context.lineWidth = width;
  if (horizontal) {
    context.moveTo(0, pixel);
    context.lineTo(context.canvas.width, pixel);
  } else {
    context.moveTo(pixel, 0);
    context.lineTo(pixel, context.canvas.height);
  }
  context.stroke();
}
