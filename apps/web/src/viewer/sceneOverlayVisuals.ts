import * as THREE from "three";
import { disposeModelScreenTexture, isModelScreenTexture } from "./modelScreenTexture";
import type { MeasurementState, SceneAnnotationState } from "@bim-studio/contracts";
import { measurementAngle } from "./measurement";
import { isSharedPrimitiveGeometry } from "./primitiveGeometry";
import { isSharedPrimitiveMaterial, releaseSharedPrimitiveMaterial } from "./primitiveMaterial";
import { ellipsize, formatMeasurementState } from "./viewerStateUtils";
import { annotationLabelPresentation } from "./annotationLabelPresentation";
import type { AnnotationLabelLayoutCandidate } from "./annotationLabelLayout";
import { isSharedGltfResource, releaseSharedGltfObject, materialTextures } from "./sharedGltfAssets";

const ANNOTATION_LABEL_ROLE = "annotation-label";
const LABEL_CAMERA_POSITION = new THREE.Vector3();
const LABEL_ANCHOR_POSITION = new THREE.Vector3();
const LABEL_SCREEN_POSITION = new THREE.Vector3();

export function createMeasurementVisual(measurement: MeasurementState, preview: boolean): THREE.Group {
  const group = new THREE.Group();
  const kind = measurement.kind ?? "distance";
  const points = (measurement.points?.length ? measurement.points : [measurement.start, measurement.end])
    .map((point) => new THREE.Vector3(point.x, point.y, point.z));
  const start = points[0] ?? new THREE.Vector3();
  const end = points[1] ?? start;
  const distance = measurement.distance;
  const color = preview ? 0xf0d58d : 0xf6c453;
  const material = new THREE.LineBasicMaterial({ color, depthTest: false, transparent: preview, opacity: preview ? 0.75 : 1 });
  const linePoints = kind === "angle" && points[2] ? [start, end, start, points[2]] : [start, end];
  const line = kind === "angle" && points[2]
    ? new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(linePoints), material)
    : new THREE.Line(new THREE.BufferGeometry().setFromPoints(linePoints), material);
  line.renderOrder = 20;
  group.add(line);

  const extent = Math.max(...points.map((point) => point.distanceTo(start)), distance);
  const markerSize = Math.max(extent * 0.012, 0.035);
  for (const point of points) {
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(markerSize, 12, 8),
      new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: preview, opacity: preview ? 0.75 : 1 })
    );
    marker.position.copy(point);
    marker.renderOrder = 21;
    group.add(marker);
  }

  let labelPosition = start.clone().lerp(end, 0.5);
  if (kind === "angle" && points[2]) {
    const first = end.clone().sub(start);
    const second = points[2].clone().sub(start);
    const angle = measurement.angle ?? measurementAngle(start, end, points[2]);
    const radius = Math.max(Math.min(first.length(), second.length()) * 0.28, 0.15);
    const axis = new THREE.Vector3().crossVectors(first, second).normalize();
    if (axis.lengthSq() < 1e-8) axis.set(0, 1, 0);
    const direction = first.normalize();
    const arcPoints = Array.from({ length: 33 }, (_, index) => direction.clone()
      .applyQuaternion(new THREE.Quaternion().setFromAxisAngle(axis, angle * index / 32))
      .multiplyScalar(radius)
      .add(start));
    const arc = new THREE.Line(new THREE.BufferGeometry().setFromPoints(arcPoints), material.clone());
    arc.renderOrder = 20;
    group.add(arc);
    labelPosition = arcPoints[16]!.clone().sub(start).multiplyScalar(1.35).add(start);
  }
  if (kind === "elevation") labelPosition.copy(end).add(new THREE.Vector3(markerSize * 2, 0, 0));
  if (distance > 0.0001 || kind === "angle" || kind === "elevation") {
    const label = createMeasurementLabel(formatMeasurementState(measurement), color);
    label.position.copy(labelPosition);
    label.position.y += Math.max(markerSize * 2.5, 0.08);
    label.renderOrder = 22;
    group.add(label);
  }
  return group;
}

