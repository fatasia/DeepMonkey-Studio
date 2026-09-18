import { getSceneModelAssetId, type ProjectRecord, type SceneDashboardWidgetState, type SceneMaterialScreenState, type SceneModelState, type SceneSnapshot, type SceneSpatialAudioState } from "@bim-studio/contracts";
import { createEvidenceFingerprint, EVIDENCE_FINGERPRINT_ALGORITHM } from "@bim-studio/studio-core";

/** A persisted enabled connector is runnable; unsupported connector types are rejected by the API before persistence. */
export function hasPublicationDataProduct(project: Pick<ProjectRecord, "dataConnections" | "datasets">): boolean {
  return (project.dataConnections ?? []).some((connection) => connection.enabled) && (project.datasets?.length ?? 0) > 0;
}

export type PublicationAuditSeverity = "blocker" | "warning" | "recommendation";
export type PublicationAuditCategory = "asset" | "data" | "interaction" | "runtime";

export interface PublicationAuditIssue {
  id: string;
  severity: PublicationAuditSeverity;
  category: PublicationAuditCategory;
  title: string;
  detail: string;
  remediation: string;
  sceneId?: string;
  targetId?: string;
}

export interface PublicationAuditReport {
  status: "blocked" | "warning" | "ready";
  blockers: number;
  warnings: number;
  recommendations: number;
  issues: PublicationAuditIssue[];
  evidenceFingerprint: string;
  fingerprintAlgorithm: typeof EVIDENCE_FINGERPRINT_ALGORITHM;
}

/**
 * 发布体检坚持确定性规则优先：断链、空引用和危险URL不需要大模型猜测。
 * AI只负责后续解释和生成修复草案，不能覆盖这些硬门禁。
 */
export function assessProjectPublication(project: ProjectRecord, scenes: SceneSnapshot[]): PublicationAuditReport {
  return assessPublication(project, scenes, scenes);
}

/** 只检查待发布快照，其他场景仅用于解析跳转引用，不把无关草稿的问题带入本次发布。 */
export function assessScenePublication(project: ProjectRecord, scene: SceneSnapshot, referenceScenes: SceneSnapshot[]): PublicationAuditReport {
  const references = [...referenceScenes.filter((candidate) => candidate.id !== scene.id), scene];
  return assessPublication(project, [scene], references);
}

function assessPublication(project: ProjectRecord, scenes: SceneSnapshot[], references: SceneSnapshot[]): PublicationAuditReport {
  const issues = scenes.flatMap((scene) => assessScene(project, references, scene));
  if (scenes.length === 0) {
    issues.push(issue("scene:none", "blocker", "runtime", "没有可发布场景", "项目尚未创建任何场景。", "先创建并保存一个场景。"));
  }
  if (scenes.length > 0 && !scenes.some((scene) => scene.publishedAt)) {
    issues.push(issue("runtime:no-rollback", "recommendation", "runtime", "尚无回退基线", "首次发布前没有可恢复的稳定版本。", "首次验证通过后发布一个基线版本。"));
  }
  const blockers = issues.filter((item) => item.severity === "blocker").length;
  const warnings = issues.filter((item) => item.severity === "warning").length;
  const recommendations = issues.filter((item) => item.severity === "recommendation").length;
  const report = {
    status: blockers > 0 ? "blocked" as const : warnings > 0 ? "warning" as const : "ready" as const,
    blockers,
    warnings,
    recommendations,
    issues,
  };
  return {
    ...report,
    evidenceFingerprint: createEvidenceFingerprint({ project, scenes, report }),
    fingerprintAlgorithm: EVIDENCE_FINGERPRINT_ALGORITHM,
  };
}

