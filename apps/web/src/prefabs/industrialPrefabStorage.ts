import type { IndustrialPrefabDefinition } from "@bim-studio/contracts";
import { actions, bool, definition, fixed, number, select } from "./industrialPrefabShared";

const STORAGE_VARIANTS = [
  ["storage.pallet-rack", "托盘货架", "Pallet rack", "pallet-rack", 1200, 6],
  ["storage.carton-flow", "重力流利架", "Carton flow rack", "carton-flow", 40, 4],
  ["storage.asrs-shuttle", "穿梭车立体库", "Shuttle AS/RS", "shuttle-asrs", 500, 12],
  ["storage.vertical-lift-module", "垂直提升货柜", "Vertical lift module", "vertical-lift", 250, 8],
] as const;

export const STORAGE_PREFABS: IndustrialPrefabDefinition[] = STORAGE_VARIANTS.map(
  ([id, name, englishName, family, ratedLoadKg, levels]) =>
    storageDefinition(id, name, englishName, family, ratedLoadKg, levels),
);

function storageDefinition(
  id: string,
  name: string,
  englishName: string,
  family: string,
  ratedLoadKg: number,
  levels: number,
): IndustrialPrefabDefinition {
  const automated = family === "shuttle-asrs" || family === "vertical-lift";
  return definition(
    id,
    "storage",
    name,
    englishName,
    [
      fixed("family", "仓储类型", "Storage family", family),
      number("lengthM", "长度", "Length", 8, "m", 1, 100, 0.1),
      number("depthM", "深度", "Depth", 1.2, "m", 0.3, 20, 0.1),
      number("heightM", "高度", "Height", automated ? 10 : 5, "m", 0.5, 35, 0.1),
      number("levels", "层数", "Levels", levels, "", 1, 30, 1),
      number("slotCount", "库位数量", "Slot count", levels * 20, "", 1, 5000, 1),
      number("ratedLoadKg", "单库位载荷", "Rated load", ratedLoadKg, "kg", 1, 5000, 1),
      number("occupancyPercent", "初始占用率", "Initial occupancy", 70, "%", 0, 100, 1),
      select("putawayStrategy", "上架策略", "Putaway strategy", "nearest", ["nearest", "fifo", "fefo", "balanced"]),
      bool("barcodeRequired", "条码校验", "Barcode validation", true),
      bool("cycleCounting", "循环盘点", "Cycle counting", automated),
    ],
    actions([
      ["putaway", "上架", "Put away"],
      ["pick", "拣选", "Pick"],
      ["count", "盘点", "Cycle count"],
      ["lock-slot", "锁定库位", "Lock slot"],
      ["clear-fault", "清除故障", "Clear fault"],
    ]),
    ["occupancy", "availableSlots", "reservedSlots", "pickRate", "putawayRate", "inventoryAccuracy", "status", "faultCode"],
    { description: `${name}的库位、负载、占用策略和出入库运行参数` },
  );
}
