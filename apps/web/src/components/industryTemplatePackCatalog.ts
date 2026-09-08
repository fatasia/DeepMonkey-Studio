import { DASHBOARD_TEMPLATES } from "./DashboardTemplateCatalog";
import type { DashboardTemplateKind } from "./DashboardTemplateCatalog";
import { MANUFACTURING_ASSET_OPS_PACK } from "./industryPackManufacturing";
import { MANUFACTURING_PACK_SAMPLES } from "./industryPackManufacturing";
import type { IndustryTemplatePack, IndustryPackPage } from "./industryTemplatePackTypes";
import type { PackPageSampleSpec } from "./industryPackSampleApply";
import { createIndustryPackRegistry } from "./industryPackRegistry";
import { LOGISTICS_FULFILLMENT_PACK } from "./industryPackLogistics";
import { LOGISTICS_PACK_SAMPLES } from "./industryPackLogisticsSamples";
import { POWER_GRID_OPERATIONS_PACK } from "./industryPackPowerGrid";
import { POWER_GRID_PACK_SAMPLES } from "./industryPackPowerGridSamples";

/** 每包独立校验并隔离错误，不影响其余模板和编辑器启动。 */
const KNOWN_TEMPLATE_IDS: readonly string[] = DASHBOARD_TEMPLATES.map((template) => template.id);
const registry = createIndustryPackRegistry([
  { pack: MANUFACTURING_ASSET_OPS_PACK, samples: MANUFACTURING_PACK_SAMPLES },
  { pack: LOGISTICS_FULFILLMENT_PACK, samples: LOGISTICS_PACK_SAMPLES },
  { pack: POWER_GRID_OPERATIONS_PACK, samples: POWER_GRID_PACK_SAMPLES },
], KNOWN_TEMPLATE_IDS);
export const INDUSTRY_TEMPLATE_PACKS: readonly IndustryTemplatePack[] = registry.packs;
export const INDUSTRY_PACK_ISSUES: readonly string[] = registry.issues;

export function findIndustryTemplatePack(packId: string): IndustryTemplatePack | undefined {
  return INDUSTRY_TEMPLATE_PACKS.find((pack) => pack.id === packId);
}

/** 页面模板 ID → 完整模板定义；目录校验已保证存在。 */
export function packPageTemplate(pack: IndustryTemplatePack, page: IndustryPackPage) {
  const template = DASHBOARD_TEMPLATES.find((candidate) => candidate.id === page.templateId);
  if (!template) throw new Error(`行业包 ${pack.id}: 模板缺失 ${page.templateId}`);
  return template;
}

export function packPageSample(pack: IndustryTemplatePack, page: IndustryPackPage): PackPageSampleSpec {
  return registry.sample(pack, page.templateId);
}

export type { DashboardTemplateKind };
