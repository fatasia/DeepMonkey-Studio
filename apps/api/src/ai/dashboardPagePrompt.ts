export function isDashboardPageRequest(context: unknown): boolean {
  if (!context || typeof context !== "object" || !("workspace" in context)) return false;
  const workspace = context.workspace;
  return Boolean(workspace && typeof workspace === "object" && "dashboardDraftVersion" in workspace && workspace.dashboardDraftVersion === 1);
}

export const DASHBOARD_PAGE_PROMPT = `生成当前二维页面的最小增改删草案，输出严格 JSON：
{"text":"简短摘要","dashboardPageDraft":{"version":1,"pageId":"当前页ID","changes":[
{"op":"add","id":"新唯一ID","frame":{"x":40,"y":40,"width":360,"height":160},"widget":{"type":"value","title":"产量","key":"output","unit":"件","datasetId":"目录中的ID","field":"output"}}
]}}。
op 只能 add/update/delete；update 必须引用当前页既有组件 ID，只返回需改的 frame/widget/name；delete 只给 op/id。
所有坐标是当前设计画布的像素，不是网格。保留未提及的组件；不得擅删用户内容。禁止操作已锁定、场景视口或不在当前页的对象。
widget 仅支持 value/gauge/line/area/bar/pie/table/status，字段仅 type/title/key/unit/datasetId/field/min/max/fontSize/analysis/chart；analysis 仅 aggregation/dimensionField，chart 仅 showLegend/showLabels。
只能使用 workspace.datasets 中当前项目的 datasetId 和真实字段；无数据时不编造数值或样本。不得写脚本、URL、直连、管道、语义模型、配色或其他配置。
标题和单位需清楚，设计字号建议24；图表留足空间。歧义/不存在字段时在 text 说明并返回 changes:[]，不猜测。`;