export function createAnnotationVisual(annotation: SceneAnnotationState, selected: boolean, dismissible = false): THREE.Group {
  const color = new THREE.Color(selected ? "#4d9fff" : annotation.color);
  const group = new THREE.Group();
  group.name = `annotation:${annotation.id}`;
  group.position.set(annotation.position.x, annotation.position.y, annotation.position.z);
  group.visible = annotation.visible;
  group.userData.annotationId = annotation.id;

  const size = annotation.size ?? 1;
  const pinHeight = 0.48 * size;
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, pinHeight, 0)]),
    new THREE.LineBasicMaterial({ color, depthTest: false })
  );
  line.renderOrder = 31;
  line.userData.annotationId = annotation.id;
  group.add(line);

  const marker = new THREE.Mesh(
    new THREE.SphereGeometry(0.075 * size, 16, 10),
    new THREE.MeshBasicMaterial({ color, depthTest: false })
  );
  marker.position.y = pinHeight;
  marker.renderOrder = 32;
  marker.userData.annotationId = annotation.id;
  group.add(marker);

  const sprite = createAnnotationLabel(annotation, selected, dismissible);
  sprite.position.y = pinHeight + 0.28 * size;
  sprite.userData.annotationId = annotation.id;
  sprite.renderOrder = 33;
  group.add(sprite);
  return group;
}

/** 相机移动时更新标签屏幕尺寸；只改变 Sprite 展示，不重建 CanvasTexture。 */
export function updateAnnotationVisualPresentation(
  id: string,
  group: THREE.Group,
  camera: THREE.PerspectiveCamera,
  viewportWidthPx: number,
  viewportHeightPx: number,
  selected: boolean,
): { sprite: THREE.Sprite; candidate: AnnotationLabelLayoutCandidate } | undefined {
  const sprite = group.children.find((child) => child.userData.overlayRole === ANNOTATION_LABEL_ROLE) as THREE.Sprite | undefined;
  if (!sprite) return undefined;
  const cameraPosition = camera.getWorldPosition(LABEL_CAMERA_POSITION);
  const anchorPosition = group.getWorldPosition(LABEL_ANCHOR_POSITION);
  const authoredSize = Number(sprite.userData.authoredSize) || 1;
  const presentation = annotationLabelPresentation({
    distance: cameraPosition.distanceTo(anchorPosition),
    verticalFovDegrees: camera.fov,
    viewportHeightPx,
    authoredSize,
    hasDescription: Boolean(sprite.userData.hasDescription),
    selected,
  });
  sprite.scale.set(
    Number(sprite.userData.baseWidth) * presentation.scaleMultiplier,
    Number(sprite.userData.baseHeight) * presentation.scaleMultiplier,
    1,
  );
  // 尺寸补偿只向标记点上方展开，避免远景标签反向盖住设备本体。
  sprite.position.y = 0.48 * authoredSize + sprite.scale.y * 0.5 + 0.04 * authoredSize;
  sprite.visible = presentation.visible;
  const material = sprite.material as THREE.SpriteMaterial;
  material.opacity = presentation.opacity;
  if (!presentation.visible) return undefined;

  // 碰撞避让必须用 Sprite 真实投影矩形：视空间深度换算像素尺寸，不复用 presentation 的
  // 估算高度（它对 authoredSize 做了 clamp，且假设固定 4:1 宽高比）。
  const labelViewPosition = sprite.getWorldPosition(LABEL_SCREEN_POSITION).applyMatrix4(camera.matrixWorldInverse);
  const viewDepth = -labelViewPosition.z;
  if (viewDepth <= 0.01) {
    // 相机正后方的标签投影会镜像回视口中心，参与碰撞会挡掉整屏标签；直接隐藏。
    sprite.visible = false;
    return undefined;
  }
  const worldHeightPerPixel = 2 * viewDepth
    * Math.tan(camera.fov * Math.PI / 360) / Math.max(viewportHeightPx, 1);
  const screenPosition = labelViewPosition.applyMatrix4(camera.projectionMatrix);
  return {
    sprite,
    candidate: {
      id,
      centerX: (screenPosition.x + 1) * Math.max(viewportWidthPx, 1) / 2,
      centerY: (1 - screenPosition.y) * Math.max(viewportHeightPx, 1) / 2,
      width: sprite.scale.x / worldHeightPerPixel,
      height: sprite.scale.y / worldHeightPerPixel,
      distance: cameraPosition.distanceTo(anchorPosition),
      selected,
    },
  };
}

