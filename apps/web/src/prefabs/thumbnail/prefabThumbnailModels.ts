import * as THREE from "three";
import type { IndustrialPrefabDefinition, IndustrialPrefabKind } from "@bim-studio/contracts";
import { industrialPrefabPrimitiveVisual } from "../industrialPrefabInstance";
import { createModelKit, disposeThumbnailModel, prefabThumbnailVariant, thumbnailStyleFor } from "./prefabThumbnailKit";
import type { ModelKit, PrefabThumbnailVariant } from "./prefabThumbnailKit";
import {
  buildCabinetModel,
  buildCompressorModel,
  buildDisplayModel,
  buildFanModel,
  buildMachineModel,
  buildPumpModel,
  buildValveModel,
} from "./prefabThumbnailModelsProcess";
import { buildDosingStationModel, buildHeatExchangerModel, buildSoftenerModel, buildTankModel } from "./prefabThumbnailModelsProcess2";
import {
  buildAccessControlModel,
  buildAgvModel,
  buildCameraModel,
  buildConveyorModel,
  buildFenceModel,
  buildPersonModel,
  buildRobotArmModel,
  buildSensorModel,
  buildStorageModel,
  buildVehicleModel,
} from "./prefabThumbnailModelsLogistics";

/**
 * 工业预制体缩略图小样总入口:按 kind 分发到各构建器。
 * 主色沿用 industrialPrefabPrimitiveVisual(kind).color 的场景代理色彩语义,
 * family/process/layout 等分型键由 prefabThumbnailVariant 抽取。
 */
export function buildIndustrialPrefabThumbnailModel(definition: IndustrialPrefabDefinition): THREE.Group | undefined {
  const kind = definition.kind;
  const builder = BUILDERS[kind];
  if (!builder) return undefined;
  const style = thumbnailStyleFor(kind, definition.id);
  const kit = createModelKit(industrialPrefabPrimitiveVisual(kind).color, style);
  // rimTint:kind 代理色原值,渲染器据此微调轮廓光(见 prefabThumbnailRenderer)
  kit.group.userData.prefabStyle = { ...style, rimTint: Number.parseInt(industrialPrefabPrimitiveVisual(kind).color.slice(1), 16) };
  try {
    return builder(kit, prefabThumbnailVariant(definition));
  } catch (error) {
    // 单个 kind 构建失败不应拖垮缩略图链路:释放半成品并回落图标。
    disposeThumbnailModel(kit.group);
    console.warn(`[prefab-thumbnail] ${definition.id} 模型构建失败`, error);
    return undefined;
  }
}

type ModelBuilder = (kit: ModelKit, variant: PrefabThumbnailVariant) => THREE.Group;

const BUILDERS: Record<IndustrialPrefabKind, ModelBuilder> = {
  machine: buildMachineModel,
  utility: buildUtilityModel,
  electrical: buildCabinetModel,
  conveyor: buildConveyorModel,
  "robot-arm": buildRobotArmModel,
  person: buildPersonModel,
  agv: buildAgvModel,
  vehicle: buildVehicleModel,
  "access-control": buildAccessControlModel,
  display: buildDisplayModel,
  fence: buildFenceModel,
  sensor: buildSensorModel,
  camera: buildCameraModel,
  storage: buildStorageModel,
};

/** utility 按设备族分流:泵/阀/风机/空压机/换热器/储罐/软水/加药;柜体族归电气构建器。 */
function buildUtilityModel(kit: ModelKit, variant: PrefabThumbnailVariant): THREE.Group {
  switch (variant.family) {
    case "valve": return buildValveModel(kit, variant);
    case "fan": return buildFanModel(kit, variant);
    case "compressor": return buildCompressorModel(kit);
    case "heat-exchanger": return buildHeatExchangerModel(kit);
    case "tank": return buildTankModel(kit);
    case "softener": return buildSoftenerModel(kit);
    case "dosing-station": return buildDosingStationModel(kit);
    default: return buildPumpModel(kit, variant);
  }
}

export { disposeThumbnailModel };
