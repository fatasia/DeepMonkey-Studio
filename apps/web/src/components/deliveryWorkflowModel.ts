import type { ProjectRecord, SceneSnapshot } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import { hasPublicationDataProduct } from "./publicationReadiness";

/** 项目交付主线的固定顺序；页面只负责渲染，状态判断集中在这里。 */
export const DELIVERY_STEP_IDS = ["data", "assets", "design", "linkage", "behavior", "simulation", "validate", "publish"] as const;

export type DeliveryStepId = (typeof DELIVERY_STEP_IDS)[number];

export interface DeliveryStepState {
  id: DeliveryStepId;
  label: string;
  detail: string;
  ready: boolean;
  /** 前置条件未满足时仍允许查看，但界面必须明确说明不能直接完成。 */
  blocked: boolean;
  /** 非必需步骤显示建议状态，不应阻塞纯展示型项目发布。 */
  required: boolean;
}

export interface DeliveryBlocker {
  id: "data" | "design" | "assets" | "linkage";
  stepId: DeliveryStepId;
  label: string;
  detail: string;
}

export interface DeliveryWorkflowFacts {
  dataReady: boolean;
  assetReady: boolean;
  designReady: boolean;
  linkageReady: boolean;
  behaviorReady: boolean;
  simulationReady: boolean;
  validationReady: boolean;
  published: boolean;
  pendingAssetCount: number;
}

export function deriveDeliveryWorkflowFacts(project: ProjectRecord, scenes: SceneSnapshot[]): DeliveryWorkflowFacts {
  const pendingAssetCount = project.models.filter((model) => model.status === "failed" || model.status === "processing").length;
  const designReady = scenes.length > 0;
  const linkageReady = scenes.some((scene) => (scene.dataBindings?.length ?? 0) + (scene.interactions?.length ?? 0) > 0);
  const behaviorReady = scenes.some((scene) => (scene.interactions?.length ?? 0) > 0);
  const simulationReady = scenes.some((scene) => Boolean(scene.physics) || Boolean(scene.animation));
  const dataReady = hasPublicationDataProduct(project);
  return {
    dataReady,
    assetReady: project.models.some((model) => model.status === "ready") || (project.assets?.length ?? 0) > 0,
    designReady,
    linkageReady,
    behaviorReady,
    simulationReady,
    // 交付卡片和发布校验必须使用同一口径，避免页面先显示通过、弹窗又阻断。
    validationReady: dataReady && designReady && linkageReady && pendingAssetCount === 0,
    published: scenes.some((scene) => Boolean(scene.publishedAt)),
    pendingAssetCount,
  };
}