/** 统一释放覆盖层几何、材质和 CanvasTexture，场景切换时不能留下 GPU 资源。 */
export function disposeViewerObject(object: THREE.Object3D): void {
  object.parent?.remove(object);
  const geometries = new Set<THREE.BufferGeometry>();
  const disposedMaterials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    // Three 的所有 Sprite 共享内部四边形几何；按实例销毁会让新标签继续引用已销毁的 WebGPU Buffer。
    if (mesh.geometry && !(child as THREE.Sprite).isSprite && !isSharedPrimitiveGeometry(mesh.geometry)
      && !isSharedGltfResource(mesh.geometry) && !geometries.has(mesh.geometry)) {
      geometries.add(mesh.geometry); mesh.geometry.dispose();
    }
    const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    materials.forEach((material) => {
      if (isSharedPrimitiveMaterial(material)) {
        releaseSharedPrimitiveMaterial(material);
        return;
      }
      if (disposedMaterials.has(material)) return;
      disposedMaterials.add(material);
      for (const texture of materialTextures(material)) {
        if (textures.has(texture) || isSharedGltfResource(texture)) continue;
        textures.add(texture);
        if (isModelScreenTexture(texture)) disposeModelScreenTexture(texture);
        else if (!releaseViewerLabelTexture(texture)) texture.dispose();
      }
      material.dispose();
    });
  });
  releaseSharedGltfObject(object);
}

// 标签画布布局常量：画布高度固定 160（对应 0.6 世界高的既有语义），宽度随文本实测收缩，
// 避免"设备 001"这类短文本在 640 宽底板上留下大片空板，近景时读感像残影。
const LABEL_CANVAS_HEIGHT = 160;
const LABEL_TITLE_FONT_PX = 52;
const LABEL_DESCRIPTION_FONT_PX = 34;
const LABEL_MIN_CANVAS_WIDTH = 224;
const LABEL_MAX_CANVAS_WIDTH = 1024;
const LABEL_TEXT_LEFT_PX = 36;
const LABEL_CLOSE_ZONE_PX = 64;
const LABEL_TAIL_PADDING_PX = 28;
const LABEL_WIDTH_STEP_PX = 16;

const labelTitleFont = `600 ${LABEL_TITLE_FONT_PX}px "Microsoft YaHei UI", "Segoe UI", sans-serif`;
const labelDescriptionFont = `400 ${LABEL_DESCRIPTION_FONT_PX}px "Microsoft YaHei UI", "Segoe UI", sans-serif`;

/** 依文本实测宽度计算画布宽；上限防止超长描述把底板拉成横幅。 */
export function annotationLabelCanvasWidth(titleWidthPx: number, descriptionWidthPx: number, dismissible: boolean): number {
  const textWidth = Math.max(titleWidthPx, descriptionWidthPx, 0);
  const contentWidth = LABEL_TEXT_LEFT_PX + textWidth + (dismissible ? LABEL_CLOSE_ZONE_PX : LABEL_TAIL_PADDING_PX) + LABEL_TEXT_LEFT_PX / 2;
  const stepped = Math.ceil(contentWidth / LABEL_WIDTH_STEP_PX) * LABEL_WIDTH_STEP_PX;
  return Math.min(Math.max(stepped, LABEL_MIN_CANVAS_WIDTH), LABEL_MAX_CANVAS_WIDTH);
}

