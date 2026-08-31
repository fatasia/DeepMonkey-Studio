export interface VisionLocalizationVector3 {
  x: number;
  y: number;
  z: number;
}

export interface VisionLocalizationDetection {
  label: string;
  confidence: number;
  /** x、y、宽、高；坐标语义由 bboxCoordinates 明确指定。 */
  bbox?: readonly [number, number, number, number];
}

export interface VisionCameraCalibration {
  cameraPosition: VisionLocalizationVector3;
  /** 相机坐标到场景坐标的 3×3 行主序旋转矩阵；相机轴为 x 向右、y 向下、z 向前。 */
  cameraToWorldRotation: readonly [number, number, number, number, number, number, number, number, number];
  intrinsics: { fx: number; fy: number; cx: number; cy: number };
  projectionPlane: { normal: VisionLocalizationVector3; constant: number };
  residualP95Pixels: number;
  verifiedAt: string;
  maxProjectionDistance?: number;
}

export interface VisionSceneAnchor {
  objectId: string;
  name: string;
  position: VisionLocalizationVector3;
  labels?: readonly string[];
}

export interface VisionEventLocalizationInput {
  sceneId: string;
  detection: VisionLocalizationDetection;
  image: { width: number; height: number };
  bboxCoordinates: "normalized" | "pixels";
  calibration?: VisionCameraCalibration;
  boundObjectIds?: readonly string[];
  anchors?: readonly VisionSceneAnchor[];
}

export interface VisionObjectLocalizationCandidate {
  objectId: string;
  confidence: number;
  distance?: number;
  evidence: string[];
}

export interface VisionEventLocalizationResult {
  status: "localized" | "review-required" | "unlocalized";
  method: "calibrated-ray-plane" | "bound-object-anchor" | "none";
  sceneId: string;
  position?: VisionLocalizationVector3;
  confidence: number;
  objectCandidates: VisionObjectLocalizationCandidate[];
  issues: string[];
  requiresHumanConfirmation: true;
  evidenceFingerprint: string;
  /** 定位是可视化证据，不得直接触发设备控制或关闭质量事件。 */
  operationalPolicy: "visualization-evidence-only";
}

/**
 * 将视觉框定位为可复核的三维候选。精确坐标只来自已标定相机；缺少标定时仅回退到显式绑定对象，
 * 不使用名称猜测伪造空间精度，也不会产生任何设备控制指令。
 */
export function localizeVisionEvent(input: VisionEventLocalizationInput): VisionEventLocalizationResult {
  validateInput(input);
  const anchors = [...(input.anchors ?? [])].sort((left, right) => left.objectId.localeCompare(right.objectId, "en"));
  const issues: string[] = [];
  const calibratedPosition = input.calibration && input.detection.bbox
    ? projectDetection(input)
    : undefined;
  if (!input.calibration) issues.push("缺少相机标定，只能使用任务显式绑定的对象锚点");
  else if (!input.detection.bbox) issues.push("检测结果缺少边界框，无法执行射线投影");
  else if (!calibratedPosition) issues.push("射线与投影平面无有效交点，请检查标定方向和投影范围");

  const objectCandidates = rankObjectCandidates(input, anchors, calibratedPosition);
  const boundFallback = !calibratedPosition ? chooseBoundFallback(input.boundObjectIds ?? [], anchors) : undefined;
  const position = calibratedPosition ?? boundFallback?.position;
  const method = calibratedPosition ? "calibrated-ray-plane" as const
    : boundFallback ? "bound-object-anchor" as const
      : "none" as const;
  const confidence = localizationConfidence(input, method, objectCandidates[0]?.confidence ?? 0);
  const status = method === "none" ? "unlocalized" as const
    : confidence >= 0.75 && objectCandidates.length === 1 ? "localized" as const
      : "review-required" as const;
  if (objectCandidates.length > 1 && objectCandidates[0] && objectCandidates[1]
    && objectCandidates[0].confidence - objectCandidates[1].confidence < 0.1) {
    issues.push("前两个对象候选接近，必须由用户确认目标对象");
  }
  if (method === "bound-object-anchor") issues.push("当前位置是绑定对象锚点，不代表缺陷在对象表面的精确位置");
  if (method === "none") issues.push("没有可用的标定交点或显式绑定对象锚点");

  const resultBase = {
    status,
    method,
    sceneId: input.sceneId,
    confidence,
    objectCandidates,
    issues,
    requiresHumanConfirmation: true as const,
    operationalPolicy: "visualization-evidence-only" as const,
  };
  return {
    ...resultBase,
    ...(position ? { position: roundedVector(position) } : {}),
    evidenceFingerprint: evidenceFingerprint({ input, result: resultBase, position }),
  };
}