function assessScene(project: ProjectRecord, scenes: SceneSnapshot[], scene: SceneSnapshot): PublicationAuditIssue[] {
  const issues: PublicationAuditIssue[] = [];
  // 模型与基本体共享运行时对象 ID；资源检查仍只应用于导入模型。
  const objects = [...scene.models, ...scene.primitives];
  assessDuplicateIds(scene, objects.map((object) => object.modelId), "object", issues);
  assessDuplicateIds(scene, (scene.dashboard?.widgets ?? []).map((widget) => widget.id), "widget", issues);
  const sceneModels = new Map(objects.map((model) => [model.modelId, model]));
  const widgets = new Map((scene.dashboard?.widgets ?? []).map((widget) => [widget.id, widget]));
  const datasets = new Map((project.datasets ?? []).map((dataset) => [dataset.id, dataset]));
  const pipelines = new Set((project.dataPipelines ?? []).map((pipeline) => pipeline.id));
  const annotations = new Set((scene.annotations ?? []).map((annotation) => annotation.id));
  const projectModels = new Map(project.models.map((model) => [model.id, model]));

  for (const model of scene.models) assessModel(projectModels, scene, model, issues);
  assessAssetBindings(scene, sceneModels, annotations, issues);
  for (const binding of scene.dataBindings ?? []) {
    if (!binding.enabled) continue;
    const sources = [binding.datasetId, binding.pipelineId, binding.directBinding].filter(Boolean).length;
    if (sources !== 1) issues.push(sceneIssue(scene, `binding:${binding.id}:source`, "blocker", "data", "数据绑定缺少唯一来源", `“${binding.name}”必须且只能选择数据集、管道或直接数据源之一。`, "打开数据绑定并重新选择来源。", binding.id));
    if (binding.datasetId) {
      const dataset = datasets.get(binding.datasetId);
      if (!dataset) issues.push(sceneIssue(scene, `binding:${binding.id}:dataset`, "blocker", "data", "数据集引用已失效", `绑定“${binding.name}”引用了不存在的数据集。`, "重新选择数据集或删除该绑定。", binding.id));
      else if (binding.field && !dataset.fields.some((field) => field.key === binding.field) && !(dataset.computedFields ?? []).some((field) => field.key === binding.field)) {
        issues.push(sceneIssue(scene, `binding:${binding.id}:field`, "blocker", "data", "数据字段引用已失效", `字段“${binding.field}”不在数据集“${dataset.name}”中。`, "重新选择字段并预览一次数据。", binding.id));
      }
    }
    if (binding.pipelineId && !pipelines.has(binding.pipelineId)) issues.push(sceneIssue(scene, `binding:${binding.id}:pipeline`, "blocker", "data", "数据管道引用已失效", `绑定“${binding.name}”引用了不存在的数据管道。`, "重新选择管道或删除该绑定。", binding.id));
    assessObjectTarget(scene, sceneModels, annotations, binding.target, `binding:${binding.id}`, binding.id, issues);
  }

  for (const widget of widgets.values()) assessWidget(project, scene, widget, datasets, pipelines, issues);
  for (const interaction of scene.interactions ?? []) {
    if (!interaction.enabled) continue;
    if (interaction.target.kind === "widget" && !widgets.has(interaction.target.widgetId)) {
      issues.push(sceneIssue(scene, `interaction:${interaction.id}:widget`, "blocker", "interaction", "交互组件引用已失效", `交互“${interaction.name}”引用了不存在的组件。`, "重新选择触发组件。", interaction.id));
    }
    if (interaction.target.kind === "object") assessObjectTarget(scene, sceneModels, annotations, interaction.target, `interaction:${interaction.id}:trigger`, interaction.id, issues);
    const enabledActions = (interaction.actions ?? []).filter((action) => action.enabled);
    if (!interaction.code.trim() && enabledActions.length === 0) issues.push(sceneIssue(scene, `interaction:${interaction.id}:empty`, "warning", "interaction", "交互没有可执行动作", `交互“${interaction.name}”已启用，但没有脚本或动作。`, "添加动作、脚本或停用该交互。", interaction.id));
    for (const action of enabledActions) {
      if (action.target) assessObjectTarget(scene, sceneModels, annotations, action.target, `interaction:${interaction.id}:action:${action.id}`, interaction.id, issues);
      if (action.type === "navigateScene" && (!action.sceneId || !scenes.some((candidate) => candidate.id === action.sceneId))) issues.push(sceneIssue(scene, `interaction:${interaction.id}:scene:${action.id}`, "blocker", "interaction", "跳转场景不存在", `动作引用的场景“${action.sceneId ?? "未设置"}”不存在。`, "重新选择目标场景。", interaction.id));
      if (action.type === "cameraView" && (!action.cameraViewId || !(scene.cameraViews ?? []).some((view) => view.id === action.cameraViewId))) issues.push(sceneIssue(scene, `interaction:${interaction.id}:camera:${action.id}`, "blocker", "interaction", "相机视图不存在", `动作引用的相机视图“${action.cameraViewId ?? "未设置"}”不存在。`, "重新选择相机视图。", interaction.id));
      if (action.type === "openUrl" && !safePublishedUrl(action.url)) issues.push(sceneIssue(scene, `interaction:${interaction.id}:url:${action.id}`, "blocker", "interaction", "外部链接不安全或无效", `动作链接“${action.url ?? "未设置"}”不是HTTPS地址。`, "改为HTTPS地址，或移除该动作。", interaction.id));
    }
  }
  return issues;
}