/** 按像素宽度截断文本（省略号结尾）；调用前需已设置 context.font。 */
function fitLabelText(context: CanvasRenderingContext2D, text: string, maxWidthPx: number, charWidthPx: number): string {
  if (measureLabelText(context, text, charWidthPx) <= maxWidthPx) return text;
  let end = text.length - 1;
  while (end > 0 && measureLabelText(context, `${text.slice(0, end)}…`, charWidthPx) > maxWidthPx) end -= 1;
  return end > 0 ? `${text.slice(0, end)}…` : "…";
}

/** 无 measureText 的环境（部分单测桩）按平均字宽估算，保证可量测。 */
function measureLabelText(context: CanvasRenderingContext2D, text: string, charWidthPx: number): number {
  if (typeof context.measureText === "function") return context.measureText(text).width;
  return [...text].length * charWidthPx;
}

function createAnnotationLabel(annotation: SceneAnnotationState, selected: boolean, dismissible: boolean): THREE.Sprite {
  const textureKey = [
    annotation.name,
    annotation.description ?? "",
    annotation.color,
    selected ? "selected" : "normal",
    dismissible ? "dismissible" : "fixed",
  ].join("\u001f");
  const canvas = labelCanvas(LABEL_MAX_CANVAS_WIDTH, LABEL_CANVAS_HEIGHT);
  const context = canvas.getContext("2d");
  let canvasWidth = 640;
  if (context) {
    const title = ellipsize(annotation.name, 16);
    const description = annotation.description ? ellipsize(annotation.description, 26) : "";
    // 量测必须先设置对应字号：context 初始为 10px 默认字体，直接量会把画布算成最小宽。
    context.font = labelTitleFont;
    const titleWidth = measureLabelText(context, title, LABEL_TITLE_FONT_PX * 0.55);
    context.font = labelDescriptionFont;
    const descriptionWidth = description ? measureLabelText(context, description, LABEL_DESCRIPTION_FONT_PX * 0.55) : 0;
    canvasWidth = annotationLabelCanvasWidth(titleWidth, descriptionWidth, dismissible);
    canvas.width = canvasWidth;
    const textWidthLimit = canvasWidth - LABEL_TEXT_LEFT_PX - (dismissible ? LABEL_CLOSE_ZONE_PX : LABEL_TAIL_PADDING_PX);
    // 青绿细框表达选择，左侧状态条保留作者配置色，避免整块彩色标签遮挡模型。
    roundedPanel(context, 6, 6, canvasWidth - 12, LABEL_CANVAS_HEIGHT - 12, 16, "rgba(9, 16, 20, .88)");
    context.strokeStyle = selected ? "#3ec6c1" : "rgba(167, 183, 190, .28)";
    context.lineWidth = selected ? 6 : 2;
    context.stroke();
    const hasDescription = Boolean(description);
    roundedPanel(context, 18, hasDescription ? 26 : 48, 6, hasDescription ? 108 : 64, 3, annotation.color);
    context.textAlign = "left";
    context.textBaseline = "middle";
    context.fillStyle = "#e6ecef";
    context.font = labelTitleFont;
    context.fillText(fitLabelText(context, title, textWidthLimit, LABEL_TITLE_FONT_PX * 0.55), LABEL_TEXT_LEFT_PX, hasDescription ? 56 : 80);
    if (description) {
      context.fillStyle = "#9daab1";
      context.font = labelDescriptionFont;
      context.fillText(fitLabelText(context, description, textWidthLimit, LABEL_DESCRIPTION_FONT_PX * 0.55), LABEL_TEXT_LEFT_PX, 116);
    }
    if (dismissible) {
      context.fillStyle = "#c5cdd2";
      context.font = '600 44px "Segoe UI", sans-serif';
      context.textAlign = "center";
      context.fillText("×", canvasWidth - LABEL_CLOSE_ZONE_PX / 2 - 8, hasDescription ? 56 : 80);
    }
  }
  const size = annotation.size ?? 1;
  const baseHeight = 0.6 * size;
  const baseWidth = baseHeight * canvasWidth / LABEL_CANVAS_HEIGHT;
  const sprite = canvasSprite(canvas, baseWidth, baseHeight, textureKey);
  sprite.userData.overlayRole = ANNOTATION_LABEL_ROLE;
  sprite.userData.authoredSize = size;
  sprite.userData.baseWidth = baseWidth;
  sprite.userData.baseHeight = baseHeight;
  sprite.userData.hasDescription = Boolean(annotation.description);
  sprite.userData.dismissible = dismissible;
  return sprite;
}

