import type { Vector3Value } from "./geometry.js";

/** 规划筛查参数的来源；只表达数据来历，不代表厂商认证。 */
export type RobotPlanningEvidenceSource = "configured-prefab" | "author-confirmed" | "imported";

/** 机器人侧的额定负载规划包络。 */
export interface RobotLoadCapabilityState {
  ratedPayloadKg?: number;
  /** 规划采用的保守组合重心距离上限，不替代厂商负载曲线。 */
  maximumLoadCenterDistanceMeters?: number;
  source?: RobotPlanningEvidenceSource;
  reference?: string;
}

/** 法兰侧的工具、工件、TCP 与组合重心输入。 */
export interface RobotToolLoadState {
  /** TCP 在法兰局部坐标中的位置，单位米。 */
  tcpPositionMeters?: Vector3Value;
  /** TCP 在法兰局部坐标中的欧拉角，单位度。 */
  tcpOrientationEulerDeg?: Vector3Value;
  toolMassKg?: number;
  carriedPayloadKg?: number;
  /** 工具与工件组合重心相对法兰的位置，单位米。 */
  combinedCenterOfMassMeters?: Vector3Value;
  source?: RobotPlanningEvidenceSource;
  reference?: string;
}
