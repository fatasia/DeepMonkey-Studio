/**
 * 模板中心行业分组:32 个行业域归并为 9 个语义大类(对标外部参考模板市场 9 大行业类的组织方式)。
 * 映射是唯一的展示事实来源,搜索与下拉都以这里的组 id 为准;组顺序即下拉顺序。
 */
export interface DashboardTemplateGroup {
  id: string;
  zh: string;
  en: string;
  domainIds: readonly string[];
}

export const DASHBOARD_TEMPLATE_GROUPS: readonly DashboardTemplateGroup[] = [
  {
    id: "manufacturing", zh: "生产制造", en: "Manufacturing",
    domainIds: ["production", "maintenance", "petrochemical", "automotive", "semiconductor", "pharma"],
  },
  { id: "energy", zh: "能源环保", en: "Energy & environment", domainIds: ["energy", "carbon", "power-grid", "environment", "power-trading"] },
  { id: "logistics", zh: "物流仓储", en: "Logistics & warehouse", domainIds: ["logistics", "warehouse", "cold-chain"] },
  { id: "business", zh: "经营管理", en: "Business operations", domainIds: ["operations", "finance", "retail"] },
  { id: "safety-quality", zh: "安全质量", en: "Safety & quality", domainIds: ["safety", "quality", "chem-safety"] },
  { id: "facility", zh: "园区建筑", en: "Campus & construction", domainIds: ["campus", "construction", "realestate"] },
  { id: "water", zh: "水处理", en: "Water treatment", domainIds: ["water"] },
  { id: "public-service", zh: "公共服务", en: "Public services", domainIds: ["healthcare", "government", "transport", "education"] },
  { id: "emerging", zh: "新兴领域", en: "Emerging fields", domainIds: ["telecom", "tourism", "agriculture", "expo"] },
];

const GROUP_BY_DOMAIN = new Map<string, DashboardTemplateGroup>(
  DASHBOARD_TEMPLATE_GROUPS.flatMap((group) => group.domainIds.map((domainId) => [domainId, group])),
);

export function resolveTemplateGroup(domainId: string): DashboardTemplateGroup | undefined {
  return GROUP_BY_DOMAIN.get(domainId);
}
