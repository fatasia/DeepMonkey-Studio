import { AlertTriangle, Box, Check, ChevronDown, Code2, Database, Layers3, Link2, Rocket, ScanLine } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { ProjectRecord, PublishedSceneRecord, SceneSnapshot } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import { assessProjectPublication, hasPublicationDataProduct } from "./publicationReadiness";
import { buildDeliveryBlockers, buildDeliverySteps, firstIncompleteRequiredStep, firstIncompleteStep, type DeliveryStepId } from "./deliveryWorkflowModel";
import { readDeliveryWorkflowMemory, writeDeliveryWorkflowMemory } from "./deliveryWorkflowPersistence";
import { summarizeScenePublicationDiff, type ScenePublicationDiffMetric, type ScenePublicationDiffSection } from "./scenePublicationDiff";

interface PublicationVersionItemProps {
  locale: AppLocale;
  draft: SceneSnapshot;
  version: PublishedSceneRecord;
  fallbackVersion: number;
  latest: boolean;
  busy: boolean;
  onRestore: () => void;
}

export function PublicationVersionItem(props: PublicationVersionItemProps) {
  const diff = summarizeScenePublicationDiff(props.draft, props.version.snapshot);
  const changedMetrics = diff.metrics.filter((metric) => metric.delta !== 0);
  return (
    <article className={diff.hasChanges ? "changed" : "unchanged"}>
      <header>
        <span>
          <strong>v{props.version.version ?? props.fallbackVersion}</strong>
          <small>
            {new Date(props.version.publishedAt).toLocaleString(props.locale)} ·{" "}
            {publicationRuntimeLabel(props.locale, props.version.snapshot.publicationMode, props.version.snapshot.publicationPerformance)}
          </small>
        </span>
        <button className="button" disabled={props.busy || props.latest} onClick={props.onRestore}>
          {props.latest ? tr(props.locale, "当前发布", "Current publication") : tr(props.locale, "恢复", "Restore")}
        </button>
      </header>
      <div className="publication-diff-summary">
        <i>{diff.hasChanges ? <AlertTriangle size={12} /> : <Check size={12} />}</i>
        <strong>
          {diff.hasChanges
            ? tr(props.locale, `草稿有 ${diff.changedSections.length} 类变化`, `${diff.changedSections.length} draft sections changed`)
            : tr(props.locale, "与当前草稿一致", "Matches current draft")}
        </strong>
        {changedMetrics.map((metric) => (
          <span key={metric.id}>
            {publicationMetricLabel(props.locale, metric.id)} {formatSigned(metric.delta)}
          </span>
        ))}
      </div>
      {diff.hasChanges && (
        <details>
          <summary>{tr(props.locale, "查看差异范围", "Review changed areas")}</summary>
          <div className="publication-diff-sections">
            {diff.changedSections.map((section) => (
              <span key={section}>{publicationSectionLabel(props.locale, section)}</span>
            ))}
          </div>
          <div className="publication-diff-counts">
            {diff.metrics.map((metric) => (
              <span key={metric.id}>
                <small>{publicationMetricLabel(props.locale, metric.id)}</small>
                <strong>
                  {metric.published} → {metric.draft}
                </strong>
              </span>
            ))}
          </div>
        </details>
      )}
    </article>
  );
}

interface DeliveryReviewDialogProps {
  locale: AppLocale;
  project: ProjectRecord;
  scenes: SceneSnapshot[];
  onClose: () => void;
  onOpenData: () => void;
  onOpenAssets: () => void;
  onOpenScenes: () => void;
  onOpenLinkage: () => void;
}

type DeliveryReviewAction = "data" | "assets" | "scenes" | "linkage";

interface DeliveryReviewCheck {
  id: string;
  label: string;
  detail: string;
  ready: boolean;
  required: boolean;
  action?: DeliveryReviewAction;
  actionLabel: string;
  issues?: Array<{ title: string; remediation: string }>;
}

