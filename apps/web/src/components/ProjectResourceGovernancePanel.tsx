import { AlertTriangle, Boxes, GitBranch, Layers3, PackageCheck } from "lucide-react";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";
import type { GovernedResource, ProjectResourceGovernanceReport } from "./projectResourceGovernance";

export function ProjectResourceGovernancePanel({ locale, report }: { locale: AppLocale; report: ProjectResourceGovernanceReport }) {
  if (report.definitionCount === 0) return null;
  return (
    <section className="resource-governance-panel" aria-label={tr(locale, "资源复用与依赖", "Resource reuse and dependencies")}>
      <header>
        <span><Boxes size={17} /></span>
        <div>
          <strong>{tr(locale, "资源复用与依赖", "Resource reuse and dependencies")}</strong>
          <small>{tr(locale, "定义 → 版本 → 实例覆盖；不复制模型文件", "Definition → version → instance overrides; model files stay shared")}</small>
        </div>
      </header>
      <div className="resource-governance-metrics">
        <ResourceMetric icon={<PackageCheck size={14} />} label={tr(locale, "定义", "Definitions")} value={report.definitionCount} />
        <ResourceMetric icon={<GitBranch size={14} />} label={tr(locale, "版本", "Versions")} value={report.versionCount} />
        <ResourceMetric icon={<Layers3 size={14} />} label={tr(locale, "实例", "Instances")} value={report.instanceCount} />
        <ResourceMetric
          icon={<AlertTriangle size={14} />}
          label={tr(locale, "未使用", "Unused")}
          value={report.unusedCount}
          warning={report.unusedCount > 0 || report.missingDependencies.length > 0}
        />
      </div>
      {report.missingDependencies.length > 0 && (
        <p className="resource-governance-warning" role="alert">
          <AlertTriangle size={13} />
          {tr(locale, `${report.missingDependencies.length} 个资源或版本引用已断开，发布前必须重新绑定。`, `${report.missingDependencies.length} resource or version references are broken and must be rebound before publishing.`)}
        </p>
      )}
      <details className="resource-governance-details" open={report.unusedCount > 0 || report.missingDependencies.length > 0}>
        <summary>
          <span>{tr(locale, "查看依赖、版本与覆盖", "Inspect dependencies, versions, and overrides")}</span>
          <small>{tr(locale, `${report.overrideCount} 项实例覆盖`, `${report.overrideCount} instance overrides`)}</small>
        </summary>
        <div>
          {report.resources.map((resource) => (
            <article key={resource.key} className={resource.unused ? "unused" : "used"}>
              <ResourceUsageBadge locale={locale} resource={resource} />
              <div>
                <strong>{resource.name}</strong>
                <small>{resource.references.length > 0 ? resource.references.slice(0, 3).map((reference) => `${reference.applicationName} / ${reference.location}`).join("；") : tr(locale, "当前项目没有场景或页面引用，可在下方资源列表清理。", "No scene or page references this resource; it can be removed from the list below.")}</small>
              </div>
            </article>
          ))}
        </div>
      </details>
    </section>
  );
}

export function ResourceUsageBadge({ locale, resource }: { locale: AppLocale; resource: GovernedResource | undefined }) {
  if (!resource) return <span className="resource-usage-badge broken">{tr(locale, "未纳入治理", "Untracked")}</span>;
  return (
    <span className={`resource-usage-badge ${resource.unused ? "unused" : "used"}`} title={tr(locale, `${resource.instanceCount} 个实例，${resource.overrideCount} 项覆盖`, `${resource.instanceCount} instances, ${resource.overrideCount} overrides`)}>
      <b>{resource.versionLabel}</b>
      {resource.unused ? tr(locale, "未引用", "Unused") : tr(locale, `${resource.instanceCount} 个实例`, `${resource.instanceCount} instances`)}
    </span>
  );
}

function ResourceMetric({ icon, label, value, warning = false }: { icon: React.ReactNode; label: string; value: number; warning?: boolean }) {
  return <span className={warning ? "warning" : ""}>{icon}<small>{label}</small><strong>{value}</strong></span>;
}
