import type { IndustrialPrefabDefinition } from "@bim-studio/contracts";
import { actions, definition, fixed, number, select } from "./industrialPrefabShared";

/** V11 首条正式道路资源；复用工业预制体的插入、属性编辑与持久化链。 */
export const ENVIRONMENT_PREFABS: IndustrialPrefabDefinition[] = [
  definition(
    "road.straight",
    "road",
    "参数化直路",
    "Parametric straight road",
    [
      number("lengthM", "道路长度", "Road length", 20, "m", 2, 500, 0.5),
      number("carriagewayWidthM", "车行道宽度", "Carriageway width", 7, "m", 2.5, 30, 0.1),
      number("laneCount", "车道数", "Lane count", 2, "", 1, 12, 1),
      number("shoulderWidthM", "路肩宽度", "Shoulder width", 0.75, "m", 0, 5, 0.1),
      select("surface", "路面材质", "Surface", "asphalt", ["asphalt", "concrete"]),
      select("marking", "道路标线", "Road marking", "center", ["none", "center", "lanes"]),
      // I3 道路碰撞体：厚度为高级项，未设置时物理链使用缺省厚度且快照不新增字段。
      fixed("colliderThicknessM", "碰撞体厚度", "Collider thickness", 0.16),
    ],
    actions([["reset", "恢复默认参数", "Reset parameters"]]),
    ["lengthM", "carriagewayWidthM", "laneCount", "surface"],
    { pathCapable: true, description: "可在场景属性中编辑端点、样条、长度、宽度、车道、路肩、路面与标线的连续道路" },
  ),
];
