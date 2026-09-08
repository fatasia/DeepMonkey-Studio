import type { IndustryTemplatePack } from "./industryTemplatePackTypes";

/** 电力能源以变电站贯穿供能、能耗、运行、告警与资产；不冒充已接入 SCADA 实时遥测。 */
export const POWER_GRID_OPERATIONS_PACK: IndustryTemplatePack = {
  id: "power-grid-operations", revision: 1,
  titleZh: "电力能源运行包", titleEn: "Power grid operations pack",
  categoryZh: "电力能源", categoryEn: "Power and energy",
  summaryZh: "能源总览→能耗与成本→供配电运行→告警处置→资产健康，追踪峰值告警与光伏波动如何影响供能服务。",
  summaryEn: "Energy overview → consumption and cost → distribution operation → alert resolution → asset health, tracing peak alerts and PV volatility to service risk.",
  pages: [
    { templateId: "energy", nameZh: "能源总览", nameEn: "Energy overview" },
    { templateId: "energy-energy", nameZh: "能耗与成本", nameEn: "Consumption and cost" },
    { templateId: "energy-operations", nameZh: "供配电运行", nameEn: "Distribution operation" },
    { templateId: "energy-risk", nameZh: "告警处置", nameEn: "Alert resolution" },
    { templateId: "energy-asset", nameZh: "资产健康", nameEn: "Asset health" },
  ],
  entryTemplateId: "energy", linkageParameterKey: "pack:power-grid-operations:substation",
  linkageFieldZh: "变电站", linkageFieldEn: "Substation",
  workflows: [
    { from: "energy", to: "energy-energy", actionZh: "核对能耗与成本", actionEn: "Review consumption and cost", linkageParameterKey: "pack:power-grid-operations:substation" },
    { from: "energy-energy", to: "energy-operations", actionZh: "检查供配电运行", actionEn: "Inspect distribution operation", linkageParameterKey: "pack:power-grid-operations:substation" },
    { from: "energy-operations", to: "energy-risk", actionZh: "处置峰值告警", actionEn: "Resolve peak alerts", linkageParameterKey: "pack:power-grid-operations:substation" },
    { from: "energy-risk", to: "energy-asset", actionZh: "复核资产健康", actionEn: "Review asset health", linkageParameterKey: "pack:power-grid-operations:substation" },
    { from: "energy-asset", to: "energy", actionZh: "返回能源总览", actionEn: "Return to energy overview", linkageParameterKey: "pack:power-grid-operations:substation" },
  ],
  guideZh: "选择变电站沿页面动作核对能耗、运行、告警和资产；在数据页签编辑整组示例，保存、刷新后发布验证。示例为同一班次快照：1#中心站平稳，2#工业园站 2#变压器重载并触发峰值告警待处置，3#光伏枢纽站出力波动导致消纳率下降。电量以 MWh 计、负载以 MW 计、能耗以 tce 计，三者不直接相减；负载率为比率取平均，不跨站加权求和。无自动调度或保护联动。",
  guideEn: "Filter a substation and follow consumption, operation, alert and asset actions; edit grouped samples in Data, then save, reload and publish. One-shift snapshot: Substation 1 is steady; Substation 2 has transformer T2 heavily loaded with an unresolved peak alert; Substation 3 has volatile PV output lowering its consumption rate. Energy uses MWh, load MW and consumption tce; never subtract unlike units. Ratios are averaged, not summed across stations. No automatic dispatch or protection interlocking.",
};
