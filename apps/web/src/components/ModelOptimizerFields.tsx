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
          <button
            type="button"
            className={`toggle ${enabled ? "on" : ""}`}
            role="switch"
            aria-label={title}
            aria-checked={Boolean(enabled)}
            onClick={() => onToggle(!enabled)}
          >
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

export function optimizationSizeMessage(before: number, after: number) {
  if (after <= before) return `优化完成，体积减少 ${reduction(before, after)}%`;
  return `优化完成，体积增加 ${Math.round((after / before - 1) * 100)}%`;
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
  if (message.startsWith("优化完成，体积增加 ")) return message.replace("优化完成，体积增加 ", "Optimization complete; size increased by ");
  // 转换进度等动态消息按前缀匹配；其余完整映射。
  const conversion = message.match(/^模型转换中 (\d+)%$/);
  if (conversion) return `Converting model ${conversion[1]}%`;
  if (message.startsWith("正在把 ")) return message.replace(/^正在把 (.+) 转换为优化工作格式$/, "Converting $1 to the optimization format");
  const messages: Record<string, string> = {
    "导入 GLB 或内嵌资源的 glTF 开始优化": "Import a GLB or embedded glTF to begin",
    正在分析模型: "Analyzing model",
    "模型已载入，可调整参数后开始优化": "Model loaded; adjust options and start optimization",
    模型解析失败: "Model parsing failed",
    正在烘焙顶点光照: "Baking vertex lighting",
    "正在执行 Draco 压缩": "Applying Draco compression",
    "优化失败，原始文件未修改": "Optimization failed; the source file was not modified",
    正在准备模型: "Preparing model",
    "机器人已载入": "Robot loaded",
    "指定的项目模型不存在或尚未就绪，请从项目素材重新选择": "The selected project model does not exist or is not ready; pick it again from project assets",
    "正在上传源模型并创建转换任务": "Uploading source model and creating a conversion task",
    "模型转换任务不存在": "Model conversion task not found",
    "模型转换超时，可稍后从项目素材库继续优化": "Model conversion timed out; continue later from project assets",
    "模型尚未转换为可查看资源": "Model is not converted to a viewable resource yet",
    "机器人资源缺少关节描述": "Robot asset is missing its joint description",
    "机器人资源仅支持原包无损压缩，不能转换为静态 GLB 优化格式": "Robot assets only support lossless compression of the original package; they cannot be converted to static GLB",
    "请先选择项目": "Select a project first",
    "请先选择项目，其他格式需要通过项目转换服务处理": "Select a project first; other formats require the project conversion service",
    "正在保存优化结果到项目素材库": "Saving the optimized result to project assets",
    "优化模型已保存到项目素材库，可直接用于场景": "Optimized model saved to project assets; ready for scenes",
    "已停止等待；再次保存将继续等待同一任务": "Stopped waiting; saving again resumes the same task",
    "已停止等待；转换任务仍保留在项目素材中": "Stopped waiting; the conversion task remains in project assets",
    "处理已取消，原始文件未修改": "Processing cancelled; the source file was not modified",
    "模型导入或转换失败，已载入模型保持不变": "Import or conversion failed; the loaded model is unchanged",
    "项目模型转换失败，已载入模型保持不变": "Project model conversion failed; the loaded model is unchanged",
    "保存或转换尚未完成，可重试继续等待": "Save or conversion is not finished; retry to keep waiting",
    "光照贴图烘焙失败": "Lightmap baking failed",
    "正在生成光照贴图": "Generating lightmaps",
  };
  return messages[message] ?? message;
}
