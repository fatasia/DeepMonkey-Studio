/** 视觉输入预处理、ONNX 输出解析与视频帧抓取；保持推理细节脱离任务编排。 */
import { spawn } from "node:child_process";
import { gunzipSync } from "node:zlib";
import sharp from "sharp";
import * as ort from "onnxruntime-node";
import type { VisionDetection, VisionModelManifest } from "@bim-studio/contracts";

export async function prepareImage(
  buffer: Buffer,
  manifest: VisionModelManifest,
): Promise<{ data: Float32Array | Uint8Array; dims: number[]; originalWidth: number; originalHeight: number }> {
  const metadata = await sharp(buffer, { failOn: "error" }).metadata();
  const originalWidth = metadata.width ?? manifest.input.width;
  const originalHeight = metadata.height ?? manifest.input.height;
  const fit = manifest.input.resize === "letterbox" ? "contain" : manifest.input.resize === "center-crop" ? "cover" : "fill";
  const padding = manifest.input.padding ?? [0, 0, 0];
  let pipelineImage = sharp(buffer, { failOn: "error" }).resize(manifest.input.width, manifest.input.height, {
    fit,
    position: manifest.input.letterboxPosition === "top-left" ? "northwest" : "centre",
    background: { r: padding[0] ?? 0, g: padding[1] ?? padding[0] ?? 0, b: padding[2] ?? padding[0] ?? 0, alpha: 1 },
  });
  pipelineImage = manifest.input.channels === 1 ? pipelineImage.greyscale() : pipelineImage.removeAlpha().toColourspace("srgb");
  const raw = await pipelineImage.raw().toBuffer();
  const { width, height, channels } = { width: manifest.input.width, height: manifest.input.height, channels: manifest.input.channels };
  const data = manifest.input.dataType === "uint8" ? new Uint8Array(width * height * channels) : new Float32Array(width * height * channels);
  const mean = manifest.input.mean ?? Array(channels).fill(0);
  const std = manifest.input.std ?? Array(channels).fill(1);
  const channelIndex = (channel: number) => (manifest.input.color === "BGR" && channels === 3 ? 2 - channel : channel);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1)
      for (let c = 0; c < channels; c += 1) {
        const value = (raw[(y * width + x) * channels + channelIndex(c)] ?? 0) * manifest.input.scale;
        const normalized = manifest.input.dataType === "uint8" ? clamp(Math.round(value), 0, 255) : (value - (mean[c] ?? 0)) / (std[c] || 1);
        const index = manifest.input.layout === "NCHW" ? c * width * height + y * width + x : (y * width + x) * channels + c;
        data[index] = normalized;
      }
  return { data, dims: manifest.input.layout === "NCHW" ? [1, channels, height, width] : [1, height, width, channels], originalWidth, originalHeight };
}

export function parseOutputs(outputs: ort.InferenceSession.OnnxValueMapType, manifest: VisionModelManifest, threshold: number, iouThreshold: number): VisionDetection[] {
  const tensors = Object.entries(outputs).filter((entry): entry is [string, ort.Tensor] => entry[1] instanceof ort.Tensor);
  if (!tensors.length) return [];
  const firstTensor = tensors[0]?.[1];
  if (!firstTensor) return [];
  if (manifest.output.format === "classification-logits") {
    const values = toNumbers(firstTensor.data);
    const probabilities = softmax(values);
    return probabilities
      .map((confidence, classId) => ({ label: manifest.labels[classId] ?? `class-${classId}`, classId, confidence }))
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 5);
  }
  if (manifest.output.format === "ssd") return parseSsd(tensors, manifest, threshold);
  if (manifest.output.format === "boxes-scores-labels") return parseBoxesScoresLabels(tensors, manifest, threshold);
  if (manifest.output.format === "yolo-nms") return parseYoloNms(firstTensor, manifest, threshold);
  if (manifest.output.format === "yolo") return nonMaximumSuppression(parseYolo(firstTensor, manifest, threshold), iouThreshold);
  return nonMaximumSuppression(parseYolox(firstTensor, manifest, threshold), iouThreshold);
}