export function DeliveryReviewDialog(props: DeliveryReviewDialogProps) {
  const checks = deliveryChecks(props.locale, props.project, props.scenes);
  const blockers = checks.filter((check) => check.required && !check.ready);
  const actions = { data: props.onOpenData, assets: props.onOpenAssets, scenes: props.onOpenScenes, linkage: props.onOpenLinkage };
  return (
    <div className="dialog-backdrop" onMouseDown={props.onClose}>
      <section
        className="dialog delivery-review"
        role="dialog"
        aria-modal="true"
        aria-label={tr(props.locale, "交付校验", "Delivery validation")}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <span className="eyebrow">DELIVERY GATE</span>
        <h2>{tr(props.locale, "发布前交付校验", "Pre-publication validation")}</h2>
        <p>
          {blockers.length === 0
            ? tr(props.locale, "必需检查均已通过，可以进入场景列表发布版本。", "All required checks passed. You can publish a version from the scene list.")
            : tr(props.locale, `还有 ${blockers.length} 个必需项未通过，发布前请处理。`, `${blockers.length} required checks still need attention.`)}
        </p>
        <div className="delivery-review-list">
          {checks.map((check) => (
            <article key={check.id} className={check.ready ? "ready" : check.required ? "blocked" : "optional"}>
              <i>{check.ready ? <Check /> : <AlertTriangle />}</i>
              <span>
                <strong>{check.label}</strong>
                <small>{check.detail}</small>
                {check.issues && check.issues.length > 0 && (
                  <ul className="delivery-review-issues">
                    {check.issues.map((issue) => <li key={`${issue.title}:${issue.remediation}`}><b>{issue.title}</b><i>{issue.remediation}</i></li>)}
                  </ul>
                )}
              </span>
              <em>{check.required ? tr(props.locale, "必需", "Required") : tr(props.locale, "建议", "Recommended")}</em>
              {!check.ready && check.action && (
                <button type="button" onClick={actions[check.action]}>
                  {check.actionLabel}
                </button>
              )}
            </article>
          ))}
        </div>
        <div className="dialog-actions">
          <button className="button" onClick={props.onClose}>
            {tr(props.locale, "关闭", "Close")}
          </button>
          <button className="button primary" disabled={blockers.length > 0} onClick={props.onOpenScenes}>
            {tr(props.locale, "进入发布", "Continue to publish")}
          </button>
        </div>
      </section>
    </div>
  );
}

interface ProjectDeliveryFlowProps {
  locale: AppLocale;
  project: ProjectRecord;
  scenes: SceneSnapshot[];
  /** 首屏默认收起；测试和嵌入式工作区可显式打开详情。 */
  defaultCollapsed?: boolean;
  onData: () => void;
  onAssets: () => void;
  onDesign: () => void;
  onLinkage: () => void;
  onBehavior?: () => void;
  onSimulation?: () => void;
  onValidate: () => void;
  onPublish: () => void;
}

