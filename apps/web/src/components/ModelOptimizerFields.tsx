import type { ReactNode } from "react";
import type { ModelOptimizationOptions } from "../optimizer/modelOptimizer";
import { translate as tr, type AppLocale } from "../i18n";

export function OptionSection({
  icon,
  title,
  enabled,
  onToggle,
  children,
}: {
  icon: ReactNode;
  title: string;
  enabled?: boolean;
  onToggle?: (enabled: boolean) => void;
  children: ReactNode;
}) {
  return (
    <section className={`optimizer-option ${enabled === false ? "disabled" : ""}`}>
      <div className="optimizer-option-head">
        {icon}
        <strong>{title}</strong>
        {onToggle && (
          <button className={`toggle ${enabled ? "on" : ""}`} onClick={() => onToggle(!enabled)}>
            <i />
          </button>
        )}
      </div>
      <div className="optimizer-option-body">{children}</div>
    </section>
  );
}

export function BakeVector({
  locale,
  label,
  value,
  onChange,
}: {
  locale: AppLocale;
  label: string;
  value: [number, number, number];
  onChange: (value: [number, number, number]) => void;
}) {
  return (
    <div className="optimizer-bake-vector">
      <span>{label}</span>
      {value.map((coordinate, index) => (
        <label key={index}>
          <i>{["X", "Y", "Z"][index]}</i>
          <input
            aria-label={`${label} ${["X", "Y", "Z"][index]}`}
            type="number"
            step="0.25"
            value={coordinate}
            onChange={(event) => {
              const next = [...value] as [number, number, number];
              next[index] = Number(event.target.value);
              onChange(next);
            }}
          />
        </label>
      ))}
      <small>{tr(locale, "局部", "Local")}</small>
    </div>
  );
}

export function Stat({ locale, label, before, after }: { locale: AppLocale; label: string; before: string; after: string | undefined }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{after ?? before}</strong>
      {after && (
        <small>
          {tr(locale, "原始", "Original")} {before}
        </small>
      )}
    </div>
  );
}

export function reduction(before: number, after: number) {
  return Math.max(0, Math.round((1 - after / before) * 100));
}

export function currentLightmapQuality(options: ModelOptimizationOptions): "draft" | "standard" | "high" | "custom" {
  if (
    options.lightmapResolution === 256 &&
    options.lightmapAoSamples === 4 &&
    options.lightmapShadowSamples === 1 &&
    options.lightmapIndirectSamples === 0 &&
    !options.lightmapDenoise
  )
    return "draft";
  if (
    options.lightmapResolution === 512 &&
    options.lightmapAoSamples === 4 &&
    options.lightmapShadowSamples === 4 &&
    options.lightmapIndirectSamples === 2 &&
    options.lightmapDenoise
  )
    return "standard";
  if (
    options.lightmapResolution === 1024 &&
    options.lightmapAoSamples === 8 &&
    options.lightmapShadowSamples === 8 &&
    options.lightmapIndirectSamples === 4 &&
    options.lightmapDenoise
  )
    return "high";
  return "custom";
}

export function formatBytes(bytes: number) {
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function optimizerErrorMessage(reason: unknown, locale: AppLocale) {
  return reason instanceof Error ? reason.message : tr(locale, "模型处理失败", "Model processing failed");
}

export function isOptimizerAbortError(reason: unknown) {
  return reason instanceof DOMException && reason.name === "AbortError";
}

export function localizeOptimizerMessage(locale: AppLocale, message: string) {
  if (locale === "zh-CN") return message;
  if (message.startsWith("优化完成，体积减少 ")) return message.replace("优化完成，体积减少 ", "Optimization complete; size reduced by ");
  const messages: Record<string, string> = {
    "导入 GLB 或内嵌资源的 glTF 开始优化": "Import a GLB or embedded glTF to begin",
    正在分析模型: "Analyzing model",
    "模型已载入，可调整参数后开始优化": "Model loaded; adjust options and start optimization",
    模型解析失败: "Model parsing failed",
    正在烘焙顶点光照: "Baking vertex lighting",
    "正在执行 Draco 压缩": "Applying Draco compression",
    "优化失败，原始文件未修改": "Optimization failed; the source file was not modified",
  };
  return messages[message] ?? message;
}