function parseSsd(tensors: Array<[string, ort.Tensor]>, manifest: VisionModelManifest, threshold: number): VisionDetection[] {
  const byName = (pattern: RegExp) => tensors.find(([name]) => pattern.test(name))?.[1];
  const boxes = byName(/box/i) ?? tensors.find(([, tensor]) => tensor.dims.at(-1) === 4)?.[1];
  const scores = byName(/score/i) ?? tensors.find(([, tensor]) => tensor !== boxes && tensor.type.includes("float"))?.[1];
  const labels = byName(/class|label/i) ?? tensors.find(([, tensor]) => tensor.type.includes("int"))?.[1];
  if (!boxes || !scores || !labels) throw new Error(`SSD输出无法识别：${tensors.map(([name]) => name).join(", ")}`);
  const boxValues = toNumbers(boxes.data),
    scoreValues = toNumbers(scores.data),
    labelValues = toNumbers(labels.data);
  const detections: VisionDetection[] = [];
  for (let index = 0; index < Math.min(scoreValues.length, labelValues.length, Math.floor(boxValues.length / 4)); index += 1) {
    const confidence = scoreValues[index] ?? 0;
    if (confidence < threshold) continue;
    const classId = Math.max(0, Math.round(labelValues[index] ?? 0) - 1);
    const y1 = boxValues[index * 4] ?? 0,
      x1 = boxValues[index * 4 + 1] ?? 0,
      y2 = boxValues[index * 4 + 2] ?? 0,
      x2 = boxValues[index * 4 + 3] ?? 0;
    detections.push({ label: manifest.labels[classId] ?? `class-${classId}`, classId, confidence, bbox: [clamp(x1, 0, 1), clamp(y1, 0, 1), clamp(x2, 0, 1), clamp(y2, 0, 1)] });
  }
  return detections;
}

function parseBoxesScoresLabels(tensors: Array<[string, ort.Tensor]>, manifest: VisionModelManifest, threshold: number): VisionDetection[] {
  const boxes = tensors.find(([name, tensor]) => /box/i.test(name) || tensor.dims.at(-1) === 4)?.[1];
  const scores = tensors.find(([name]) => /score/i.test(name))?.[1];
  const labels = tensors.find(([name]) => /class|label/i.test(name))?.[1];
  if (!boxes || !scores || !labels) throw new Error("boxes-scores-labels输出缺少boxes、scores或labels");
  const boxValues = toNumbers(boxes.data),
    scoreValues = toNumbers(scores.data),
    labelValues = toNumbers(labels.data);
  return scoreValues.flatMap((confidence, index) => {
    if (confidence < threshold || index * 4 + 3 >= boxValues.length) return [];
    const classId = Math.round(labelValues[index] ?? 0);
    let x1 = boxValues[index * 4] ?? 0,
      y1 = boxValues[index * 4 + 1] ?? 0,
      x2 = boxValues[index * 4 + 2] ?? 0,
      y2 = boxValues[index * 4 + 3] ?? 0;
    if (manifest.output.coordinates !== "normalized") {
      x1 /= manifest.input.width;
      x2 /= manifest.input.width;
      y1 /= manifest.input.height;
      y2 /= manifest.input.height;
    }
    return [
      {
        label: manifest.labels[classId] ?? `class-${classId}`,
        classId,
        confidence,
        bbox: [clamp(x1, 0, 1), clamp(y1, 0, 1), clamp(x2, 0, 1), clamp(y2, 0, 1)] as [number, number, number, number],
      },
    ];
  });
}

function parseYolox(tensor: ort.Tensor, manifest: VisionModelManifest, threshold: number): VisionDetection[] {
  const values = toNumbers(tensor.data);
  const stride = manifest.labels.length + 5;
  const rows = Math.floor(values.length / stride);
  const grid = yoloxGrid(manifest.input.width, manifest.input.height, rows);
  const detections: VisionDetection[] = [];
  for (let row = 0; row < rows; row += 1) {
    const offset = row * stride;
    const objectness = values[offset + 4] ?? 0;
    let classId = 0,
      classScore = 0;
    for (let index = 0; index < manifest.labels.length; index += 1) {
      const score = values[offset + 5 + index] ?? 0;
      if (score > classScore) {
        classScore = score;
        classId = index;
      }
    }
    const confidence = objectness * classScore;
    if (confidence < threshold) continue;
    const cell = grid[row];
    if (!cell) continue;
    const cx = ((values[offset] ?? 0) + cell.x) * cell.stride;
    const cy = ((values[offset + 1] ?? 0) + cell.y) * cell.stride;
    const width = Math.exp(values[offset + 2] ?? 0) * cell.stride;
    const height = Math.exp(values[offset + 3] ?? 0) * cell.stride;
    const scaleX = manifest.output.coordinates === "normalized" ? 1 : manifest.input.width;
    const scaleY = manifest.output.coordinates === "normalized" ? 1 : manifest.input.height;
    detections.push({
      label: manifest.labels[classId] ?? `class-${classId}`,
      classId,
      confidence,
      bbox: [clamp((cx - width / 2) / scaleX, 0, 1), clamp((cy - height / 2) / scaleY, 0, 1), clamp((cx + width / 2) / scaleX, 0, 1), clamp((cy + height / 2) / scaleY, 0, 1)],
    });
  }
  return detections;
}

