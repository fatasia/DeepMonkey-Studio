import type { DashboardDataWidgetNode, DashboardPageDocument, InteractionFlow } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import { createDashboardTemplateNodes, DASHBOARD_TEMPLATES } from "./DashboardTemplateCatalog";
import { packPageSample } from "./industryTemplatePackCatalog";
import { applyPackPageSample } from "./industryPackSampleApply";
import { validateIndustryTemplatePack, type IndustryTemplatePack } from "./industryTemplatePackTypes";

/** 纯构造阶段：任何页面失败都发生在命令提交前；页间引用只使用本次导入的新 ID。 */
export function buildIndustryPackImport(pack: IndustryTemplatePack, locale: AppLocale, base: DashboardPageDocument) {
  validateIndustryTemplatePack(pack, DASHBOARD_TEMPLATES.map(template => template.id));
  const instanceId = `pack:${pack.id}:${crypto.randomUUID()}`;
  const filterKey = `${instanceId}:filter`;
  const pagesByTemplate = new Map<string, DashboardPageDocument>(pack.pages.map(spec => [spec.templateId, {
    id: `page:${crypto.randomUUID()}`, name: tr(locale, spec.nameZh, spec.nameEn),
    width: base.width, height: base.height, viewportFit: base.viewportFit,
    templateSource: { kind: "industry-pack", packId: pack.id, revision: pack.revision, pageTemplateId: spec.templateId, instanceId },
    appearance: structuredClone(base.appearance ?? {}), nodes: [],
  }]));
  const interactions: InteractionFlow[] = [];
  for (const spec of pack.pages) {
    const page = pagesByTemplate.get(spec.templateId)!;
    const layout = { ...page, height: Math.max(1, page.height - 64) };
    page.nodes = applyPackPageSample(createDashboardTemplateNodes(locale, layout, spec.templateId, 0), locale,
      { ...packPageSample(pack, spec), filterKey }, pack.linkageFieldZh, pack.linkageFieldEn);
    const sourceId = `${filterKey}:page:${crypto.randomUUID()}`;
    for (const node of page.nodes) if (node.kind === "data-widget" && node.widget.sampleData) {
      node.widget.sampleData.sourceId = sourceId;
      node.widget.key = `${sourceId}:${node.id}`;
    }
    for (const [index, step] of pack.workflows.filter(step => step.from === spec.templateId).entries()) {
      const label = tr(locale, step.actionZh, step.actionEn);
      const node: DashboardDataWidgetNode = {
        id: `widget:${crypto.randomUUID()}`, kind: "data-widget", name: label, zIndex: page.nodes.length,
        frame: { x: 24 + index * 228, y: page.height - 56, width: Math.min(216, page.width - 48), height: 40 },
        widget: { type: "text", key: `${instanceId}:nav:${spec.templateId}:${index}`, unit: "",
          title: label, content: `${label} →`, textAlign: "center" },
      };
      page.nodes.push(node);
      interactions.push({ id: `flow:${crypto.randomUUID()}`, name: label, source: { kind: "widget", id: node.id }, trigger: "click", enabled: true,
        actions: [{ id: `action:${crypto.randomUUID()}`, type: "dashboard", enabled: true, dashboardPageId: pagesByTemplate.get(step.to)!.id }] });
    }
  }
  const entry = pagesByTemplate.get(pack.entryTemplateId)!;
  return { pages: [entry, ...[...pagesByTemplate.values()].filter(page => page !== entry)], interactions, entryPageId: entry.id };
}