export function ProjectDeliveryFlow(props: ProjectDeliveryFlowProps) {
  const steps = buildDeliverySteps(props.locale, props.project, props.scenes);
  const blockers = buildDeliveryBlockers(props.locale, props.project, props.scenes);
  const initialMemory = readDeliveryWorkflowMemory(props.project.id);
  const [activeStepId, setActiveStepId] = useState<DeliveryStepId | undefined>(() => initialMemory?.activeStep);
  const [previousStepId, setPreviousStepId] = useState<DeliveryStepId | undefined>(() => initialMemory?.previousStep);
  // 进度面板只在需要时占用空间，用户可以随时展开查看完整步骤。
  const [collapsed, setCollapsed] = useState(props.defaultCollapsed ?? true);
  useEffect(() => {
    const memory = readDeliveryWorkflowMemory(props.project.id);
    setActiveStepId(memory?.activeStep);
    setPreviousStepId(memory?.previousStep);
  }, [props.project.id]);
  const actions: Record<DeliveryStepId, () => void> = {
    data: props.onData,
    assets: props.onAssets,
    design: props.onDesign,
    linkage: props.onLinkage,
    behavior: props.onBehavior ?? props.onLinkage,
    simulation: props.onSimulation ?? props.onLinkage,
    validate: props.onValidate,
    publish: props.onPublish,
  };
  const icons: Record<DeliveryStepId, ReactNode> = {
    data: <Database />,
    assets: <Box />,
    design: <Layers3 />,
    linkage: <Link2 />,
    behavior: <Code2 />,
    simulation: <ScanLine />,
    validate: <Check />,
    publish: <Rocket />,
  };
  const nextStep = firstIncompleteRequiredStep(steps) ?? firstIncompleteStep(steps);
  const requiredSteps = steps.filter((step) => step.required);
  const requiredReadyCount = requiredSteps.filter((step) => step.ready).length;
  const progress = Math.round((requiredReadyCount / requiredSteps.length) * 100);
  const runStep = (requestedStepId: DeliveryStepId) => {
    // 未通过前置检查时，“发布”统一进入校验，避免把用户送到无法完成的页面。
    const stepId = requestedStepId === "publish" && blockers.length > 0 ? "validate" : requestedStepId;
    const previousStep = activeStepId && activeStepId !== stepId ? activeStepId : previousStepId;
    setPreviousStepId(previousStep);
    setActiveStepId(stepId);
    writeDeliveryWorkflowMemory(props.project.id, { activeStep: stepId, ...(previousStep ? { previousStep } : {}), updatedAt: new Date().toISOString() });
    actions[stepId]();
  };
  return (
    <section className={`project-delivery-flow${collapsed ? " is-collapsed" : ""}`}>
      <header>
        <span>
          <strong>{tr(props.locale, "开发流程", "Development flow")}</strong>
          {!collapsed && <small>{tr(props.locale, "数据 → 资产 → 设计 → 联动 → 脚本 → 仿真 → 校验 → 发布", "Data → Assets → Design → Link → Script → Simulate → Validate → Publish")}</small>}
        </span>
        <div className="delivery-flow-actions">
          <button
            type="button"
            className="delivery-collapse-action"
            aria-expanded={!collapsed}
            aria-label={collapsed ? tr(props.locale, "展开开发流程", "Expand development flow") : tr(props.locale, "收起开发流程", "Collapse development flow")}
            onClick={() => setCollapsed((value) => !value)}
          >
            <ChevronDown size={13} />
            <span>{collapsed ? tr(props.locale, "展开", "Expand") : tr(props.locale, "收起", "Collapse")}</span>
          </button>
          {previousStepId && (
            <button type="button" className="delivery-return-action" onClick={() => runStep(previousStepId)}>
              {tr(props.locale, "回到上次工作", "Return to previous work")}
            </button>
          )}
          {nextStep && (
            <button type="button" className="delivery-next-action" onClick={() => runStep(nextStep.id)}>
              {tr(props.locale, `继续：${nextStep.label}`, `Continue: ${nextStep.label}`)}
              <Rocket size={11} />
            </button>
          )}
        </div>
      </header>
      {!collapsed && <div className="delivery-flow-body">
        <div
          className="delivery-progress"
          aria-label={tr(props.locale, `必需步骤完成 ${requiredReadyCount}/${requiredSteps.length}`, `${requiredReadyCount}/${requiredSteps.length} required steps complete`)}
        >
          <span>
            <i style={{ width: `${progress}%` }} />
          </span>
          <small>
            {requiredReadyCount}/{requiredSteps.length} {tr(props.locale, "必需步骤", "required")}
          </small>
        </div>
        {blockers.length > 0 && (
          <details className="delivery-blockers">
            <summary>
              <AlertTriangle size={12} />
              {tr(props.locale, `${blockers.length} 项阻断，点击查看`, `${blockers.length} blockers — review`)}
            </summary>
            <div>
              {blockers.map((blocker) => (
                <button type="button" key={blocker.id} onClick={() => runStep(blocker.stepId)}>
                  <span>
                    <strong>{blocker.label}</strong>
                    <small>{blocker.detail}</small>
                  </span>
                  <em>{tr(props.locale, "去处理", "Resolve")}</em>
                </button>
              ))}
            </div>
          </details>
        )}
        <div className="delivery-step-grid">
          {steps.map((step, index) => (
            <button
              type="button"
              key={step.id}
              data-step-id={step.id}
              aria-current={activeStepId === step.id ? "step" : undefined}
              aria-label={`${index + 1}. ${step.label}：${step.detail}`}
              className={`${step.ready ? "ready" : step.blocked ? "blocked" : "pending"} ${step.required ? "required" : "optional"} ${activeStepId === step.id ? "active" : ""}`}
              onClick={() => runStep(step.id)}
            >
              <i>{step.ready ? <Check /> : icons[step.id]}</i>
              <span>
                <strong>
                  {index + 1}. {step.label}
                </strong>
                <small>
                  {step.detail}
                  {!step.required && ` · ${tr(props.locale, "建议", "Recommended")}`}
                </small>
              </span>
            </button>
          ))}
        </div>
      </div>}
    </section>
  );
}