function yoloxGrid(width: number, height: number, rows: number): Array<{ x: number; y: number; stride: number }> {
  for (const strides of [
    [8, 16, 32],
    [8, 16, 32, 64],
  ]) {
    const expected = strides.reduce((sum, stride) => sum + Math.floor(width / stride) * Math.floor(height / stride), 0);
    if (expected !== rows) continue;
    return strides.flatMap((stride) =>
      Array.from({ length: Math.floor(height / stride) * Math.floor(width / stride) }, (_, index) => ({
        x: index % Math.floor(width / stride),
        y: Math.floor(index / Math.floor(width / stride)),
        stride,
      })),
    );
  }
  throw new Error(`YOLOX输出数量与输入尺寸不匹配：${rows} predictions @ ${width}×${height}`);
}

function parseYolo(tensor: ort.Tensor, manifest: VisionModelManifest, threshold: number): VisionDetection[] {
  const values = toNumbers(tensor.data);
  const dimensions = tensor.dims.map(Number);
  const optionWithoutObjectness = manifest.labels.length + 4;
  const optionWithObjectness = manifest.labels.length + 5;
  const last = dimensions.at(-1) ?? 0;
  const previous = dimensions.at(-2) ?? 0;
  const featuresFirst = (previous === optionWithoutObjectness || previous === optionWithObjectness) && last !== previous;
  const featureCount = featuresFirst ? previous : last;
  const predictionCount = featuresFirst ? last : previous;
  if (![optionWithoutObjectness, optionWithObjectness].includes(featureCount) || predictionCount <= 0)
    throw new Error(`YOLO输出维度与类别不匹配：${dimensions.join("×")}，类别 ${manifest.labels.length}`);
  const valueAt = (prediction: number, feature: number) =>
    featuresFirst ? (values[feature * predictionCount + prediction] ?? 0) : (values[prediction * featureCount + feature] ?? 0);
  const hasObjectness = featureCount === optionWithObjectness;
  const classOffset = hasObjectness ? 5 : 4;
  const detections: VisionDetection[] = [];
  for (let prediction = 0; prediction < predictionCount; prediction += 1) {
    const objectness = hasObjectness ? valueAt(prediction, 4) : 1;
    let classId = 0,
      classScore = 0;
    for (let index = 0; index < manifest.labels.length; index += 1) {
      const score = valueAt(prediction, classOffset + index);
      if (score > classScore) {
        classScore = score;
        classId = index;
      }
    }
    const confidence = objectness * classScore;
    if (confidence < threshold) continue;
    const cx = valueAt(prediction, 0),
      cy = valueAt(prediction, 1),
      width = valueAt(prediction, 2),
      height = valueAt(prediction, 3);
    const scaleX = manifest.output.coordinates === "normalized" ? 1 : manifest.input.width;
    const scaleY = manifest.output.coordinates === "normalized" ? 1 : manifest.input.height;
    detections.push({
      label: manifest.labels[classId] ?? `class-${classId}`,
      classId,
      confidence,
      bbox: [clamp((cx - width / 2) / scaleX, 0, 1), clamp((cy - height / 2) / scaleY, 0, 1), clamp((cx + width / 2) / scaleX, 0, 1), clamp((cy + height / 2) / scaleY, 0, 1)],
    });
  }
  return detections;
}

function parseYoloNms(tensor: ort.Tensor, manifest: VisionModelManifest, threshold: number): VisionDetection[] {
  const values = toNumbers(tensor.data);
  const columns = tensor.dims.at(-1) ? Number(tensor.dims.at(-1)) : 6;
  if (columns < 6) throw new Error(`YOLO NMS输出至少需要6列，实际为 ${columns}`);
  const detections: VisionDetection[] = [];
  for (let row = 0; row < Math.floor(values.length / columns); row += 1) {
    const offset = row * columns;
    const confidence = values[offset + 4] ?? 0;
    if (confidence < threshold) continue;
    const classId = Math.round(values[offset + 5] ?? 0);
    let x1 = values[offset] ?? 0,
      y1 = values[offset + 1] ?? 0,
      x2 = values[offset + 2] ?? 0,
      y2 = values[offset + 3] ?? 0;
    if (manifest.output.coordinates !== "normalized") {
      x1 /= manifest.input.width;
      x2 /= manifest.input.width;
      y1 /= manifest.input.height;
      y2 /= manifest.input.height;
    }
    detections.push({ label: manifest.labels[classId] ?? `class-${classId}`, classId, confidence, bbox: [clamp(x1, 0, 1), clamp(y1, 0, 1), clamp(x2, 0, 1), clamp(y2, 0, 1)] });
  }
  return detections;
}

