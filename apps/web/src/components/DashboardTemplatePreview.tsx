import type { AppLocale } from "../i18n";
import type { DashboardTemplateDefinition } from "./dashboardTemplateTypes";
import { DashboardComponentPreview } from "./DashboardComponentPreview";

interface DashboardTemplatePreviewProps {
  locale: AppLocale;
  template: DashboardTemplateDefinition;
}

/** 使用模板真实指标和图表类型生成预览，避免所有模板只换颜色的空壳观感。 */
export function DashboardTemplatePreview({ locale, template }: DashboardTemplatePreviewProps) {
  const primaryRatio = `${Math.round(template.layout.primaryRatio * 100)}fr`;
  const secondaryRatio = `${Math.round((1 - template.layout.primaryRatio) * 100)}fr`;
  return (
    <div
      className="dashboard-template-card-preview"
      style={{ "--template-accent": template.accent, "--template-surface": template.surface } as React.CSSProperties}
      aria-label={locale === "zh-CN" ? `${template.zh}模板预览` : `${template.en} template preview`}
    >
      <div className="template-preview-heading">
        <span>{locale === "zh-CN" ? template.zh : template.en}</span>
        <i />
      </div>
      <div className="template-preview-metrics">
        {template.metrics.map((metric, index) => (
          <span key={metric.dataKey}><small>{metric.unit || "—"}</small><b>{sampleMetric(index)}</b></span>
        ))}
      </div>
      <div className="template-preview-charts" style={{ gridTemplateColumns: `${primaryRatio} ${secondaryRatio}` }}>
        <DashboardComponentPreview type={template.layout.primaryChart} />
        <DashboardComponentPreview type={template.layout.secondaryChart} />
      </div>
    </div>
  );
}

function sampleMetric(index: number): string {
  return ["86.4", "97.2", "12", "3.8"][index] ?? "—";
}
