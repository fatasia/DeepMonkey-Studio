import * as THREE from "three";
import { disposeModelScreenTexture, isModelScreenTexture } from "./modelScreenTexture";
import type { MeasurementState, SceneAnnotationState } from "@bim-studio/contracts";
import { measurementAngle } from "./measurement";
import { isSharedPrimitiveGeometry } from "./primitiveGeometry";
import { isSharedPrimitiveMaterial, releaseSharedPrimitiveMaterial } from "./primitiveMaterial";
import { ellipsize, formatMeasurementState } from "./viewerStateUtils";
import { annotationLabelPresentation } from "./annotationLabelPresentation";
import type { AnnotationLabelLayoutCandidate } from "./annotationLabelLayout";

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

  const screenPosition = sprite.getWorldPosition(LABEL_SCREEN_POSITION).project(camera);
  const height = presentation.estimatedHeightPx;
  const width = height * Number(sprite.userData.baseWidth) / Number(sprite.userData.baseHeight);
  return {
    sprite,
    candidate: {
      id,
      centerX: (screenPosition.x + 1) * Math.max(viewportWidthPx, 1) / 2,
      centerY: (1 - screenPosition.y) * Math.max(viewportHeightPx, 1) / 2,
      width,
      height,
      distance: cameraPosition.distanceTo(anchorPosition),
      selected,
    },
  };
}

/** 统一释放覆盖层几何、材质和 CanvasTexture，场景切换时不能留下 GPU 资源。 */
export function disposeViewerObject(object: THREE.Object3D): void {
  object.parent?.remove(object);
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    // Three 的所有 Sprite 共享内部四边形几何；按实例销毁会让新标签继续引用已销毁的 WebGPU Buffer。
    if (mesh.geometry && !(child as THREE.Sprite).isSprite && !isSharedPrimitiveGeometry(mesh.geometry)) mesh.geometry.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    materials.forEach((material) => {
      if (isSharedPrimitiveMaterial(material)) {
        releaseSharedPrimitiveMaterial(material);
        return;
      }
      const withMap = material as THREE.Material & { map?: THREE.Texture };
      if (isModelScreenTexture(withMap.map)) disposeModelScreenTexture(withMap.map);
      else if (!withMap.map || !releaseViewerLabelTexture(withMap.map)) withMap.map?.dispose();
      material.dispose();
    });
  });
}

function createAnnotationLabel(annotation: SceneAnnotationState, selected: boolean, dismissible: boolean): THREE.Sprite {
  const textureKey = [
    annotation.name,
    annotation.description ?? "",
    annotation.color,
    selected ? "selected" : "normal",
    dismissible ? "dismissible" : "fixed",
  ].join("\u001f");
  const canvas = labelCanvas(640, 160);
  const context = canvas.getContext("2d");
  if (context) {
    roundedPanel(context, 8, 8, 624, 144, 24, "rgba(20, 25, 29, .96)");
    context.strokeStyle = selected ? "#4d9fff" : annotation.color;
    context.lineWidth = selected ? 8 : 5;
    context.stroke();
    // 选中蓝框表达交互状态，左侧色条继续表达作者配置的设备/告警状态色。
    roundedPanel(context, 18, 34, 7, 92, 3, annotation.color);
    context.fillStyle = "#f5f7f8";
    context.font = '700 46px "Microsoft YaHei", "Segoe UI", sans-serif';
    context.textAlign = "left";
    context.textBaseline = "middle";
    context.fillText(ellipsize(annotation.name, 16), 34, annotation.description ? 61 : 81);
    if (annotation.description) {
      context.fillStyle = "#9ea9b0";
      context.font = '400 28px "Microsoft YaHei", "Segoe UI", sans-serif';
      context.fillText(ellipsize(annotation.description, 26), 34, 113);
    }
    if (dismissible) {
      context.fillStyle = "#c5cdd2";
      context.font = '600 38px "Segoe UI", sans-serif';
      context.textAlign = "center";
      context.fillText("×", 593, 61);
    }
  }
  const size = annotation.size ?? 1;
  const sprite = canvasSprite(canvas, 2.4 * size, 0.6 * size, textureKey);
  sprite.userData.overlayRole = ANNOTATION_LABEL_ROLE;
  sprite.userData.authoredSize = size;
  sprite.userData.baseWidth = 2.4 * size;
  sprite.userData.baseHeight = 0.6 * size;
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
