import type { PlantLiteModel, PlantLiteProductType } from "@bim-studio/contracts";

export interface PlantLiteProductMixInput {
  id?: string;
  name: string;
  percentage: number;
}

export function applyPlantLiteProductMix(
  model: PlantLiteModel,
  input: PlantLiteProductMixInput[],
): PlantLiteModel {
  if (input.length < 2 || input.length > 12) throw new Error("请配置 2 到 12 个产品类型");
  const names = new Set<string>();
  let total = 0;
  for (const [index, row] of input.entries()) {
    const name = row.name.trim();
    if (!name || name.length > 120) throw new Error(`第 ${index + 1} 个产品名称必须是 1 到 120 个字符`);
    const nameKey = name.toLowerCase();
    if (names.has(nameKey)) throw new Error(`产品名称“${name}”重复`);
    names.add(nameKey);
    if (!Number.isFinite(row.percentage) || row.percentage <= 0 || row.percentage > 100) {
      throw new Error(`${name} 的投放比例必须大于 0 且不超过 100%`);
    }
    total += row.percentage;
  }
  if (Math.abs(total - 100) > 1e-6) throw new Error(`投放比例合计必须为 100%，当前为 ${formatPercentage(total)}%`);

  const usedIds = new Set<string>();
  const productTypes: PlantLiteProductType[] = input.map((row) => {
    const existingId = row.id?.trim();
    const id = existingId && !usedIds.has(existingId) ? existingId : nextProductTypeId(usedIds);
    if (id.length > 120) throw new Error("产品类型 ID 不能超过 120 个字符");
    usedIds.add(id);
    return { id, name: row.name.trim(), share: row.percentage / 100 };
  });
  const next = structuredClone(model);
  next.productTypes = productTypes;
  if (next.productionOrders) {
    next.productionOrders = next.productionOrders.map((order) =>
      order.productTypeId && !usedIds.has(order.productTypeId)
        ? withoutProductType(order)
        : order);
  }
  next.nodes = next.nodes.map((node) => {
    if (node.kind !== "station" || !node.changeovers) return node;
    const changeovers = node.changeovers.filter((rule) =>
      usedIds.has(rule.fromProductTypeId) && usedIds.has(rule.toProductTypeId));
    return changeovers.length ? { ...node, changeovers } : withoutChangeovers(node);
  });
  return next;
}

export function disablePlantLiteProductMix(model: PlantLiteModel): PlantLiteModel {
  const next = structuredClone(model);
  delete next.productTypes;
  if (next.productionOrders) next.productionOrders = next.productionOrders.map(withoutProductType);
  next.nodes = next.nodes.map((node) => node.kind === "station" ? withoutChangeovers(node) : node);
  return next;
}

export function setPlantLiteChangeoverMinutes(
  model: PlantLiteModel,
  stationId: string,
  fromProductTypeId: string,
  toProductTypeId: string,
  minutes: number | undefined,
): PlantLiteModel {
  if (fromProductTypeId === toProductTypeId) throw new Error("同一产品类型不需要换型");
  const typeIds = new Set(model.productTypes?.map((item) => item.id) ?? []);
  if (!typeIds.has(fromProductTypeId) || !typeIds.has(toProductTypeId)) throw new Error("换型规则引用了未知产品类型");
  const next = structuredClone(model);
  const station = next.nodes.find((node) => node.id === stationId);
  if (!station || station.kind !== "station") throw new Error("找不到换型工位");
  if ((station.capacity ?? 1) !== 1) throw new Error("序列相关换型当前仅支持并行数为 1 的工位");
  const remaining = (station.changeovers ?? []).filter((rule) =>
    rule.fromProductTypeId !== fromProductTypeId || rule.toProductTypeId !== toProductTypeId);
  if (minutes === undefined || minutes === 0) {
    if (remaining.length) station.changeovers = remaining;
    else delete station.changeovers;
    return next;
  }
  if (!Number.isFinite(minutes) || minutes < 0 || minutes > 52_560) {
    throw new Error("换型分钟必须是 0 到 52560 的有限数");
  }
  station.changeovers = [...remaining, { fromProductTypeId, toProductTypeId, minutes }];
  return next;
}

function withoutChangeovers<T extends Extract<PlantLiteModel["nodes"][number], { kind: "station" }>>(station: T): T {
  const { changeovers: _changeovers, ...rest } = station;
  return rest as T;
}

function withoutProductType<T extends NonNullable<PlantLiteModel["productionOrders"]>[number]>(order: T): T {
  const { productTypeId: _productTypeId, ...rest } = order;
  return rest as T;
}

function nextProductTypeId(used: Set<string>): string {
  for (let suffix = 1; suffix <= 12; suffix += 1) {
    const id = `product-${suffix}`;
    if (!used.has(id)) return id;
  }
  throw new Error("无法生成唯一产品类型 ID");
}

function formatPercentage(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}
