import type { IndustryTemplatePack } from "./industryTemplatePackTypes";

/** 仓储履约以库区贯穿库存、拣选、发运和异常；不冒充已连接 WMS。 */
export const LOGISTICS_FULFILLMENT_PACK: IndustryTemplatePack = {
  id: "warehouse-fulfillment", revision: 1,
  titleZh: "仓储履约运行包", titleEn: "Warehouse fulfillment pack",
  categoryZh: "仓储物流", categoryEn: "Warehouse logistics",
  summaryZh: "库区履约→可用库存→波次拣选→装车发运→异常闭环，追踪缺货与破损如何影响交付。",
  summaryEn: "Fulfillment → available stock → wave picking → dispatch → exception resolution, tracing shortages and damage to delivery risk.",
  pages: [
    { templateId: "logistics", nameZh: "履约总览", nameEn: "Fulfillment overview" },
    { templateId: "logistics-asset", nameZh: "库存可用性", nameEn: "Stock availability" },
    { templateId: "logistics-operations", nameZh: "波次拣选", nameEn: "Wave picking" },
    { templateId: "logistics-quality", nameZh: "装车发运", nameEn: "Loading and dispatch" },
    { templateId: "logistics-risk", nameZh: "异常闭环", nameEn: "Exception resolution" },
  ],
  entryTemplateId: "logistics", linkageParameterKey: "pack:warehouse-fulfillment:zone",
  linkageFieldZh: "库区", linkageFieldEn: "Zone",
  workflows: [
    { from: "logistics", to: "logistics-asset", actionZh: "核对可用库存", actionEn: "Check available stock", linkageParameterKey: "pack:warehouse-fulfillment:zone" },
    { from: "logistics-asset", to: "logistics-operations", actionZh: "跟踪拣选波次", actionEn: "Track picking waves", linkageParameterKey: "pack:warehouse-fulfillment:zone" },
    { from: "logistics-operations", to: "logistics-quality", actionZh: "查看装车进度", actionEn: "Inspect loading progress", linkageParameterKey: "pack:warehouse-fulfillment:zone" },
    { from: "logistics-quality", to: "logistics-risk", actionZh: "处理履约异常", actionEn: "Resolve fulfillment issues", linkageParameterKey: "pack:warehouse-fulfillment:zone" },
    { from: "logistics-risk", to: "logistics", actionZh: "返回履约总览", actionEn: "Return to fulfillment", linkageParameterKey: "pack:warehouse-fulfillment:zone" },
  ],
  guideZh: "选择库区沿页面动作核对库存、拣选、发运和异常；在数据页签编辑整组示例，保存、刷新后发布验证。示例为同一班次快照：A区履约完成，B区缺货与拣选超时，C区装车破损待复检。库存单位为件，入库为托盘、装车为箱，三者不直接相减。待拣/待发按未完成记录计数；补货缺口为计划量，未结异常不等于超期运单。无自动调度或设备控制。",
  guideEn: "Filter a zone, follow stock, picking, loading and exception actions, edit grouped samples in Data, then save, reload and publish. One-shift snapshot: A completed; B has a stock shortage and late picking; C has damaged goods awaiting inspection. Stock uses pieces, receiving pallets and loading boxes; do not subtract unlike units. Pending counts represent unfinished records; replenishment gaps are planned quantities, not overdue shipments. No automatic dispatch or device control.",
};
