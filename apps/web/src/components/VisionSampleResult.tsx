import type { VisionDetection } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import "./VisionSampleResult.css";

interface VisionSampleOutput { modelInferenceExecuted: true; detections: VisionDetection[]; preview: { dataUrl: string; width: number; height: number }; }
function isVisionOutput(value: unknown): value is VisionSampleOutput {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<VisionSampleOutput>;
  return item.modelInferenceExecuted === true && Array.isArray(item.detections) && typeof item.preview?.dataUrl === "string" && item.preview.dataUrl.startsWith("data:image/jpeg;base64,") && Number(item.preview.width) > 0 && Number(item.preview.height) > 0;
}

export function VisionSampleResult({ output, locale }: { output: unknown; locale: AppLocale }) {
  if (!isVisionOutput(output)) return null;
  return <figure className="vision-sample-result">
    <div className="vision-sample-image">
      <img src={output.preview.dataUrl} width={output.preview.width} height={output.preview.height} alt={tr(locale, "YOLOX 官方示例：狗、自行车与车辆", "YOLOX official sample: dog, bicycle and vehicle")} />
      <svg viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true">{output.detections.map((detection, index) => detection.bbox && <rect key={index} x={detection.bbox[0] * 1000} y={detection.bbox[1] * 1000} width={(detection.bbox[2] - detection.bbox[0]) * 1000} height={(detection.bbox[3] - detection.bbox[1]) * 1000} />)}</svg>
    </div>
    <figcaption><strong>{tr(locale, "本次识别结果", "Detections from this run")}</strong>
      <ul>{output.detections.map((detection, index) => <li key={index}><span>{detection.label}</span><span>{(detection.confidence * 100).toFixed(1)}%</span></li>)}</ul>
      <p>{tr(locale, "内置通用模型的真实推理，用于验证本地识别链路。", "Real inference with a bundled general model, validating the local recognition pipeline.")}</p>
    </figcaption>
  </figure>;
}
