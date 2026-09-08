import type { IndustryTemplatePack } from "./industryTemplatePackTypes";

/** 水处理以水厂贯穿供水、水质、运行、风险与资产；不冒充已接入 SCADA 实时遥测。 */
export const WATER_TREATMENT_PACK: IndustryTemplatePack = {
  id: "water-treatment", revision: 1,
  titleZh: "水处理运行包", titleEn: "Water treatment pack",
  categoryZh: "水务公用", categoryEn: "Water utilities",
  summaryZh: "供水总览→运行调度→水质管理→管网风险→设备资产，追踪浊度异常与泵站故障如何影响供水服务。",
  summaryEn: "Supply overview → dispatch → water quality → network risk → asset health, tracing turbidity anomalies and pump failures to service risk.",
  pages: [
    { templateId: "water", nameZh: "供水总览", nameEn: "Supply overview" },
    { templateId: "water-operations", nameZh: "运行调度", nameEn: "Dispatch operation" },
    { templateId: "water-quality", nameZh: "水质管理", nameEn: "Water quality" },
    { templateId: "water-risk", nameZh: "管网风险", nameEn: "Network risk" },
    { templateId: "water-asset", nameZh: "设备资产", nameEn: "Asset health" },
  ],
  entryTemplateId: "water", linkageParameterKey: "pack:water-treatment:plant",
  linkageFieldZh: "水厂", linkageFieldEn: "Plant",
  workflows: [
    { from: "water", to: "water-operations", actionZh: "查看运行调度", actionEn: "Inspect dispatch", linkageParameterKey: "pack:water-treatment:plant" },
    { from: "water-operations", to: "water-quality", actionZh: "核对水质指标", actionEn: "Check water quality", linkageParameterKey: "pack:water-treatment:plant" },
    { from: "water-quality", to: "water-risk", actionZh: "处置管网风险", actionEn: "Resolve network risks", linkageParameterKey: "pack:water-treatment:plant" },
    { from: "water-risk", to: "water-asset", actionZh: "复核设备资产", actionEn: "Review asset health", linkageParameterKey: "pack:water-treatment:plant" },
    { from: "water-asset", to: "water", actionZh: "返回供水总览", actionEn: "Return to supply overview", linkageParameterKey: "pack:water-treatment:plant" },
  ],
  guideZh: "选择水厂沿页面动作核对运行、水质、风险与资产；在数据页签编辑整组示例，保存、刷新后发布验证。示例为同一班次快照：1#水厂平稳，2#水厂出厂浊度接近限值并触发待处置风险，3#水厂加压泵站故障导致供水服务率下降。水量以 m³ 计、流量以 m³/h 计、能耗以 kWh 计，三者不直接相减；达标率与负载率为比率取平均，不跨厂加权求和。无自动加药或泵组控制。",
  guideEn: "Filter a plant and follow dispatch, quality, risk and asset actions; edit grouped samples in Data, then save, reload and publish. One-shift snapshot: Plant 1 is steady; Plant 2 has outlet turbidity near its limit with an unresolved risk; Plant 3 has a booster pump failure lowering service level. Volume uses m³, flow m³/h and energy kWh; never subtract unlike units. Rates are averaged, not summed across plants. No automatic dosing or pump control.",
};
