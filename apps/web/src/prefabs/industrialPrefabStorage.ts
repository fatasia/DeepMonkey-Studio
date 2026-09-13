import type { IndustrialPrefabDefinition, IndustrialPrefabParameterDefinition } from "@bim-studio/contracts";
import { actions, bool, definition, fixed, number, select } from "./industrialPrefabShared";

/**
 * 仓储族定义。
 * 2026-09-12 波次 C 扩量:贯通式货架(托盘货架变体,驶入式无横梁)、移动式密集架、
 * 冷藏柜(冷链储存)、周转笼(单元笼式容器)。
 */
const STORAGE_VARIANTS = [
  ["storage.pallet-rack", "托盘货架", "Pallet rack", "pallet-rack", 1200, 6],
  ["storage.carton-flow", "重力流利架", "Carton flow rack", "carton-flow", 40, 4],
  ["storage.asrs-shuttle", "穿梭车立体库", "Shuttle AS/RS", "shuttle-asrs", 500, 12],
  ["storage.vertical-lift-module", "垂直提升货柜", "Vertical lift module", "vertical-lift", 250, 8],
  ["storage.silo", "料仓", "Bulk material silo", "silo", 5000, 1],
  ["storage.asrs-rack", "立体库货柜", "AS/RS rack system", "asrs-rack", 1000, 14],
  ["storage.drive-in-rack", "贯通式货架", "Drive-in rack", "drive-in", 1200, 4],
  ["storage.mobile-shelving", "移动式密集架", "Mobile shelving", "mobile-shelving", 300, 6],
  ["storage.cold-room", "冷藏柜", "Cold storage cabinet", "cold-room", 400, 4],
  ["storage.roll-cage", "周转笼", "Roll cage", "roll-cage", 300, 1],
] as const;

/** 仓储族专属参数。 */
const STORAGE_EXTRAS: Record<string, IndustrialPrefabParameterDefinition[]> = {
  silo: [
    number("coneAngleDeg", "锥斗角度", "Cone angle", 60, "°", 30, 75, 1),
    select("discharge", "出料方式", "Discharge", "gravity", ["gravity", "air-cannon", "vibrating", "screw"]),
    bool("levelSensor", "料位计", "Level sensor", true),
  ],
  "asrs-rack": [
    number("aisleCount", "巷道数", "Aisle count", 2, "", 1, 8, 1),
    select("craneType", "堆垛机型式", "Crane type", "single-mast", ["single-mast", "dual-mast", "shuttle"]),
    bool("weighing", "载重检测", "Weighing", false),
  ],
  "drive-in": [
    number("palletsDeep", "货位深度", "Pallet positions deep", 4, "", 2, 8, 1),
    select("accessSide", "存取方式", "Access", "drive-in", ["drive-in", "drive-through"]),
    bool("guideRails", "托盘导轨", "Guide rails", true),
  ],
  "mobile-shelving": [
    number("bayCount", "移动列数", "Movable bays", 8, "", 2, 30, 1),
    select("driveMode", "驱动方式", "Drive mode", "manual-crank", ["manual-crank", "electric"]),
    bool("antiTilt", "防倾倒", "Anti-tilt", true),
  ],
  "cold-room": [
    number("setTempC", "设定温度", "Set point", -18, "°C", -35, 15, 1),
    select("doorType", "门型", "Door", "hinged", ["hinged", "sliding", "roll-up"]),
    select("defrost", "除霜方式", "Defrost", "hot-gas", ["hot-gas", "electric", "off-cycle"]),
    bool("tempLogging", "温度记录", "Temp logging", true),
  ],
  "roll-cage": [
    number("casters", "脚轮数", "Casters", 4, "", 3, 6, 1),
    select("meshPitch", "网眼间距", "Mesh pitch", "50mm", ["50mm", "75mm", "solid"]),
    bool("foldable", "可折叠", "Foldable", true),
  ],
};

/** 族默认高度(m):既有自动化立库高、周转类低。 */
const FAMILY_HEIGHT_M: Record<string, number> = {
  silo: 10, "drive-in": 6, "mobile-shelving": 2.2, "cold-room": 2.2, "roll-cage": 1.7,
};

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
  const automated = family === "shuttle-asrs" || family === "vertical-lift" || family === "asrs-rack";
  const isSilo = family === "silo"; // 料仓是单仓整体储存,无库位分层语义
  const isCage = family === "roll-cage"; // 周转笼是单体笼式容器,无库位分层语义
  const heightDefault = FAMILY_HEIGHT_M[family] ?? (automated ? 10 : 5);
  return definition(
    id,
    "storage",
    name,
    englishName,
    [
      fixed("family", "仓储类型", "Storage family", family),
      isSilo ? number("diameterM", "仓径", "Diameter", 4, "m", 1.5, 20, 0.1) : number("lengthM", "长度", "Length", 8, "m", 1, 100, 0.1),
      isSilo ? number("shellThicknessMm", "仓壁厚度", "Shell thickness", 4, "mm", 2, 20, 0.5) : number("depthM", "深度", "Depth", 1.2, "m", 0.3, 20, 0.1),
      number("heightM", "高度", "Height", heightDefault, "m", 0.5, 35, 0.1),
      number("levels", "层数", "Levels", levels, "", 1, 30, 1),
      number("slotCount", "库位数量", "Slot count", isSilo || isCage ? 1 : levels * 20, "", 1, 5000, 1),
      number("ratedLoadKg", "单库位载荷", "Rated load", ratedLoadKg, "kg", 1, 5000, 1),
      number("occupancyPercent", "初始占用率", "Initial occupancy", 70, "%", 0, 100, 1),
      select("putawayStrategy", "上架策略", "Putaway strategy", "nearest", ["nearest", "fifo", "fefo", "balanced"]),
      bool("barcodeRequired", "条码校验", "Barcode validation", true),
      bool("cycleCounting", "循环盘点", "Cycle counting", automated),
      ...(STORAGE_EXTRAS[family] ?? []),
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
