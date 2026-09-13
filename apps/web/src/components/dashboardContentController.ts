import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type {
  ApplicationDocument, ApplicationObjectRef, DashboardDataWidgetConfig, DashboardPageAppearance,
  DashboardPageDocument, DashboardViewportFit, DataDatasetField, ProjectRecord,
  SceneDashboardWidgetType, WidgetFrame, WidgetNode
} from "@bim-studio/contracts";
import {
  createDeleteDashboardPageCommand, createInsertDashboardNodeCommand,
  createInsertDashboardNodesCommand, createInsertDashboardPageCommand, createInsertDashboardPagesCommand,
  createRenameDashboardPageCommand, createUpdateDashboardDataWidgetCommand,
  createUpdateDashboardDataWidgetsCommand, createUpdateDashboardNodeStateCommand,
  createUpdateDashboardPageAppearanceCommand, createUpdateDashboardPageViewportCommand,
  createUpdateDashboardSceneViewportCommand, type StudioCommand
} from "@bim-studio/studio-core";
import { translate as tr, type AppLocale } from "../i18n";
import { isolateCopiedDashboardSamples } from "./dashboardSampleMetrics";
import type { DashboardViewState } from "../studio/workspaceRoute";
import type { DashboardComponentPreset } from "./DashboardComponentCatalog";
import {
  DASHBOARD_COMPONENT_BACKGROUNDS, dashboardComponentBackgroundText
} from "./DashboardComponentBackgroundCatalog";
import {
  createDashboardTemplateNodes, type DashboardTemplateKind
} from "./dashboardTemplateCatalog";
import { replaceDashboardWidgetDataProduct } from "./dashboardDataProductReplacement";
import { findIndustryTemplatePack } from "./industryTemplatePackCatalog";
import { buildIndustryPackImport } from "./industryPackImport";
import {
  TEMPLATE_FAVORITES_KEY, createDefaultDataWidget, dashboardNodeIdentity,
  dashboardInsertedNodeName, normalizeDashboardSize, uniqueDashboardNodeName
} from "./dashboardWorkspaceModel";

type DataWidgetNode = Extract<WidgetNode, { kind: "data-widget" }>;

interface DashboardContentControllerContext {
  locale: AppLocale;
  application: ApplicationDocument;
  project: ProjectRecord;
  page: DashboardPageDocument;
  zoom: number;
  busy: boolean;
  selectedNode: WidgetNode | undefined;
  selectedDataNodes: DataWidgetNode[];
  overflowNodeIds: string[];
  fieldsByProduct: Record<string, DataDatasetField[]>;
  analysisFields: DataDatasetField[];
  pageNameCommitRef: MutableRefObject<string>;
  backgroundImageRef: MutableRefObject<HTMLInputElement | null>;
  componentBackgroundImageRef: MutableRefObject<HTMLInputElement | null>;
  setSelectedNodeIds: Dispatch<SetStateAction<string[]>>;
  setNodeNameError: Dispatch<SetStateAction<string>>;
  setFavoriteTemplateIds: Dispatch<SetStateAction<string[]>>;
  onCommand: (command: StudioCommand) => void;
  onSelectPage: (pageId: string, view: DashboardViewState) => void;
  onSelectionChange: (selection: readonly ApplicationObjectRef[]) => void;
}

