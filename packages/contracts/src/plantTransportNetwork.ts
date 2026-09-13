/** 轨道长度/坐标为米，速度为米/分钟；物料流图与物理轨道图分别建模。 */
export interface PlantTransportNetwork {
  waypoints: Array<{ id: string; name: string; position: [number, number, number] }>;
  segments: Array<{
    id: string; from: string; to: string; lengthMeters: number;
    /** 共用 conflictZone 的路段不能同时通行；省略时同端点的正反方向互斥。 */
    conflictZone?: string;
    /** 有限封闭窗口，用于验证堵塞后的调度恢复。 */
    blockedUntilMinute?: number;
  }>;
  fleets: Array<{ resourceId: string; homeWaypointId: string }>;
}

export interface PlantTransportJourney {
  from: string; to: string; speedMetersPerMinute: number;
  loadMinutes: number; unloadMinutes: number;
}

export interface PlantTransportReservation {
  vehicleId: string;
  waitMinutes: number;
  startMinute: number;
  finishMinute: number;
  legs: Array<{
    segmentId: string; from: string; to: string; loaded: boolean;
    startMinute: number; endMinute: number;
  }>;
}
