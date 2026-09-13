import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as ort from "onnxruntime-node";
import { PRESETS } from "../visionPresets.js";
import { parseOutputs, prepareImage, remapDetections } from "../visionRuntime.js";

const MODEL_SHA256 = "c789161ed43c8269fcd4e67c67eeeb4e80c622da2eb296a20bc6007bd18a0b7d";
const IMAGE_SHA256 = "5a9522051c3cec2bbd2f6323fccba32e8fbf3ddcc2b3e2fd46b04c720bc6f866";
const assets = new URL("../../assets/vision-sample/", import.meta.url);
let runtime: Promise<ort.InferenceSession> | undefined;
let queue = Promise.resolve();
const digest = (buffer: Buffer) => createHash("sha256").update(buffer).digest("hex");

async function session() {
  runtime ??= (async () => {
    const model = await readFile(new URL("yolox_nano.onnx", assets));
    if (digest(model) !== MODEL_SHA256) throw new Error("内置视觉模型校验失败，请重新安装样例资源");
    return ort.InferenceSession.create(model, { executionProviders: ["cpu"], intraOpNumThreads: 2, interOpNumThreads: 1 });
  })().catch((error) => { runtime = undefined; throw error; });
  return runtime;
}

/** 随产品提供的真实权重和演示图；不读取任何项目模型、摄像头或外部业务服务。 */
export async function runVisionInferenceSample() {
  const manifest = PRESETS.find((preset) => preset.id === "yolox-nano-coco")!.manifest;
  const frame = await readFile(new URL("dog.jpg", assets));
  if (digest(frame) !== IMAGE_SHA256) throw new Error("内置视觉图片校验失败，请重新安装样例资源");
  const prepared = await prepareImage(frame, manifest);
  const model = await session();
  const inputName = manifest.input.inputName ?? model.inputNames[0];
  if (!inputName) throw new Error("内置视觉模型缺少输入节点");
  const input = new ort.Tensor("float32", prepared.data as Float32Array, prepared.dims);
  // 单会话排队只共享不可变权重；每次请求仍重新预处理、推理、解析。
  const result = queue.then(async () => {
    const started = performance.now();
    const outputs = await model.run({ [inputName]: input });
    return { outputs, inferenceMs: Math.round(performance.now() - started) };
  });
  queue = result.then(() => undefined, () => undefined);
  const { outputs, inferenceMs } = await result;
  const detections = remapDetections(parseOutputs(outputs, manifest, manifest.threshold, manifest.iouThreshold ?? 0.45), manifest, prepared.originalWidth, prepared.originalHeight);
  return {
    engine: "vision-onnxruntime-yolox-nano",
    input: { image: "YOLOX/assets/dog.jpg", imageSha256: IMAGE_SHA256, modelSha256: MODEL_SHA256, manifest },
    output: { modelInferenceExecuted: true, executionProvider: "cpu", inputTensorDimensions: prepared.dims,
      imageWidth: prepared.originalWidth, imageHeight: prepared.originalHeight, detections, inferenceMs,
      preview: { dataUrl: `data:image/jpeg;base64,${frame.toString("base64")}`, width: prepared.originalWidth, height: prepared.originalHeight } },
    metrics: [
      { label: "识别模型", labelEn: "Recognition model", value: "YOLOX-Nano · CPU" },
      { label: "识别目标", labelEn: "Detected objects", value: String(detections.length) },
      { label: "推理耗时", labelEn: "Inference time", value: `${inferenceMs} ms` },
    ],
  };
}