export function buildDeliverySteps(locale: AppLocale, project: ProjectRecord, scenes: SceneSnapshot[]): DeliveryStepState[] {
  const facts = deriveDeliveryWorkflowFacts(project, scenes);
  return [
    step(
      "data",
      tr(locale, "接入数据", "Connect data"),
      facts.dataReady ? tr(locale, "连接与数据集就绪", "Connection and dataset ready") : tr(locale, "缺连接或数据集", "Connection or dataset missing"),
      facts.dataReady,
      true,
    ),
    step(
      "assets",
      tr(locale, "准备资产", "Prepare assets"),
      facts.assetReady ? tr(locale, "已有可复用资源", "Reusable assets ready") : tr(locale, "可跳过，使用程序化场景", "Optional for procedural scenes"),
      facts.assetReady,
      false,
    ),
    step(
      "design",
      tr(locale, "设计场景", "Design scene"),
      facts.designReady ? tr(locale, `${scenes.length} 个场景`, `${scenes.length} scenes`) : tr(locale, "尚未创建", "Not started"),
      facts.designReady,
      true,
    ),
    step(
      "linkage",
      tr(locale, "数据联动", "Link data"),
      facts.linkageReady
        ? tr(locale, "已有绑定或交互", "Bindings or interactions ready")
        : facts.designReady
          ? tr(locale, "配置筛选、钻取与 3D 联动", "Configure filters, drill-down and 3D actions")
          : tr(locale, "先创建场景再配置联动", "Create a scene before linking data"),
      facts.linkageReady,
      true,
      !facts.designReady,
    ),
    step(
      "behavior",
      tr(locale, "行为脚本", "Behavior scripts"),
      facts.behaviorReady ? tr(locale, "已配置场景行为", "Scene behavior configured") : tr(locale, "为对象添加可审计行为", "Add auditable object behavior"),
      facts.behaviorReady,
      false,
      !facts.designReady,
    ),
    step(
      "simulation",
      tr(locale, "仿真调试", "Simulate & debug"),
      facts.simulationReady
        ? tr(locale, "已有物理或动画工况", "Physics or animation scenario ready")
        : tr(locale, "可选：验证工况与联动", "Optional: validate scenarios and linkage"),
      facts.simulationReady,
      false,
      !facts.designReady,
    ),
    step(
      "validate",
      tr(locale, "交付校验", "Validate delivery"),
      facts.pendingAssetCount > 0
        ? tr(locale, `${facts.pendingAssetCount} 个资源待处理`, `${facts.pendingAssetCount} assets need attention`)
        : facts.validationReady
          ? tr(locale, "基础检查通过", "Basic checks passed")
          : tr(locale, "仍有必需项未就绪", "Required items are not ready"),
      facts.validationReady,
      true,
      !facts.validationReady,
    ),
    step(
      "publish",
      tr(locale, "发布运行", "Publish & run"),
      facts.published
        ? tr(locale, "已有发布版本", "Published version available")
        : facts.validationReady
          ? tr(locale, "可创建首个发布版本", "Ready for the first publication")
          : tr(locale, "需先完成交付校验", "Complete delivery validation first"),
      facts.published,
      true,
      !facts.validationReady,
    ),
  ];
}

/** 返回互不重复、可以直接处理的阻断项；校验和发布本身不重复计数。 */
export function buildDeliveryBlockers(locale: AppLocale, project: ProjectRecord, scenes: SceneSnapshot[]): DeliveryBlocker[] {
  const facts = deriveDeliveryWorkflowFacts(project, scenes);
  const blockers: DeliveryBlocker[] = [];
  if (!facts.dataReady)
    blockers.push({
      id: "data",
      stepId: "data",
      label: tr(locale, "数据尚未就绪", "Data is not ready"),
      detail: tr(locale, "至少启用一个连接并创建一个数据集", "Enable a connection and create a dataset"),
    });
  if (!facts.designReady)
    blockers.push({
      id: "design",
      stepId: "design",
      label: tr(locale, "尚未创建场景", "No scene exists"),
      detail: tr(locale, "创建二维页面或三维场景后再继续", "Create a 2D page or 3D scene to continue"),
    });
  if (facts.pendingAssetCount > 0)
    blockers.push({
      id: "assets",
      stepId: "assets",
      label: tr(locale, "资源处理未完成", "Asset processing is incomplete"),
      detail: tr(locale, `${facts.pendingAssetCount} 个模型失败或仍在处理中`, `${facts.pendingAssetCount} models failed or are still processing`),
    });
  if (facts.designReady && !facts.linkageReady)
    blockers.push({
      id: "linkage",
      stepId: "linkage",
      label: tr(locale, "场景尚未连接数据", "Scene data is not linked"),
      detail: tr(locale, "至少配置一个数据绑定或交互", "Add at least one data binding or interaction"),
    });
  return blockers;
}

export function firstIncompleteRequiredStep(steps: DeliveryStepState[]): DeliveryStepState | undefined {
  return steps.find((step) => step.required && !step.ready);
}

export function firstIncompleteStep(steps: DeliveryStepState[]): DeliveryStepState | undefined {
  return steps.find((step) => !step.ready);
}

function step(id: DeliveryStepId, label: string, detail: string, ready: boolean, required: boolean, blocked = false): DeliveryStepState {
  return { id, label, detail, ready, blocked, required };
}
