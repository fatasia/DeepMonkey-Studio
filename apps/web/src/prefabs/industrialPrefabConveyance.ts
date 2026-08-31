import type { IndustrialPrefabDefinition } from "@bim-studio/contracts";
import { actions, bool, definition, fixed, number, select, STATE_ACTIONS } from "./industrialPrefabShared";

const CONVEYOR_VARIANTS = [
  ["straight", "直线传送带", "Straight conveyor", "straight", "belt"],
  ["belt-wide", "宽幅皮带线", "Wide belt conveyor", "straight", "belt"],
  ["belt-incline", "爬坡皮带线", "Incline belt conveyor", "incline", "belt"],
  ["curve-90", "90°弯道传送带", "90° curve conveyor", "curve-90", "belt"],
  ["curve-180", "180°弯道传送带", "180° curve conveyor", "curve-180", "belt"],
  ["roller", "动力滚筒线", "Powered roller conveyor", "straight", "roller"],
  ["roller-gravity", "无动力滚筒线", "Gravity roller conveyor", "straight", "roller"],
  ["roller-accumulation", "积放滚筒线", "Accumulation roller conveyor", "accumulation", "roller"],
  ["chain-pallet", "链式托盘线", "Chain pallet conveyor", "straight", "chain"],
  ["transfer", "顶升移载机", "Lift transfer conveyor", "transfer", "roller"],
  ["merge", "合流输送机", "Merge conveyor", "merge", "belt"],
  ["diverter", "摆轮分流机", "Pop-up wheel diverter", "diverter", "roller"],
  ["sorter", "交叉带分拣机", "Cross-belt sorter", "sorter", "belt"],
  ["spiral", "螺旋升降输送机", "Spiral conveyor", "spiral", "belt"],
  ["vertical-lift", "垂直提升机", "Vertical lift conveyor", "vertical-lift", "chain"],
] as const;

export const CONVEYOR_PREFABS: IndustrialPrefabDefinition[] = CONVEYOR_VARIANTS.map(
  ([id, name, englishName, layout, surface]) => conveyorDefinition(id, name, englishName, layout, surface),
);

function conveyorDefinition(id: string, name: string, englishName: string, layout: string, surface: string): IndustrialPrefabDefinition {
  const specialActions = layout === "diverter"
    ? [["divert-left", "左侧分流", "Divert left"], ["divert-right", "右侧分流", "Divert right"]] as const
    : layout === "vertical-lift" || layout === "spiral"
      ? [["raise", "上升", "Raise"], ["lower", "下降", "Lower"]] as const
      : [["reverse", "反向", "Reverse"], ["clear-jam", "清除堵料", "Clear jam"]] as const;
  return definition(
    `conveyor.${id}`,
    "conveyor",
    name,
    englishName,
    [
      fixed("layout", "结构", "Layout", layout),
      fixed("surface", "输送面", "Surface", surface),
      number("lengthM", "长度", "Length", defaultLength(layout), "m", 0.5, 100, 0.1),
      number("widthM", "宽度", "Width", surface === "chain" ? 1.2 : 0.8, "m", 0.2, 5, 0.05),
      number("heightM", "离地高度", "Height", 0.75, "m", 0.1, 15, 0.05),
      number("speedMps", "运行速度", "Speed", 0.6, "m/s", 0, 5, 0.05),
      number("ratedLoadKg", "额定负载", "Rated load", surface === "chain" ? 1000 : 200, "kg", 1, 5000, 1),
      number("itemSpacingM", "物料间距", "Item spacing", 0.8, "m", 0.05, 20, 0.05),
      number("sensorCount", "传感器数量", "Sensor count", layout === "sorter" ? 6 : 2, "", 0, 32, 1),
      select("direction", "方向", "Direction", "forward", ["forward", "reverse"]),
      bool("accumulation", "积放控制", "Accumulation", layout === "accumulation"),
      bool("guards", "安全护栏", "Safety guards", true),
    ],
    [...STATE_ACTIONS, ...actions(specialActions)],
    ["speed", "running", "itemCount", "inSensor", "outSensor", "jammed", "energyKw", "faultCode"],
    { description: `${name}的速度、积放、传感器和堵料联锁配置` },
  );
}

function defaultLength(layout: string): number {
  if (layout === "spiral" || layout === "vertical-lift") return 6;
  if (layout === "sorter") return 12;
  return 4;
}