/** 管理页面、组件和数据绑定命令，使工作区视图保持单一职责。 */
export function createDashboardContentController(context: DashboardContentControllerContext) {
  const {
    locale, application, project, page, zoom, busy, selectedNode, selectedDataNodes,
    overflowNodeIds, fieldsByProduct, analysisFields, pageNameCommitRef,
    backgroundImageRef, componentBackgroundImageRef, setSelectedNodeIds,
    setNodeNameError, setFavoriteTemplateIds, onCommand, onSelectPage,
    onSelectionChange
  } = context;

  function openInsertedPage(nextPage: DashboardPageDocument) {
    onCommand(createInsertDashboardPageCommand(nextPage));
    onSelectPage(nextPage.id, { zoom, scrollLeft: 0, scrollTop: 0, selectedNodeIds: [] });
  }

  function addDashboardPage() {
    const nextPage: DashboardPageDocument = {
      id: `page:${crypto.randomUUID()}`,
      name: tr(locale, `页面 ${application.pages.length + 1}`, `Page ${application.pages.length + 1}`),
      width: page.width,
      height: page.height,
      viewportFit: page.viewportFit,
      appearance: structuredClone(page.appearance ?? {}),
      nodes: []
    };
    openInsertedPage(nextPage);
  }

  function duplicateDashboardPage() {
    const pageId = `page:${crypto.randomUUID()}`;
    const nodeIds = new Map(page.nodes.map((node) => [node.id, `${node.kind}:${crypto.randomUUID()}`]));
    const groupIds = new Map([...new Set(page.nodes.flatMap((node) => node.groupId ? [node.groupId] : []))].map((groupId) => [groupId, `group:${crypto.randomUUID()}`]));
    const nextPage: DashboardPageDocument = {
      ...structuredClone(page),
      id: pageId,
      name: tr(locale, `${page.name} 副本`, `${page.name} copy`),
      nodes: isolateCopiedDashboardSamples(page.nodes.map((node) => ({ ...structuredClone(node), id: nodeIds.get(node.id)!, ...(node.groupId ? { groupId: groupIds.get(node.groupId)! } : {}) })))
    };
    const interactions = application.interactions.flatMap((flow) => {
      const source = flow.source.kind === "page" && flow.source.id === page.id
        ? { kind: "page" as const, id: pageId }
        : flow.source.kind === "widget" && nodeIds.has(flow.source.id)
          ? { kind: "widget" as const, id: nodeIds.get(flow.source.id)! }
          : undefined;
      return source ? [{ ...structuredClone(flow), id: `flow:${crypto.randomUUID()}`, name: tr(locale, `${flow.name} 副本`, `${flow.name} copy`), source }] : [];
    });
    onCommand(createInsertDashboardPageCommand(nextPage, interactions));
    onSelectPage(nextPage.id, { zoom, scrollLeft: 0, scrollTop: 0, selectedNodeIds: [] });
  }

  function deleteDashboardPage(pageId: string) {
    if (application.pages.length <= 1 || busy) return;
    const fallback = application.pages.find((candidate) => candidate.id !== pageId)!;
    onCommand(createDeleteDashboardPageCommand(pageId));
    if (page.id === pageId) onSelectPage(fallback.id, { zoom, scrollLeft: 0, scrollTop: 0, selectedNodeIds: [] });
  }

  function commitPageName(value: string) {
    const name = value.trim();
    if (!name || name === pageNameCommitRef.current) return;
    pageNameCommitRef.current = name;
    onCommand(createRenameDashboardPageCommand(page.id, name));
  }

  function commitPageViewport(viewport: { width?: number; height?: number; viewportFit?: DashboardViewportFit }) {
    const width = normalizeDashboardSize(viewport.width ?? page.width, page.width);
    const height = normalizeDashboardSize(viewport.height ?? page.height, page.height);
    const viewportFit = viewport.viewportFit ?? page.viewportFit;
    if (width === page.width && height === page.height && viewportFit === page.viewportFit) return;
    onCommand(createUpdateDashboardPageViewportCommand(page.id, { width, height, viewportFit }));
  }

  function updatePageAppearance(patch: Partial<DashboardPageAppearance>) {
    const appearance = { ...(page.appearance ?? {}), ...patch };
    for (const [key, value] of Object.entries(appearance)) if (value === undefined || value === "") delete (appearance as Record<string, unknown>)[key];
    onCommand(createUpdateDashboardPageAppearanceCommand(page.id, appearance));
  }

  async function uploadPageBackground(file: File | undefined) {
    if (!file) return;
    const { api } = await import("../api");
    const asset = await api.uploadImageAsset(project.id, file);
    updatePageAppearance({ backgroundImageUrl: asset.url, backgroundImageName: asset.name, backgroundImageFit: page.appearance?.backgroundImageFit ?? "cover" });
    if (backgroundImageRef.current) backgroundImageRef.current.value = "";
  }

  function clearPageBackground() {
    const appearance = { ...(page.appearance ?? {}) };
    delete appearance.backgroundImageUrl;
    delete appearance.backgroundImageName;
    onCommand(createUpdateDashboardPageAppearanceCommand(page.id, appearance));
  }

  async function uploadComponentBackground(file: File | undefined) {
    if (!file || !selectedNode || selectedNode.kind !== "data-widget") return;
    const nodeId = selectedNode.id;
    const current = structuredClone(selectedNode.widget);
    const { api } = await import("../api");
    const asset = await api.uploadImageAsset(project.id, file);
    onCommand(createUpdateDashboardDataWidgetCommand(page.id, nodeId, { ...current, componentBackgroundImageUrl: asset.url, componentBackgroundImageName: asset.name, componentBackgroundImageFit: current.componentBackgroundImageFit ?? "cover" }));
    if (componentBackgroundImageRef.current) componentBackgroundImageRef.current.value = "";
  }

  function clearComponentBackground() {
    if (!selectedNode || selectedNode.kind !== "data-widget") return;
    const widget = { ...selectedNode.widget };
    delete widget.componentBackgroundImageUrl;
    delete widget.componentBackgroundImageName;
    onCommand(createUpdateDashboardDataWidgetCommand(page.id, selectedNode.id, widget));
  }

  function applyComponentBackground(asset: (typeof DASHBOARD_COMPONENT_BACKGROUNDS)[number]) {
    if (!selectedNode || selectedNode.kind !== "data-widget") return;
    updateDataWidget({ componentBackgroundImageUrl: asset.url, componentBackgroundImageName: dashboardComponentBackgroundText(asset, locale), componentBackgroundImageFit: "stretch", componentBackgroundImagePosition: "center", componentBackgroundImageRepeat: false });
  }

  function selectOverflowNodes() {
    setSelectedNodeIds(overflowNodeIds);
    onSelectionChange(overflowNodeIds.map((id) => ({ kind: "widget", id })));
  }

  function addDataWidget(
    type: SceneDashboardWidgetType,
    widgetPatch: Partial<DashboardDataWidgetConfig> = {},
    framePatch: DashboardComponentPreset["frame"] = {},
    placement?: { centerX: number; centerY: number },
    nameHint?: string,
  ) {
    const id = `widget:${crypto.randomUUID()}`;
    const index = page.nodes.filter((node) => node.kind === "data-widget").length;
    const wide = ["line", "area", "bar", "combo", "pie", "scatter", "radar", "funnel", "rank", "table", "scroll-table", "filter", "image", "video", "monitor", "url", "topology", "decoration"].includes(type);
    // Unity 是可操作场景而非缩略媒体，默认按 16:9 提供足够的调试与交互空间。
    const width = framePatch.width ?? (type === "unity" ? 640 : wide ? 420 : 260);
    const height = framePatch.height ?? (type === "unity" ? 360 : type === "decoration" ? 72 : wide || type === "gauge" ? 240 : 140);
    const frame: WidgetFrame = placement
      ? {
          x: Math.max(0, Math.min(page.width - width, Math.round(placement.centerX - width / 2))),
          y: Math.max(0, Math.min(page.height - height, Math.round(placement.centerY - height / 2))),
          width,
          height
        }
      : { x: 48 + index % 4 * 28, y: 48 + index % 4 * 28, width, height };
    const node: WidgetNode = {
      id,
      name: dashboardInsertedNodeName(locale, type, widgetPatch, nameHint, page.nodes),
      kind: "data-widget",
      frame,
      zIndex: Math.max(0, ...page.nodes.map((item) => item.zIndex)) + 1,
      widget: { ...createDefaultDataWidget(locale, type), ...widgetPatch }
    };
    onCommand(createInsertDashboardNodeCommand(page.id, node));
    setSelectedNodeIds([id]);
    onSelectionChange([{ kind: "widget", id }]);
  }

  function addSceneViewport(placement?: { centerX: number; centerY: number }) {
    const scene = application.scenes[0];
    if (!scene) return;
    const id = `scene-viewport:${crypto.randomUUID()}`;
    const name = uniqueDashboardNodeName(scene.name || tr(locale, "三维场景", "3D scene"), new Set(page.nodes.map((item) => dashboardNodeIdentity(item).toLocaleLowerCase())));
    const width = Math.min(960, Math.max(420, page.width - 96));
    const height = Math.min(600, Math.max(260, page.height - 96));
    const frame: WidgetFrame = placement
      ? {
          x: Math.max(0, Math.min(page.width - width, Math.round(placement.centerX - width / 2))),
          y: Math.max(0, Math.min(page.height - height, Math.round(placement.centerY - height / 2))),
          width,
          height
        }
      : { x: 48, y: 48, width, height };
    onCommand(createInsertDashboardNodeCommand(page.id, {
      id,
      name,
      kind: "scene-viewport",
      frame,
      zIndex: Math.max(0, ...page.nodes.map((item) => item.zIndex)) + 1,
      sceneId: scene.id,
      renderMode: "realtime",
      interactionPolicy: "full-navigation",
      overlaySlot: "page"
    }));
    setSelectedNodeIds([id]);
    onSelectionChange([{ kind: "widget", id }]);
  }

  function insertDashboardTemplate(kind: DashboardTemplateKind) {
    if (busy) return;
    const nodes = createDashboardTemplateNodes(locale, page, kind, Math.max(0, ...page.nodes.map((node) => node.zIndex)) + 1);
    onCommand(createInsertDashboardNodesCommand(page.id, nodes));
    setSelectedNodeIds(nodes.map((node) => node.id));
    onSelectionChange(nodes.map((node) => ({ kind: "widget", id: node.id })));
  }

  /** 整包一条命令；保留既有发布配置，仅空应用的默认首页采用新包入口。 */
  function insertIndustryPack(packId: string) {
    if (busy) return;
    const pack = findIndustryTemplatePack(packId);
    if (!pack) return;
    const emptyFirstPage = application.pages.length === 1 && application.pages[0]!.nodes.length === 0;
    const imported = buildIndustryPackImport(pack, locale, page);
    onCommand(createInsertDashboardPagesCommand(imported.pages, imported.interactions, emptyFirstPage ? 0 : undefined, emptyFirstPage ? imported.entryPageId : undefined));
    onSelectPage(imported.entryPageId, { zoom, scrollLeft: 0, scrollTop: 0, selectedNodeIds: [] });
  }

  function updateSceneViewport(patch: Partial<Pick<Extract<WidgetNode, { kind: "scene-viewport" }>, "sceneId" | "cameraViewId" | "renderMode" | "interactionPolicy">>) {
    if (!selectedNode || selectedNode.kind !== "scene-viewport") return;
    const next = { sceneId: selectedNode.sceneId, renderMode: selectedNode.renderMode, interactionPolicy: selectedNode.interactionPolicy, ...(selectedNode.cameraViewId ? { cameraViewId: selectedNode.cameraViewId } : {}), ...patch };
    if (!next.cameraViewId) delete next.cameraViewId;
    onCommand(createUpdateDashboardSceneViewportCommand(page.id, selectedNode.id, next));
  }

  function commitNodeName(value: string) {
    if (!selectedNode) return;
    const name = value.trim();
    if (!name) {
      setNodeNameError(tr(locale, "组件名称不能为空", "Component name is required"));
      return;
    }
    const duplicated = page.nodes.some((node) => node.id !== selectedNode.id && dashboardNodeIdentity(node).toLocaleLowerCase() === name.toLocaleLowerCase());
    if (duplicated) {
      setNodeNameError(tr(locale, "当前页面已有同名组件", "This page already contains that component name"));
      return;
    }
    setNodeNameError("");
    if (selectedNode.name !== name) onCommand(createUpdateDashboardNodeStateCommand(page.id, selectedNode.id, { name }));
  }

  function updateDataWidget(patch: Partial<DashboardDataWidgetConfig>) {
    if (!selectedNode || selectedNode.kind !== "data-widget") return;
    // 同一模板实例的示例快照一起更新；一个撤销命令，重复插入的模板互不影响。
    const sourceId = selectedNode.widget.sampleData?.sourceId;
    if (patch.sampleData && sourceId) {
      onCommand(createUpdateDashboardDataWidgetsCommand(page.id, page.nodes.flatMap(node =>
        node.kind === "data-widget" && node.widget.sampleData?.sourceId === sourceId
          ? [{ nodeId: node.id, widget: { ...node.widget, sampleData: { ...patch.sampleData!, sourceId } } }] : []), tr(locale, "修改示例数据", "Edit sample data")));
      return;
    }
    onCommand(createUpdateDashboardDataWidgetCommand(page.id, selectedNode.id, { ...selectedNode.widget, ...patch }));
  }

  function selectDataProduct(value: string) {
    if (!selectedNode || selectedNode.kind !== "data-widget") return;
    const next = { ...selectedNode.widget };
    delete next.datasetId;
    delete next.pipelineId;
    delete next.directBinding;
    delete next.sampleData;
    delete next.field;
    if (value) {
      const separator = value.indexOf(":");
      const kind = value.slice(0, separator);
      const id = value.slice(separator + 1);
      if (kind === "dataset") next.datasetId = id;
      if (kind === "pipeline") next.pipelineId = id;
      const firstField = fieldsByProduct[value]?.[0];
      if (firstField) {
        next.field = firstField.key;
        next.key = `${id}.${firstField.key}`;
        if (!next.unit && firstField.unit) next.unit = firstField.unit;
      }
    }
    onCommand(createUpdateDashboardDataWidgetCommand(page.id, selectedNode.id, next));
  }

  function replaceSelectedDataProduct(value: string) {
    if (!value || selectedDataNodes.length === 0) return;
    const fields = fieldsByProduct[value] ?? [];
    onCommand(createUpdateDashboardDataWidgetsCommand(page.id, selectedDataNodes.map((node) => ({
      nodeId: node.id,
      widget: replaceDashboardWidgetDataProduct(node.widget, value, fields)
    })), tr(locale, `整组替换 ${selectedDataNodes.length} 个组件的数据产品`, `Replace data product for ${selectedDataNodes.length} widgets`)));
  }

  function toggleTemplateFavorite(id: string) {
    setFavoriteTemplateIds((current) => {
      const next = current.includes(id) ? current.filter((candidate) => candidate !== id) : [...current, id];
      try { localStorage.setItem(TEMPLATE_FAVORITES_KEY, JSON.stringify(next)); } catch { /* Storage is optional. */ }
      return next;
    });
  }

  function selectDataField(fieldKey: string) {
    if (!selectedNode || selectedNode.kind !== "data-widget") return;
    const productId = selectedNode.widget.pipelineId ?? selectedNode.widget.datasetId;
    const productKey = selectedNode.widget.pipelineId ? `pipeline:${selectedNode.widget.pipelineId}` : selectedNode.widget.datasetId ? `dataset:${selectedNode.widget.datasetId}` : undefined;
    if (!productId || !productKey) return;
    const field = fieldsByProduct[productKey]?.find((candidate) => candidate.key === fieldKey);
    updateDataWidget({ field: fieldKey, key: `${productId}.${fieldKey}`, ...(!selectedNode.widget.unit && field?.unit ? { unit: field.unit } : {}) });
  }

  function assignAnalysisField(fieldKey: string, role: "dimension" | "measure" | "series") {
    if (!selectedNode || selectedNode.kind !== "data-widget") return;
    const field = analysisFields.find((candidate) => candidate.key === fieldKey);
    const analysis = {
      aggregation: selectedNode.widget.analysis?.aggregation ?? (role === "measure" ? "sum" : "none"),
      ...selectedNode.widget.analysis,
      ...(role === "dimension" ? { dimensionField: fieldKey } : role === "measure" ? { measureField: fieldKey } : { seriesField: fieldKey })
    } satisfies NonNullable<DashboardDataWidgetConfig["analysis"]>;
    const patch: Partial<DashboardDataWidgetConfig> = { analysis };
    if (role === "measure") {
      const productId = selectedNode.widget.pipelineId ?? selectedNode.widget.datasetId;
      patch.field = fieldKey;
      if (productId) patch.key = `${productId}.${fieldKey}`;
      if (!selectedNode.widget.unit && field?.unit) patch.unit = field.unit;
    }
    if (["table", "scroll-table"].includes(selectedNode.widget.type)) {
      patch.report = {
        mode: selectedNode.widget.report?.mode ?? "detail",
        ...selectedNode.widget.report,
        ...(role === "dimension" ? { rowField: fieldKey } : role === "measure" ? { valueField: fieldKey, valueFields: [fieldKey] } : { columnField: fieldKey })
      };
    }
    if (selectedNode.widget.type === "map") {
      patch.map = {
        mode: selectedNode.widget.map?.mode ?? "region",
        ...selectedNode.widget.map,
        ...(role === "dimension" ? { regionField: fieldKey } : role === "measure" ? { valueField: fieldKey } : {})
      };
    }
    updateDataWidget(patch);
  }

  function toggleReportValueField(fieldKey: string) {
    if (!selectedNode || selectedNode.kind !== "data-widget") return;
    const report = selectedNode.widget.report;
    const configured = report?.valueFields?.filter(Boolean) ?? [];
    const fallback = report?.valueField ?? selectedNode.widget.analysis?.measureField ?? selectedNode.widget.field;
    const current = configured.length ? configured : fallback ? [fallback] : [];
    const valueFields = current.includes(fieldKey)
      ? current.length > 1 ? current.filter((key) => key !== fieldKey) : current
      : [...current, fieldKey];
    updateDataWidget({
      report: {
        mode: report?.mode ?? "grouped",
        ...report,
        valueField: valueFields[0] ?? fieldKey,
        valueFields
      }
    });
  }
  return {
    addDashboardPage, duplicateDashboardPage, deleteDashboardPage, commitPageName,
    commitPageViewport, updatePageAppearance, uploadPageBackground, clearPageBackground,
    uploadComponentBackground, clearComponentBackground, applyComponentBackground,
    selectOverflowNodes, addDataWidget, addSceneViewport, insertDashboardTemplate,
    insertIndustryPack,
    updateSceneViewport, commitNodeName, updateDataWidget, selectDataProduct,
    replaceSelectedDataProduct, toggleTemplateFavorite, selectDataField,
    assignAnalysisField, toggleReportValueField
  };
}
