import { assertDashboardSampleData } from "@bim-studio/contracts";
import type { PackPageSampleSpec } from "./industryPackSampleApply";
import { validateIndustryTemplatePack, type IndustryTemplatePack } from "./industryTemplatePackTypes";

export interface IndustryPackEntry {
  pack: IndustryTemplatePack;
  samples: Readonly<Record<string, PackPageSampleSpec>>;
}

/** 坏包隔离在目录边界；不能在模块加载时拖垮整个二维工作区。 */
export function createIndustryPackRegistry(entries: readonly IndustryPackEntry[], knownIds: readonly string[]) {
  const valid = new Map<string, IndustryPackEntry>();
  const issues: string[] = [];
  const counts = new Map<string, number>();
  for (const { pack } of entries) counts.set(pack.id, (counts.get(pack.id) ?? 0) + 1);
  for (const entry of entries) {
    try {
      if (counts.get(entry.pack.id)! > 1) throw new Error(`行业包标识重复: ${entry.pack.id}`);
      validateIndustryTemplatePack(entry.pack, knownIds);
      for (const page of entry.pack.pages) validateSample(entry.pack, page.templateId, entry.samples[page.templateId]);
      valid.set(entry.pack.id, entry);
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error));
    }
  }
  return {
    packs: [...valid.values()].map(entry => entry.pack), issues,
    sample(pack: IndustryTemplatePack, templateId: string): PackPageSampleSpec {
      const entry = valid.get(pack.id);
      if (!entry || entry.pack.revision !== pack.revision || !entry.pack.pages.some(page => page.templateId === templateId)) {
        throw new Error(`行业包来源或版本不可用: ${pack.id}@${pack.revision}`);
      }
      return entry.samples[templateId]!;
    },
  };
}

function validateSample(pack: IndustryTemplatePack, templateId: string, spec: PackPageSampleSpec | undefined): void {
  const fail = (reason: string): never => { throw new Error(`行业包 ${pack.id}/${templateId}: ${reason}`); };
  if (!spec || spec.templateId !== templateId) fail("缺少对应页面示例");
  const sample = spec!;
  if (sample.filterKey !== pack.linkageParameterKey || sample.columns[0]?.key !== pack.linkageFieldZh) fail("筛选维度与包不一致");
  if (!sample.titleZh.trim() || !sample.titleEn.trim() || !sample.detailTitleZh.trim() || !sample.detailTitleEn.trim()) fail("缺少业务标题");
  if (sample.metrics.length !== 4 || new Set(sample.filterOptions).size !== sample.filterOptions.length || sample.filterOptions[0] !== "全部") fail("指标或筛选选项无效");
  const rows = sample.rowValues.map(values => {
    if (values.length !== sample.columns.length || !sample.filterOptions.slice(1).includes(String(values[0]))) fail("记录列数或联动维度值无效");
    return Object.fromEntries(sample.columns.map((column, index) => [column.key, values[index]]));
  });
  assertDashboardSampleData({ columns: sample.columns, rows }, `${pack.id}/${templateId}`);
  for (const metric of sample.metrics) {
    if (!sample.columns.some(column => column.key === metric.field && column.type === "number")) fail(`指标缺少数值字段: ${metric.field}`);
    if (!["sum", "average"].includes(metric.aggregation)) fail("指标聚合方式无效");
  }
  for (const chart of [sample.primary, sample.secondary]) {
    if (!sample.columns.some(column => column.key === chart.dimensionField)) fail(`图表维度缺失: ${chart.dimensionField}`);
    if (!sample.columns.some(column => column.key === (chart.measureField ?? chart.dimensionField) && column.type === "number")) fail("图表度量不是数值字段");
  }
}