function projectDetection(input: VisionEventLocalizationInput): VisionLocalizationVector3 | undefined {
  const calibration = input.calibration!;
  const [x, y, width, height] = input.detection.bbox!;
  const scaleX = input.bboxCoordinates === "normalized" ? input.image.width : 1;
  const scaleY = input.bboxCoordinates === "normalized" ? input.image.height : 1;
  const pixelX = (x + width / 2) * scaleX;
  const pixelY = (y + height / 2) * scaleY;
  const cameraRay = normalize({
    x: (pixelX - calibration.intrinsics.cx) / calibration.intrinsics.fx,
    y: (pixelY - calibration.intrinsics.cy) / calibration.intrinsics.fy,
    z: 1,
  });
  const worldRay = normalize(rotate(calibration.cameraToWorldRotation, cameraRay));
  const normal = normalize(calibration.projectionPlane.normal);
  const denominator = dot(normal, worldRay);
  if (Math.abs(denominator) < 1e-8) return undefined;
  const distance = -(dot(normal, calibration.cameraPosition) + calibration.projectionPlane.constant) / denominator;
  const maxDistance = calibration.maxProjectionDistance ?? 1_000;
  if (!Number.isFinite(distance) || distance <= 0 || distance > maxDistance) return undefined;
  return add(calibration.cameraPosition, scale(worldRay, distance));
}

function rankObjectCandidates(
  input: VisionEventLocalizationInput,
  anchors: readonly VisionSceneAnchor[],
  position: VisionLocalizationVector3 | undefined,
): VisionObjectLocalizationCandidate[] {
  const bound = new Set(input.boundObjectIds ?? []);
  return anchors.map((anchor) => {
    const distance = position ? vectorDistance(position, anchor.position) : undefined;
    const labelMatch = [anchor.name, ...(anchor.labels ?? [])].some((value) => normalized(value) === normalized(input.detection.label));
    const evidence: string[] = [];
    let score = 0;
    if (bound.has(anchor.objectId)) { score += 0.45; evidence.push("任务显式绑定对象"); }
    if (labelMatch) { score += 0.3; evidence.push("检测标签与对象标签一致"); }
    if (distance !== undefined) {
      const proximity = Math.max(0, 1 - distance / 20);
      score += proximity * 0.25;
      evidence.push(`投影点距对象锚点 ${round(distance)} m`);
    }
    return {
      objectId: anchor.objectId,
      confidence: round01(score * (0.6 + input.detection.confidence * 0.4)),
      ...(distance !== undefined ? { distance: round(distance) } : {}),
      evidence,
    };
  }).filter((candidate) => candidate.confidence >= 0.2)
    .sort((left, right) => right.confidence - left.confidence || left.objectId.localeCompare(right.objectId, "en"))
    .slice(0, 5);
}

function chooseBoundFallback(boundObjectIds: readonly string[], anchors: readonly VisionSceneAnchor[]): VisionSceneAnchor | undefined {
  const available = new Set(boundObjectIds);
  return anchors.find((anchor) => available.has(anchor.objectId));
}

function localizationConfidence(
  input: VisionEventLocalizationInput,
  method: VisionEventLocalizationResult["method"],
  objectConfidence: number,
): number {
  if (method === "none") return 0;
  if (method === "bound-object-anchor") return round01(Math.min(0.55, 0.25 + objectConfidence * 0.45));
  const residualQuality = Math.max(0, 1 - input.calibration!.residualP95Pixels / 50);
  return round01(input.detection.confidence * 0.55 + residualQuality * 0.3 + objectConfidence * 0.15);
}