function nonMaximumSuppression(items: VisionDetection[], threshold: number): VisionDetection[] {
  const output: VisionDetection[] = [];
  for (const item of [...items].sort((a, b) => b.confidence - a.confidence)) {
    if (!item.bbox || output.every((kept) => !kept.bbox || kept.classId !== item.classId || intersectionOverUnion(item.bbox!, kept.bbox) < threshold)) output.push(item);
  }
  return output;
}

export function remapDetections(items: VisionDetection[], manifest: VisionModelManifest, originalWidth: number, originalHeight: number): VisionDetection[] {
  if (manifest.input.resize === "stretch" || originalWidth <= 0 || originalHeight <= 0) return items;
  const inputWidth = manifest.input.width,
    inputHeight = manifest.input.height;
  const contain = manifest.input.resize === "letterbox";
  const scale = contain ? Math.min(inputWidth / originalWidth, inputHeight / originalHeight) : Math.max(inputWidth / originalWidth, inputHeight / originalHeight);
  const topLeft = contain && manifest.input.letterboxPosition === "top-left";
  const offsetX = topLeft ? 0 : (inputWidth - originalWidth * scale) / 2;
  const offsetY = topLeft ? 0 : (inputHeight - originalHeight * scale) / 2;
  const mapX = (value: number) => clamp((value * inputWidth - offsetX) / scale / originalWidth, 0, 1);
  const mapY = (value: number) => clamp((value * inputHeight - offsetY) / scale / originalHeight, 0, 1);
  return items.map((item) => (item.bbox ? { ...item, bbox: [mapX(item.bbox[0]), mapY(item.bbox[1]), mapX(item.bbox[2]), mapY(item.bbox[3])] } : item));
}

function intersectionOverUnion(a: [number, number, number, number], b: [number, number, number, number]): number {
  const width = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const height = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const intersection = width * height;
  const areaA = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]);
  const areaB = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  return intersection / Math.max(1e-9, areaA + areaB - intersection);
}

function softmax(values: number[]): number[] {
  const max = Math.max(...values);
  const exponential = values.map((value) => Math.exp(value - max));
  const total = exponential.reduce((sum, value) => sum + value, 0) || 1;
  return exponential.map((value) => value / total);
}

function toNumbers(data: ort.Tensor["data"]): number[] {
  return Array.from(data as ArrayLike<number>, Number);
}
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function extractOnnxPayload(payload: Buffer): Buffer {
  if (payload[0] !== 0x1f || payload[1] !== 0x8b) return payload;
  const archive = gunzipSync(payload);
  for (let offset = 0; offset + 512 <= archive.length; ) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const sizeText = header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim();
    const size = Number.parseInt(sizeText || "0", 8);
    if (!Number.isFinite(size) || size < 0) throw new Error(`模型压缩包条目无效：${name || "unknown"}`);
    const contentStart = offset + 512;
    const contentEnd = contentStart + size;
    if (contentEnd > archive.length) throw new Error(`模型压缩包内容不完整：${name || "unknown"}`);
    if (name.toLowerCase().endsWith(".onnx")) return Buffer.from(archive.subarray(contentStart, contentEnd));
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  throw new Error("模型压缩包中没有找到 ONNX 文件");
}

export function captureFrameArguments(sourceUrl: string, seekSeconds?: number): string[] {
  return [
    ...(/^rtsps?:/i.test(sourceUrl) ? ["-rtsp_transport", "tcp"] : []),
    ...(seekSeconds !== undefined ? ["-ss", Math.max(0, seekSeconds).toFixed(3)] : []),
    "-i",
    sourceUrl,
    "-frames:v",
    "1",
    "-an",
    "-f",
    "image2pipe",
    "-vcodec",
    "mjpeg",
    "pipe:1",
  ];
}

export function captureFrame(sourceUrl: string, seekSeconds?: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const args = captureFrameArguments(sourceUrl, seekSeconds);
    const child = spawn(process.env.FFMPEG_PATH ?? "ffmpeg", args, { windowsHide: true, shell: false });
    const chunks: Buffer[] = [];
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error("读取视频帧超时"));
    }, 12_000);
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const buffer = Buffer.concat(chunks);
      if (code === 0 && buffer.length > 0) resolve(buffer);
      else reject(new Error(stderr.trim().split(/\r?\n/).at(-1) || `FFmpeg读取失败：${String(code)}`));
    });
  });
}
