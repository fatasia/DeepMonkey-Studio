import type { PackPageSampleSpec, PackSampleChart, PackSampleColumn } from "./industryPackSampleApply";

const zone: PackSampleColumn = { key: "库区", type: "string" };
const text = (key: string): PackSampleColumn => ({ key, type: "string" });
const number = (key: string): PackSampleColumn => ({ key, type: "number" });
const metric = (field: string, titleEn: string, unit: string, unitEn: string): PackPageSampleSpec["metrics"][number] =>
  ({ field, aggregation: "sum", titleZh: field, titleEn, unit, unitEn });
const chart = (type: PackSampleChart["type"], field: string, dimension: string, titleZh: string, titleEn: string, unit: string, unitEn: string): PackSampleChart =>
  ({ type, measureField: field, dimensionField: dimension, titleZh, titleEn, unit, unitEn });
const common = { filterKey: "pack:warehouse-fulfillment:zone", filterOptions: ["全部", "A", "B", "C"] };

/** 独立业务快照；计数与下面逐单台账保持一致，不从制造包改名生成。 */
const overview: PackPageSampleSpec = {
  ...common, templateId: "logistics", titleZh: "仓储履约 · 履约总览", titleEn: "Warehouse fulfillment · Overview",
  metrics: [metric("入库托盘", "Received pallets", "托", "pallets"), metric("待拣订单", "Pending picking orders", "单", "orders"),
    metric("待发运单", "Pending shipments", "单", "shipments"), metric("未结异常", "Open exceptions", "项", "issues")],
  primary: chart("bar", "待拣订单", "库区", "各库区待拣订单", "Pending picking by zone", "单", "orders"),
  secondary: chart("bar", "待发运单", "库区", "各库区待发运单", "Pending shipments by zone", "单", "shipments"),
  detailTitleZh: "库区履约快照", detailTitleEn: "Zone fulfillment snapshot",
  columns: [zone, number("入库托盘"), number("可用库存"), number("待拣订单"), number("待发运单"), number("未结异常")],
  rowValues: [["A", 18, 1500, 0, 0, 0], ["B", 12, 450, 2, 1, 2], ["C", 10, 680, 1, 2, 1]],
};

const inventory: PackPageSampleSpec = {
  ...common, templateId: "logistics-asset", titleZh: "仓储履约 · 库存可用性", titleEn: "Warehouse fulfillment · Stock availability",
  metrics: [metric("可用库存", "Available stock", "件", "pcs"), metric("冻结库存", "Blocked stock", "件", "pcs"),
    metric("待检库存", "Stock awaiting inspection", "件", "pcs"), metric("补货缺口", "Replenishment gap", "件", "pcs")],
  primary: chart("bar", "可用库存", "货品", "各货品可用库存", "Available stock by SKU", "件", "pcs"),
  secondary: chart("bar", "补货缺口", "货品", "各货品补货缺口", "Replenishment gap by SKU", "件", "pcs"),
  detailTitleZh: "货位库存台账", detailTitleEn: "Bin inventory ledger",
  columns: [zone, text("货品"), text("货位"), number("可用库存"), number("冻结库存"), number("待检库存"), number("补货缺口")],
  rowValues: [["A", "连接器", "A-01", 900, 0, 0, 0], ["A", "传感器", "A-02", 600, 0, 0, 0],
    ["B", "紧固件", "B-01", 120, 0, 0, 80], ["B", "轴承", "B-02", 330, 20, 0, 0],
    ["C", "控制器", "C-01", 380, 0, 20, 0], ["C", "显示器", "C-02", 300, 10, 0, 0]],
};