function validateInput(input: VisionEventLocalizationInput): void {
  if (!input.sceneId.trim()) throw new Error("sceneId 不能为空");
  if (!input.detection.label.trim()) throw new Error("检测标签不能为空");
  if (!inUnitInterval(input.detection.confidence)) throw new Error("检测置信度必须在 0–1 范围内");
  if (!positive(input.image.width) || !positive(input.image.height)) throw new Error("图像尺寸必须为有限正数");
  if (input.detection.bbox?.some((value) => !Number.isFinite(value))) throw new Error("边界框必须为有限数值");
  if (input.detection.bbox && (input.detection.bbox[2] <= 0 || input.detection.bbox[3] <= 0)) throw new Error("边界框宽高必须为正数");
  if (!input.calibration) return;
  const calibration = input.calibration;
  if (![calibration.intrinsics.fx, calibration.intrinsics.fy].every(positive)) throw new Error("相机焦距参数必须为有限正数");
  if (!finiteVector(calibration.cameraPosition) || !finiteVector(calibration.projectionPlane.normal)) throw new Error("标定向量必须为有限数值");
  if (length(calibration.projectionPlane.normal) < 1e-8) throw new Error("投影平面法向量不能为零");
  if (calibration.cameraToWorldRotation.some((value) => !Number.isFinite(value))) throw new Error("旋转矩阵必须为有限数值");
  if (!Number.isFinite(calibration.residualP95Pixels) || calibration.residualP95Pixels < 0) throw new Error("标定残差不能为负数");
  if (!Number.isFinite(Date.parse(calibration.verifiedAt))) throw new Error("标定验证时间无效");
}

function rotate(matrix: VisionCameraCalibration["cameraToWorldRotation"], value: VisionLocalizationVector3): VisionLocalizationVector3 {
  return {
    x: matrix[0] * value.x + matrix[1] * value.y + matrix[2] * value.z,
    y: matrix[3] * value.x + matrix[4] * value.y + matrix[5] * value.z,
    z: matrix[6] * value.x + matrix[7] * value.y + matrix[8] * value.z,
  };
}

function normalized(value: string): string { return value.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/[^\p{L}\p{N}]+/gu, ""); }
function add(left: VisionLocalizationVector3, right: VisionLocalizationVector3): VisionLocalizationVector3 { return { x: left.x + right.x, y: left.y + right.y, z: left.z + right.z }; }
function scale(value: VisionLocalizationVector3, amount: number): VisionLocalizationVector3 { return { x: value.x * amount, y: value.y * amount, z: value.z * amount }; }
function dot(left: VisionLocalizationVector3, right: VisionLocalizationVector3): number { return left.x * right.x + left.y * right.y + left.z * right.z; }
function length(value: VisionLocalizationVector3): number { return Math.hypot(value.x, value.y, value.z); }
function normalize(value: VisionLocalizationVector3): VisionLocalizationVector3 { const size = length(value); return size > 1e-12 ? scale(value, 1 / size) : { x: 0, y: 0, z: 0 }; }
function vectorDistance(left: VisionLocalizationVector3, right: VisionLocalizationVector3): number { return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z); }
function finiteVector(value: VisionLocalizationVector3): boolean { return [value.x, value.y, value.z].every(Number.isFinite); }
function positive(value: number): boolean { return Number.isFinite(value) && value > 0; }
function inUnitInterval(value: number): boolean { return Number.isFinite(value) && value >= 0 && value <= 1; }
function round(value: number): number { return Math.round(value * 10_000) / 10_000; }
function round01(value: number): number { return round(Math.min(1, Math.max(0, value))); }
function roundedVector(value: VisionLocalizationVector3): VisionLocalizationVector3 { return { x: round(value.x), y: round(value.y), z: round(value.z) }; }

function evidenceFingerprint(value: unknown): string {
  const source = stableStringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}
