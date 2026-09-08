import { DASHBOARD_TEMPLATES } from "./DashboardTemplateCatalog";
import type { DashboardTemplateKind } from "./DashboardTemplateCatalog";
import { MANUFACTURING_ASSET_OPS_PACK } from "./industryPackManufacturing";
import { MANUFACTURING_PACK_SAMPLES } from "./industryPackManufacturing";
import type { IndustryTemplatePack, IndustryPackPage } from "./industryTemplatePackTypes";
import type { PackPageSampleSpec } from "./industryPackSampleApply";
import { validateIndustryTemplatePack } from "./industryTemplatePackTypes";

/** 目录在模块加载时校验：坏包直接抛错，不允许带病进目录。 */
const KNOWN_TEMPLATE_IDS: readonly string[] = DASHBOARD_TEMPLATES.map((template) => template.id);
for (const pack of [MANUFACTURING_ASSET_OPS_PACK]) {
  validateIndustryTemplatePack(pack, KNOWN_TEMPLATE_IDS);
  for (const page of pack.pages) {
    if (!MANUFACTURING_PACK_SAMPLES[page.templateId]) {
      throw new Error(`行业包 ${pack.id}: 页面缺少示例数据规格: ${page.templateId}`);
    }
  }
}

export const INDUSTRY_TEMPLATE_PACKS: readonly IndustryTemplatePack[] = [MANUFACTURING_ASSET_OPS_PACK];

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
  const spec = MANUFACTURING_PACK_SAMPLES[page.templateId];
  if (!spec) throw new Error(`行业包 ${pack.id}: 示例缺失 ${page.templateId}`);
  return spec;
}

export type { DashboardTemplateKind };