function deliveryChecks(locale: AppLocale, project: ProjectRecord, scenes: SceneSnapshot[]): DeliveryReviewCheck[] {
  const enabledConnections = (project.dataConnections ?? []).filter((connection) => connection.enabled).length;
  const datasets = project.datasets?.length ?? 0;
  const failedAssets = project.models.filter((model) => model.status === "failed" || model.status === "processing").length;
  const linkage = scenes.reduce((count, scene) => count + (scene.dataBindings?.length ?? 0) + (scene.interactions?.length ?? 0), 0);
  const audit = assessProjectPublication(project, scenes);
  const firstBlockingCategory = audit.issues.find((issue) => issue.severity === "blocker")?.category;
  const auditAction = firstBlockingCategory === "data" ? "data" : firstBlockingCategory === "asset" ? "assets" : firstBlockingCategory ? "linkage" : undefined;
  return [
    {
      id: "data",
      label: tr(locale, "数据源与数据集", "Connections and datasets"),
      detail:
        enabledConnections > 0 && datasets > 0
          ? tr(locale, `${enabledConnections} 个连接 · ${datasets} 个数据集`, `${enabledConnections} connections · ${datasets} datasets`)
          : tr(locale, "至少需要一个可用连接和一个数据集", "At least one usable connection and dataset are required"),
      ready: enabledConnections > 0 && datasets > 0,
      required: true,
      action: "data" as const,
      actionLabel: tr(locale, "去接入数据", "Connect data"),
    },
    {
      id: "scene",
      label: tr(locale, "可交付场景", "Deliverable scenes"),
      detail: scenes.length > 0 ? tr(locale, `${scenes.length} 个场景`, `${scenes.length} scenes`) : tr(locale, "尚未创建场景", "No scenes created"),
      ready: scenes.length > 0,
      required: true,
      action: "scenes" as const,
      actionLabel: tr(locale, "去创建场景", "Create scene"),
    },
    {
      id: "asset",
      label: tr(locale, "资产处理状态", "Asset processing"),
      detail:
        failedAssets === 0
          ? tr(locale, "没有失败或处理中的模型", "No failed or processing models")
          : tr(locale, `${failedAssets} 个模型需要处理`, `${failedAssets} models need attention`),
      ready: failedAssets === 0,
      required: true,
      action: "assets" as const,
      actionLabel: tr(locale, "去处理资源", "Review assets"),
    },
    ...(scenes.length > 0
      ? [
          {
            id: "linkage",
            label: tr(locale, "数据与交互联动", "Data and interactions"),
            detail:
              linkage > 0
                ? tr(locale, `${linkage} 条绑定或交互`, `${linkage} bindings or interactions`)
                : tr(locale, "尚未配置绑定、筛选、钻取或交互", "No bindings, filters, drill-downs or interactions configured"),
            ready: linkage > 0,
            required: true,
            action: "linkage" as const,
            actionLabel: tr(locale, "去配置联动", "Configure linkage"),
          },
        ]
      : []),
    {
      id: "smart-audit",
      label: tr(locale, "智能发布体检", "Smart publication audit"),
      detail:
        audit.blockers > 0
          ? tr(locale, `${audit.blockers} 个断链或无效引用阻断发布`, `${audit.blockers} broken or invalid references block publication`)
          : audit.warnings > 0
            ? tr(locale, `硬门禁通过，仍有 ${audit.warnings} 项建议处理`, `Hard gates passed with ${audit.warnings} warnings`)
            : tr(locale, "模型、数据、媒体与交互引用均有效", "Model, data, media, and interaction references are valid"),
      ready: audit.blockers === 0,
      required: true,
      ...(auditAction ? { action: auditAction } : {}),
      actionLabel: auditAction ? tr(locale, "去处理问题", "Resolve issues") : "",
      issues: audit.issues.filter((issue) => issue.severity !== "recommendation").slice(0, 4).map((issue) => ({
        title: issue.title,
        remediation: issue.remediation,
      })),
    },
    {
      id: "publication",
      label: tr(locale, "已发布版本", "Published version"),
      detail: scenes.some((scene) => Boolean(scene.publishedAt))
        ? tr(locale, "已有可回退的发布版本", "A rollback baseline is available")
        : tr(locale, "首次发布后将建立版本基线", "The first publication establishes the version baseline"),
      ready: scenes.some((scene) => Boolean(scene.publishedAt)),
      required: false,
      actionLabel: "",
    },
  ];
}

function publicationRuntimeLabel(locale: AppLocale, mode: SceneSnapshot["publicationMode"], performance: SceneSnapshot["publicationPerformance"]): string {
  const runtime = mode === "webgpu-preferred" ? "WebGPU" : mode === "cloud" ? tr(locale, "云渲染", "Cloud") : "WebGL";
  return performance === "fast" ? `${runtime} · ${tr(locale, "自动优化", "Adaptive")}` : runtime;
}

function publicationSectionLabel(locale: AppLocale, section: ScenePublicationDiffSection): string {
  const labels: Record<ScenePublicationDiffSection, [string, string]> = {
    scene: ["场景信息", "Scene"],
    content: ["模型与对象", "Models & objects"],
    camera: ["相机与导航", "Camera & navigation"],
    appearance: ["环境与画面", "Environment & visuals"],
    dashboard: ["二维看板", "Dashboard"],
    data: ["数据绑定", "Data bindings"],
    interaction: ["交互与脚本", "Interactions & scripts"],
    simulation: ["动画与物理", "Animation & physics"],
    review: ["测量与标注", "Measurements & annotations"],
    runtime: ["发布运行方式", "Publication runtime"],
  };
  return tr(locale, ...labels[section]);
}

function publicationMetricLabel(locale: AppLocale, metric: ScenePublicationDiffMetric): string {
  const labels: Record<ScenePublicationDiffMetric, [string, string]> = {
    objects: ["对象", "Objects"],
    widgets: ["组件", "Widgets"],
    bindings: ["绑定", "Bindings"],
    interactions: ["交互", "Interactions"],
    measurements: ["测量", "Measurements"],
    annotations: ["标注", "Annotations"],
  };
  return tr(locale, ...labels[metric]);
}

function formatSigned(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}
