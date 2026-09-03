import { ArrowRight, Box, Camera, Crosshair } from "lucide-react";
import type { VisionModelRecord, VisionSourceRecord, VisionTaskRecord } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";

export function VisionTaskDependencyFlow({
  task,
  sources,
  models,
  locale,
}: {
  task: VisionTaskRecord;
  sources: VisionSourceRecord[];
  models: VisionModelRecord[];
  locale: AppLocale;
}) {
  const source = sources.find((item) => item.id === task.sourceId);
  const model = models.find((item) => item.id === task.modelId);
  const sceneTargetCount = task.binding.objectIds.length;
  const outputLabel = task.binding.sceneId
    ? tr(locale, `${sceneTargetCount} 个场景对象`, `${sceneTargetCount} scene target${sceneTargetCount === 1 ? "" : "s"}`)
    : task.binding.actions.includes("dashboard")
      ? tr(locale, "数据看板", "Dashboard")
      : tr(locale, "识别记录", "Event records");
  const sourceLabel = source?.name
    ?? (task.mode === "image"
      ? tr(locale, "手动上传图片", "Manual image upload")
      : tr(locale, "未连接视觉源", "Source not connected"));

  return (
    <div className="vision-task-flow" aria-label={tr(locale, "任务处理链", "Task pipeline")}>
      <span className={!source && task.mode === "video" ? "needs-input" : ""} title={sourceLabel}>
        <Camera size={11} />
        <b>{tr(locale, "输入", "Input")}</b>
        <small>{sourceLabel}</small>
      </span>
      <ArrowRight aria-hidden="true" size={11} />
      <span title={model?.name ?? task.modelId}>
        <Box size={11} />
        <b>{tr(locale, "模型", "Model")}</b>
        <small>{model?.name ?? task.modelId}</small>
      </span>
      <ArrowRight aria-hidden="true" size={11} />
      <span title={outputLabel}>
        <Crosshair size={11} />
        <b>{tr(locale, "输出", "Output")}</b>
        <small>{outputLabel}</small>
      </span>
    </div>
  );
}