const picking: PackPageSampleSpec = {
  ...common, templateId: "logistics-operations", titleZh: "仓储履约 · 波次拣选", titleEn: "Warehouse fulfillment · Wave picking",
  metrics: [metric("计划拣选", "Planned picks", "件", "pcs"), metric("已拣件数", "Picked quantity", "件", "pcs"),
    metric("待拣件数", "Remaining picks", "件", "pcs"), metric("超时订单", "Late picking orders", "单", "orders")],
  primary: chart("bar", "待拣件数", "订单", "逐单剩余拣选量", "Remaining picks by order", "件", "pcs"),
  secondary: chart("bar", "已拣件数", "波次", "波次已拣件数", "Picked quantity by wave", "件", "pcs"),
  detailTitleZh: "拣选订单台账", detailTitleEn: "Picking order ledger",
  columns: [zone, text("订单"), text("波次"), number("计划拣选"), number("已拣件数"), number("待拣件数"), number("待拣订单"), number("超时订单")],
  rowValues: [["A", "SO-A01", "WA-1", 120, 120, 0, 0, 0], ["A", "SO-A02", "WA-1", 80, 80, 0, 0, 0],
    ["B", "SO-B01", "WB-1", 200, 120, 80, 1, 1], ["B", "SO-B02", "WB-2", 150, 90, 60, 1, 0],
    ["C", "SO-C01", "WC-1", 160, 160, 0, 0, 0], ["C", "SO-C02", "WC-1", 100, 60, 40, 1, 0]],
};

const dispatch: PackPageSampleSpec = {
  ...common, templateId: "logistics-quality", titleZh: "仓储履约 · 装车发运", titleEn: "Warehouse fulfillment · Loading and dispatch",
  metrics: [metric("计划箱数", "Planned boxes", "箱", "boxes"), metric("已装箱数", "Loaded boxes", "箱", "boxes"),
    metric("未装箱数", "Remaining boxes", "箱", "boxes"), metric("超期运单", "Overdue shipments", "单", "shipments")],
  primary: chart("bar", "未装箱数", "运单", "逐单未装箱数", "Remaining boxes by shipment", "箱", "boxes"),
  secondary: chart("bar", "已装箱数", "月台", "月台装车箱数", "Loaded boxes by dock", "箱", "boxes"),
  detailTitleZh: "发运装车台账", detailTitleEn: "Shipment loading ledger",
  columns: [zone, text("运单"), text("月台"), text("状态"), number("计划箱数"), number("已装箱数"), number("未装箱数"), number("待发运单"), number("超期运单")],
  rowValues: [["A", "DN-A01", "D1", "已发运", 12, 12, 0, 0, 0], ["A", "DN-A02", "D1", "已发运", 8, 8, 0, 0, 0],
    ["B", "DN-B01", "D2", "等待补货", 20, 12, 8, 1, 1], ["B", "DN-B00", "D2", "已发运", 9, 9, 0, 0, 0],
    ["C", "DN-C01", "D3", "破损复检", 16, 14, 2, 1, 0], ["C", "DN-C02", "D3", "等待拣选", 10, 6, 4, 1, 0]],
};

const exceptions: PackPageSampleSpec = {
  ...common, templateId: "logistics-risk", titleZh: "仓储履约 · 异常闭环", titleEn: "Warehouse fulfillment · Exception resolution",
  metrics: [metric("未结异常", "Open exceptions", "项", "issues"), metric("高优先级", "High priority exceptions", "项", "issues"),
    metric("已结异常", "Resolved exceptions", "项", "issues"), metric("投入工时", "Handling effort", "h", "h")],
  primary: chart("bar", "未结异常", "类型", "未结异常类型", "Open issues by type", "项", "issues"),
  secondary: chart("bar", "投入工时", "关联单号", "关联单据处置工时", "Handling effort by reference", "h", "h"),
  detailTitleZh: "履约异常处置记录", detailTitleEn: "Fulfillment exception ledger",
  columns: [zone, text("异常号"), text("关联单号"), text("类型"), text("下一步"), number("未结异常"), number("高优先级"), number("已结异常"), number("投入工时")],
  rowValues: [["A", "EX-A01", "SO-A01", "扫码异常", "已核对放行", 0, 0, 1, 0.25],
    ["B", "EX-B01", "SO-B01", "库存不足", "补货80件", 1, 1, 0, 1.5],
    ["B", "EX-B02", "SO-B01", "波次超时", "补货后重排波次", 1, 0, 0, 0.5],
    ["C", "EX-C01", "DN-C01", "包装破损", "复检剩余2箱", 1, 1, 0, 0.75]],
};

export const LOGISTICS_PACK_SAMPLES: Readonly<Record<string, PackPageSampleSpec>> = {
  logistics: overview, "logistics-asset": inventory, "logistics-operations": picking,
  "logistics-quality": dispatch, "logistics-risk": exceptions,
};
