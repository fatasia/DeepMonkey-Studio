/**
 * 物流、移动、感知与周界小样的稳定导出入口。
 * 实现按模型族拆分，调用方无需感知内部文件布局。
 */
export { buildConveyorModel } from "./prefabThumbnailModelsLogisticsConveyors";
export { buildRobotArmModel } from "./prefabThumbnailModelsLogisticsRobotics";
export { buildAgvModel, buildVehicleModel, buildPersonModel } from "./prefabThumbnailModelsLogisticsMobile";
export {
  buildAccessControlModel,
  buildFenceModel,
  buildStorageModel,
  buildSensorModel,
  buildCameraModel,
} from "./prefabThumbnailModelsLogisticsFacilities";
