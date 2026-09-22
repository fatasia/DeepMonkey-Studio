import type { ModelKit, PrefabThumbnailVariant } from "./prefabThumbnailKit";
import { buildStraightRoad, straightRoadShape } from "../parametricRoadGeometry";

/** 道路缩略图与场景实例共用同一几何生成器，避免资源卡与插入结果不一致。 */
export function buildRoadModel(kit: ModelKit, _variant: PrefabThumbnailVariant) {
  const road = buildStraightRoad(straightRoadShape(), {
    surface: kit.dark,
    shoulder: kit.bodyDeep,
    marking: kit.lampWarn,
  });
  kit.group.add(road);
  return kit.group;
}