function createMeasurementLabel(text: string, color: number): THREE.Sprite {
  const canvas = labelCanvas(360, 96);
  const context = canvas.getContext("2d");
  if (context) {
    roundedPanel(context, 4, 4, 352, 88, 18, "rgba(22, 25, 27, .92)");
    context.strokeStyle = `#${color.toString(16).padStart(6, "0")}`;
    context.lineWidth = 4;
    context.stroke();
    context.fillStyle = "#f8f2e6";
    context.font = '600 36px "Segoe UI", sans-serif';
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(text, 180, 49);
  }
  return canvasSprite(canvas, 1.8, 0.48);
}

function labelCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function roundedPanel(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number, color: string): void {
  context.fillStyle = color;
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
  context.fill();
}

function canvasSprite(canvas: HTMLCanvasElement, width: number, height: number, textureKey?: string): THREE.Sprite {
  const texture = textureKey ? acquireLabelTexture(textureKey, canvas) : new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: texture,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    alphaTest: 0.03,
  }));
  sprite.scale.set(width, height, 1);
  return sprite;
}

/**
 * 标签通常只在选中态和场景切换时重建。保留少量最近使用的 CanvasTexture，
 * 避免 WebGPU 在 GPU 队列尚未完成时反复上传同一张标签图，同时用上限控制长期内存。
 */
const MAX_LABEL_TEXTURES = 64;
const labelTextureCache = new Map<string, { texture: THREE.CanvasTexture; refs: number; lastUsed: number }>();

function acquireLabelTexture(key: string, canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const cached = labelTextureCache.get(key);
  if (cached) {
    cached.refs += 1;
    cached.lastUsed = performance.now();
    return cached.texture;
  }
  const texture = new THREE.CanvasTexture(canvas);
  labelTextureCache.set(key, { texture, refs: 1, lastUsed: performance.now() });
  texture.userData.viewerLabelTextureKey = key;
  evictLabelTextures();
  return texture;
}

/** 在覆盖层对象释放时减少引用；缓存条目会在超出上限且无人使用时淘汰。 */
export function releaseViewerLabelTexture(texture: THREE.Texture): boolean {
  const key = texture.userData.viewerLabelTextureKey as string | undefined;
  if (!key) return false;
  const cached = labelTextureCache.get(key);
  if (!cached || cached.texture !== texture) return false;
  cached.refs = Math.max(0, cached.refs - 1);
  cached.lastUsed = performance.now();
  evictLabelTextures();
  return true;
}

function evictLabelTextures(): void {
  if (labelTextureCache.size <= MAX_LABEL_TEXTURES) return;
  const candidates = [...labelTextureCache.entries()]
    .filter(([, entry]) => entry.refs === 0)
    .sort(([, left], [, right]) => left.lastUsed - right.lastUsed);
  for (const [key, entry] of candidates) {
    if (labelTextureCache.size <= MAX_LABEL_TEXTURES) break;
    entry.texture.dispose();
    labelTextureCache.delete(key);
  }
}
