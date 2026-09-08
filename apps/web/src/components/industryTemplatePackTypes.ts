import type { DashboardTemplateKind } from "./DashboardTemplateCatalog";

/**
 * 行业深度包合同（S3-C）：一个包是一个有业务故事的页面集合，不是模板换个名字。
 * 页面引用既有 120 模板 ID；页间联动复用看板共享筛选参数（filterField）。
 */
export interface IndustryPackWorkflowStep {
  /** 起始页面模板 ID。 */
  from: string;
  actionZh: string;
  actionEn: string;
  /** 目标页面模板 ID。 */
  to: string;
  /** 点击联动写入的共享参数键；目标页筛选器与示例数据按它过滤。 */
  linkageParameterKey: string;
}

export interface IndustryPackPage {
  templateId: DashboardTemplateKind;
  nameZh: string;
  nameEn: string;
}

export interface IndustryTemplatePack {
  id: string;
  revision: number;
  titleZh: string;
  titleEn: string;
  categoryZh: string;
  categoryEn: string;
  summaryZh: string;
  summaryEn: string;
  pages: readonly IndustryPackPage[];
  entryTemplateId: string;
  /** 全包共享的联动维度（如产线、变电站），值域由示例数据保证一致。 */
  linkageParameterKey: string;
  linkageFieldZh: string;
  linkageFieldEn: string;
  workflows: readonly IndustryPackWorkflowStep[];
  guideZh: string;
  guideEn: string;
}

/**
 * 校验包引用完整性：页面模板存在、入口在页集中、工作流起止页可达、
 * 联动参数在每一步都声明。导入前必须通过，坏包整体拒绝，不留半个应用。
 */
export function validateIndustryTemplatePack(
  pack: IndustryTemplatePack,
  knownTemplateIds: readonly string[],
): void {
  const fail = (reason: string): never => {
    throw new Error(`行业包 ${pack.id}: ${reason}`);
  };
  if (!pack.id.trim() || !pack.titleZh.trim() || !pack.titleEn.trim()) fail("缺少标识或标题");
  if (!Number.isInteger(pack.revision) || pack.revision < 1) fail("revision 必须是正整数");
  if (pack.pages.length < 2) fail("至少两个页面才构成业务流");
  const ids = new Set<string>();
  for (const page of pack.pages) {
    if (!knownTemplateIds.includes(page.templateId)) fail(`页面模板不存在: ${page.templateId}`);
    if (!page.nameZh.trim() || !page.nameEn.trim()) fail(`页面 ${page.templateId} 缺少名称`);
    if (ids.has(page.templateId)) fail(`页面模板重复: ${page.templateId}`);
    ids.add(page.templateId);
  }
  if (!ids.has(pack.entryTemplateId)) fail(`入口页不在页集中: ${pack.entryTemplateId}`);
  if (!pack.linkageParameterKey.trim()) fail("缺少联动参数键");
  if (!pack.workflows.length) fail("至少一条页间工作流");
  for (const step of pack.workflows) {
    if (!ids.has(step.from)) fail(`工作流起点不在页集中: ${step.from}`);
    if (!ids.has(step.to)) fail(`工作流终点不在页集中: ${step.to}`);
    if (step.from === step.to) fail(`工作流起点终点相同: ${step.from}`);
    if (step.linkageParameterKey !== pack.linkageParameterKey) fail("工作流必须使用包级联动参数");
    if (!step.actionZh.trim() || !step.actionEn.trim()) fail(`工作流 ${step.from}→${step.to} 缺少动作说明`);
  }
  // 每个页面都应被至少一条工作流引用，孤立页面不构成业务故事。
  const reachable = new Set([pack.entryTemplateId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of pack.workflows) {
      if (reachable.has(step.from) && !reachable.has(step.to)) {
        reachable.add(step.to);
        changed = true;
      }
    }
  }
  for (const page of pack.pages) {
    if (!reachable.has(page.templateId)) fail(`页面不在工作流可达集内: ${page.templateId}`);
  }
}