function assessDuplicateIds(scene: SceneSnapshot, ids: string[], kind: "object" | "widget", issues: PublicationAuditIssue[]): void {
  const seen = new Set<string>();
  const reported = new Set<string>();
  for (const id of ids) {
    if (seen.has(id) && !reported.has(id)) {
      issues.push(sceneIssue(scene, `${kind}:${id}:duplicate`, "blocker", kind === "object" ? "asset" : "interaction",
        kind === "object" ? "三维对象 ID 重复" : "组件 ID 重复", `多个对象使用了标识“${id}”，运行时无法确定引用目标。`, "为重复对象分配不同标识并重新保存。", id));
      reported.add(id);
    }
    seen.add(id);
  }
}

function assessAssetBindings(
  scene: SceneSnapshot,
  models: Map<string, SceneModelState>,
  annotations: Set<string>,
  issues: PublicationAuditIssue[],
): void {
  const seenObjects = new Set<string>();
  const seenDevices = new Set<string>();
  for (const binding of scene.assetBindings ?? []) {
    assessObjectTarget(scene, models, annotations, binding, `asset-binding:${binding.id}`, binding.id, issues);
    if (seenObjects.has(binding.sceneObjectId) || seenDevices.has(binding.deviceId)) {
      issues.push(sceneIssue(
        scene,
        `asset-binding:${binding.id}:duplicate`,
        "blocker",
        "asset",
        "设备映射存在冲突",
        `对象“${binding.objectName}”或设备“${binding.deviceId}”被重复绑定。`,
        "打开智能绑定工作台，重新确认一对一映射。",
        binding.id,
      ));
    }
    seenObjects.add(binding.sceneObjectId);
    seenDevices.add(binding.deviceId);
  }
}

function assessModel(projectModels: Map<string, ProjectRecord["models"][number]>, scene: SceneSnapshot, model: SceneModelState, issues: PublicationAuditIssue[]): void {
  assessModelScreen(scene, model, model.material?.screen, `model:${model.modelId}:screen`, model.modelId, issues);
  assessSpatialAudio(scene, model, model.spatialAudio, issues);
  for (const layer of model.layers ?? []) {
    assessModelScreen(scene, model, layer.material?.screen, `model:${model.modelId}:layer:${layer.nodeId}:screen`, layer.nodeId, issues);
  }
  const source = projectModels.get(getSceneModelAssetId(model));
  if (!source) {
    issues.push(sceneIssue(scene, `model:${model.modelId}:missing`, "blocker", "asset", "场景模型已断链", `模型“${model.name}”不在项目资产库中。`, "重新导入或替换该模型。", model.modelId));
    return;
  }
  if (source.status !== "ready") issues.push(sceneIssue(scene, `model:${model.modelId}:status`, "blocker", "asset", "模型尚不可交付", `模型“${model.name}”当前状态为 ${source.status}。`, "等待转换完成、配置转换器或替换失败模型。", model.modelId));
}

function assessSpatialAudio(
  scene: SceneSnapshot,
  model: SceneModelState,
  audio: SceneSpatialAudioState | undefined,
  issues: PublicationAuditIssue[],
): void {
  if (!audio?.enabled) return;
  const id = `model:${model.modelId}:spatial-audio`;
  if (!safePublishedMediaUrl(audio.url)) {
    issues.push(sceneIssue(scene, id, "blocker", "asset", "空间音频资源无效", `“${model.name}”的空间音频不是可发布的站内路径或 HTTPS 地址。`, "从项目资源重新选择音频资源。", model.modelId));
    return;
  }
  if (/^https:\/\//i.test(audio.url)) {
    issues.push(sceneIssue(scene, `${id}:external`, "warning", "asset", "空间音频依赖外部网络", `“${model.name}”的空间音频来自外部地址，离线客户端可能无法播放。`, "发布客户端前将音频导入项目资源。", model.modelId));
  }
}

function assessModelScreen(
  scene: SceneSnapshot,
  model: SceneModelState,
  screen: SceneMaterialScreenState | undefined,
  id: string,
  targetId: string,
  issues: PublicationAuditIssue[],
): void {
  if (!screen?.enabled) return;
  if (!safePublishedMediaUrl(screen.url)) {
    issues.push(sceneIssue(scene, id, "blocker", "asset", "模型屏幕资源无效", `“${model.name}”的屏幕资源不是可发布的站内路径或 HTTPS 地址。`, "从项目资源重新选择图片或视频资源。", targetId));
    return;
  }
  if (/^https:\/\//i.test(screen.url)) {
    issues.push(sceneIssue(scene, `${id}:external`, "warning", "asset", "模型屏幕依赖外部网络", `“${model.name}”的屏幕资源来自外部地址，离线客户端可能无法显示。`, "发布客户端前将媒体导入项目资源。", targetId));
  }
}

