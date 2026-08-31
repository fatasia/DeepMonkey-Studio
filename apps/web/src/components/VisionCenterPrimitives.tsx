import type { CSSProperties, ReactNode } from "react";
import type {
  VisionInferenceResponse,
  VisionTaskRecord,
} from "@bim-studio/contracts";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";

export function InferenceResult({
  result,
  locale,
}: {
  result: VisionInferenceResponse;
  locale: AppLocale;
}) {
  return (
    <div className="vision-result">
      <div className="vision-result-image">
        <img src={result.event.imageUrl} alt="" />
        {result.event.detections
          .filter((item) => item.bbox)
          .map((item, index) => (
            <i key={`${item.label}-${index}`} style={boxStyle(item.bbox!)}>
              <b>
                {item.label} {Math.round(item.confidence * 100)}%
              </b>
            </i>
          ))}
      </div>
      <div className="vision-result-summary">
        <span className={result.event.result}>
          {result.event.result.toUpperCase()}
        </span>
        <strong>{result.event.inferenceMs} ms</strong>
        <small>
          {result.event.executionProvider === "directml"
            ? "GPU · DirectML"
            : "CPU"}{" "}
          · {result.imageWidth}×{result.imageHeight}
        </small>
      </div>
      {result.event.executionFallbackReason && (
        <p className="vision-result-fallback">
          {tr(locale, "GPU 回退：", "GPU fallback: ")}
          {result.event.executionFallbackReason}
        </p>
      )}
      <ol>
        {result.event.detections.slice(0, 5).map((item, index) => (
          <li key={`${item.label}-${index}`}>
            <span>{item.label}</span>
            <b>{(item.confidence * 100).toFixed(1)}%</b>
          </li>
        ))}
      </ol>
      {!result.event.detections.length && (
        <p>
          {tr(
            locale,
            "未识别到超过阈值的目标",
            "No result exceeded the threshold",
          )}
        </p>
      )}
    </div>
  );
}

export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <section
        className="vision-modal"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <strong>{title}</strong>
          <button onClick={onClose}>×</button>
        </header>
        {children}
      </section>
    </div>
  );
}
export function Empty({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <div className="vision-empty">
      {icon}
      <span>{text}</span>
    </div>
  );
}
export function boxStyle(
  bbox: [number, number, number, number],
): CSSProperties {
  return {
    left: `${bbox[0] * 100}%`,
    top: `${bbox[1] * 100}%`,
    width: `${Math.max(0, bbox[2] - bbox[0]) * 100}%`,
    height: `${Math.max(0, bbox[3] - bbox[1]) * 100}%`,
  };
}
export function formatBytes(value: number) {
  return value < 1024 * 1024
    ? `${Math.max(1, Math.round(value / 1024))} KB`
    : `${(value / 1024 / 1024).toFixed(1)} MB`;
}
export function providerLabel(task: VisionTaskRecord, locale: AppLocale) {
  if (task.activeExecutionProvider === "directml") return "GPU · DirectML";
  if (task.activeExecutionProvider === "cpu")
    return task.executionFallbackReason
      ? tr(locale, "CPU · 已回退", "CPU · fallback")
      : "CPU";
  if (task.executionProvider === "directml") return "GPU · DirectML";
  if (task.executionProvider === "cpu") return "CPU";
  return tr(locale, "自动 · GPU优先", "Auto · GPU first");
}
