import type { IndustrialPrefabDefinition } from "@bim-studio/contracts";
import { CAMERA_PREFABS } from "./industrialPrefabCamera";
import { CONVEYOR_PREFABS } from "./industrialPrefabConveyance";
import { ENVIRONMENT_PREFABS } from "./industrialPrefabEnvironment";
import { MACHINE_PREFABS } from "./industrialPrefabMachines";
import { MOBILE_PREFABS } from "./industrialPrefabMobile";
import { ROBOT_PREFABS } from "./industrialPrefabRobots";
import { SENSING_PREFABS } from "./industrialPrefabSensing";
import { STORAGE_PREFABS } from "./industrialPrefabStorage";
import { UTILITY_PREFABS } from "./industrialPrefabUtilities";

/**
 * 工业能力族在独立文件维护；这里保持单一稳定出口，供场景配置器读取。
 */
export const INDUSTRIAL_PREFAB_CATALOG: readonly IndustrialPrefabDefinition[] = [
  ...ROBOT_PREFABS,
  ...CONVEYOR_PREFABS,
  ...ENVIRONMENT_PREFABS,
  ...MOBILE_PREFABS,
  ...MACHINE_PREFABS,
  ...UTILITY_PREFABS,
  ...SENSING_PREFABS,
  ...CAMERA_PREFABS,
  ...STORAGE_PREFABS,
];

export function industrialPrefabDefinition(id: string): IndustrialPrefabDefinition | undefined {
  return INDUSTRIAL_PREFAB_CATALOG.find((definition) => definition.id === id);
}