function assessWidget(
  project: ProjectRecord,
  scene: SceneSnapshot,
  widget: SceneDashboardWidgetState,
  datasets: Map<string, NonNullable<ProjectRecord["datasets"]>[number]>,
  pipelines: Set<string>,
  issues: PublicationAuditIssue[],
): void {
  if (widget.datasetId && !datasets.has(widget.datasetId)) issues.push(sceneIssue(scene, `widget:${widget.id}:dataset`, "blocker", "data", "组件数据集已失效", `组件“${widget.title}”引用了不存在的数据集。`, "重新选择数据集。", widget.id));
  if (widget.pipelineId && !pipelines.has(widget.pipelineId)) issues.push(sceneIssue(scene, `widget:${widget.id}:pipeline`, "blocker", "data", "组件数据管道已失效", `组件“${widget.title}”引用了不存在的数据管道。`, "重新选择数据管道。", widget.id));
  if (widget.assetId && !(project.assets ?? []).some((asset) => asset.id === widget.assetId)) issues.push(sceneIssue(scene, `widget:${widget.id}:asset`, "blocker", "asset", "媒体资产已断链", `组件“${widget.title}”引用了不存在的媒体资产。`, "重新上传或选择媒体资产。", widget.id));
  const requiredUrl = widget.type === "url" ? widget.url : widget.type === "monitor" ? widget.monitorSourceUrl : undefined;
  if ((widget.type === "url" || widget.type === "monitor") && !safePublishedUrl(requiredUrl)) issues.push(sceneIssue(scene, `widget:${widget.id}:url`, "blocker", "asset", "组件地址无效", `组件“${widget.title}”缺少可发布的HTTPS地址。`, "配置HTTPS地址并在发布环境测试。", widget.id));
  if (widget.type === "unity" && widget.unityResourceId && !(project.unityResources ?? []).some((resource) => resource.id === widget.unityResourceId)) issues.push(sceneIssue(scene, `widget:${widget.id}:unity`, "blocker", "asset", "Unity资源已断链", `组件“${widget.title}”引用了不存在的Unity资源。`, "重新选择Unity构建资源。", widget.id));
}

function assessObjectTarget(
  scene: SceneSnapshot,
  models: Map<string, SceneModelState>,
  annotations: Set<string>,
  target: { modelId?: string; layerId?: string; annotationId?: string },
  id: string,
  targetId: string,
  issues: PublicationAuditIssue[],
): void {
  if (target.modelId) {
    const model = models.get(target.modelId);
    if (!model) issues.push(sceneIssue(scene, `${id}:model`, "blocker", "interaction", "三维目标不存在", `引用的模型“${target.modelId}”不在当前场景。`, "重新选择三维目标。", targetId));
    else if (target.layerId && !(model.layers ?? []).some((layer) => layer.nodeId === target.layerId && !layer.deleted)) issues.push(sceneIssue(scene, `${id}:layer`, "blocker", "interaction", "模型内部对象不存在", `引用的对象“${target.layerId}”已删除或未加载。`, "重新选择模型对象。", targetId));
  }
  if (target.annotationId && !annotations.has(target.annotationId)) issues.push(sceneIssue(scene, `${id}:annotation`, "blocker", "interaction", "标注目标不存在", `引用的标注“${target.annotationId}”不存在。`, "重新选择标注目标。", targetId));
}

function safePublishedUrl(value: string | undefined): boolean {
  if (!value?.trim()) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function safePublishedMediaUrl(value: string | undefined): boolean {
  if (!value?.trim() || value.length > 4_096 || /\p{Cc}/u.test(value)) return false;
  if (value.startsWith("/") && !value.startsWith("//")) return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function sceneIssue(scene: SceneSnapshot, id: string, severity: PublicationAuditSeverity, category: PublicationAuditCategory, title: string, detail: string, remediation: string, targetId?: string): PublicationAuditIssue {
  return issue(`${scene.id}:${id}`, severity, category, title, detail, remediation, scene.id, targetId);
}

function issue(id: string, severity: PublicationAuditSeverity, category: PublicationAuditCategory, title: string, detail: string, remediation: string, sceneId?: string, targetId?: string): PublicationAuditIssue {
  return { id, severity, category, title, detail, remediation, ...(sceneId ? { sceneId } : {}), ...(targetId ? { targetId } : {}) };
}
