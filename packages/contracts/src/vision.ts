import type { Vector3Value } from "./geometry.js";

/** 视觉源、模型、任务、证据和质量复核合同。 */
export type VisionSourceKind = "image" | "video";
export type VisionSourceStatus = "online" | "offline" | "unknown";
export type VisionSourceProtocol = "upload" | "rtsp" | "rtmp" | "srt" | "hls" | "webrtc";
export type VisionPlaybackProtocol = "file" | "hls" | "webrtc";

export interface VisionSourceRecord {
  id: string;
  projectId: string;
  name: string;
  kind: VisionSourceKind;
  protocol?: VisionSourceProtocol;
  sourceUrl: string;
  assetId?: string;
  playbackUrl?: string;
  /** 浏览器播放和服务端抽帧协议可能不同，例如 WebRTC 通过同一网关的 HLS 出口抽帧。 */
  playbackProtocol?: VisionPlaybackProtocol;
  frameUrl?: string;
  fileName?: string;
  mimeType?: string;
  size?: number;
  status: VisionSourceStatus;
  createdAt: string;
  updatedAt: string;
}

export type VisionModelTask = "detection" | "classification";
export type VisionTensorLayout = "NCHW" | "NHWC";
export type VisionColorSpace = "RGB" | "BGR" | "GRAY";
export type VisionResizeMode = "stretch" | "letterbox" | "center-crop";
export type VisionOutputFormat = "classification-logits" | "ssd" | "yolo" | "yolo-nms" | "yolox" | "boxes-scores-labels";

export interface VisionModelManifest {
  schemaVersion: 1;
  name: string;
  version: string;
  task: VisionModelTask;
  input: {
    width: number;
    height: number;
    channels: 1 | 3;
    layout: VisionTensorLayout;
    color: VisionColorSpace;
    resize: VisionResizeMode;
    letterboxPosition?: "center" | "top-left";
    padding?: number[];
    dataType?: "float32" | "uint8";
    scale: number;
    mean?: number[];
    std?: number[];
    inputName?: string;
  };
  output: {
    format: VisionOutputFormat;
    outputNames?: string[];
    coordinates?: "normalized" | "input-pixels";
    nmsIncluded?: boolean;
  };
  labels: string[];
  threshold: number;
  iouThreshold?: number;
  license?: string;
  sourceUrl?: string;
}

export interface VisionModelRecord {
  id: string;
  projectId: string;
  name: string;
  version: string;
  task: VisionModelTask;
  manifest: VisionModelManifest;
  modelKey: string;
  size: number;
  status: "validating" | "ready" | "failed";
  message: string;
  createdAt: string;
  updatedAt: string;
}

export interface VisionModelPreset {
  id: string;
  name: string;
  description: string;
  category: "general" | "safety" | "quality";
  downloadUrl?: string;
  manifest: VisionModelManifest;
  readyToDownload: boolean;
}

export interface VisionPoint { x: number; y: number; }

export interface VisionTaskBinding {
  sceneId?: string;
  objectIds: string[];
  cameraViewId?: string;
  actions: Array<"highlight" | "focus" | "annotation" | "dashboard" | "message">;
}

/** Scene data is stored in right-handed Y-up metres; this projects authoring coordinates into that canonical space. */
export interface SceneCoordinateSystemState {
  unit: "m" | "cm" | "mm" | "ft";
  upAxis: "y" | "z";
  handedness: "right" | "left";
  origin: Vector3Value;
  epsg?: string;
}

export interface VisionQualityContext {
  stationId?: string;
  equipmentId?: string;
  productId?: string;
  recipeId?: string;
  orderId?: string;
  batchId?: string;
}

export interface VisionAggregationPolicy {
  minimumHits: number;
  windowFrames: number;
  deduplicateMs: number;
}

export type VisionExecutionProvider = "auto" | "directml" | "cpu";
export type VisionActiveExecutionProvider = "directml" | "cpu";

export interface VisionTaskRecord {
  id: string;
  projectId: string;
  name: string;
  mode: VisionSourceKind;
  sourceId?: string;
  modelId: string;
  enabled: boolean;
  inferenceFps: number;
  threshold: number;
  iouThreshold: number;
  executionProvider: VisionExecutionProvider;
  deviceId: number;
  activeExecutionProvider?: VisionActiveExecutionProvider;
  executionFallbackReason?: string;
  lastInferenceMs?: number;
  actualInferenceFps?: number;
  durationMs: number;
  cooldownMs: number;
  alertLabels?: string[];
  roi?: VisionPoint[];
  binding: VisionTaskBinding;
  qualityContext?: VisionQualityContext;
  aggregation?: VisionAggregationPolicy;
  status: "stopped" | "running" | "error";
  message: string;
  lastRunAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface VisionDetection {
  label: string;
  classId: number;
  confidence: number;
  bbox?: [number, number, number, number];
}

export interface VisionEvidenceFrame {
  capturedAt: string;
  detections: VisionDetection[];
}

export interface VisionQualityReview {
  verdict: "confirmed" | "false-positive" | "false-negative";
  groundTruthLabels: string[];
  disposition: "reinspect" | "isolate" | "release" | "rework" | "scrap";
  reviewer: string;
  reviewedAt: string;
  note?: string;
  qmsRef?: string;
  operationalCaseId?: string;
}

export interface VisionEventRecord {
  id: string;
  projectId: string;
  taskId: string;
  sourceType: VisionSourceKind;
  sourceId?: string;
  modelId: string;
  result: "ok" | "ng" | "detected";
  detections: VisionDetection[];
  imageUrl: string;
  sceneId?: string;
  objectIds: string[];
  status: "pending" | "confirmed" | "closed";
  note?: string;
  inferenceMs: number;
  executionProvider?: VisionActiveExecutionProvider;
  executionFallbackReason?: string;
  modelVersion?: string;
  qualityContext?: VisionQualityContext;
  evidenceFrames?: VisionEvidenceFrame[];
  aggregation?: { hits: number; frames: number };
  review?: VisionQualityReview;
  createdAt: string;
  updatedAt: string;
}

export interface VisionInferenceResponse {
  event: VisionEventRecord;
  imageWidth: number;
  imageHeight: number;
}
