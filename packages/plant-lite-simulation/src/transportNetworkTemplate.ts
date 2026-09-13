import type { PlantLiteModel } from "./modelTypes.js";

/** 三域使用同一物料标识与 DES 事件链，AGV 在轨道上空驶回取下一件。 */
export function createAgvNetworkPlantLiteModel(): PlantLiteModel {
  return {
    id: "agv-multidomain-v1", name: "AGV · 输送 · 机器人交接",
    resources: [
      { id: "fleet", name: "AGV 车队", kind: "agv", capacity: 3 },
      { id: "conveyor", name: "输送线", kind: "transport", capacity: 2 },
      { id: "robot", name: "机器人", kind: "equipment", capacity: 1 },
    ],
    nodes: [
      { id: "source", name: "来料", kind: "source", interarrivalTime: { kind: "deterministic", value: 0.2 }, maxItems: 30 },
      { id: "agv", name: "AGV 转运", kind: "transport", resourceId: "fleet", travelTime: { kind: "deterministic", value: 1 }, journey: { from: "pickup", to: "dropoff", speedMetersPerMinute: 60, loadMinutes: 0.1, unloadMinutes: 0.1 } },
      { id: "belt", name: "输送交接", kind: "transport", resourceId: "conveyor", travelTime: { kind: "deterministic", value: 0.25 } },
      { id: "station", name: "机器人装配", kind: "station", resourceId: "robot", processingTime: { kind: "deterministic", value: 0.5 } },
      { id: "sink", name: "成品", kind: "sink" },
    ],
    edges: [
      { id: "source-agv", from: "source", to: "agv" }, { id: "agv-belt", from: "agv", to: "belt" },
      { id: "belt-station", from: "belt", to: "station" }, { id: "station-sink", from: "station", to: "sink" },
    ],
    transportNetwork: {
      waypoints: [{ id: "pickup", name: "取料站", position: [0, 0, 0] }, { id: "crossing", name: "共享路口", position: [12, 0, 0] }, { id: "dropoff", name: "输送接驳站", position: [24, 0, 6] }],
      segments: [
        { id: "out-a", from: "pickup", to: "crossing", lengthMeters: 12, conflictZone: "aisle-a" },
        { id: "out-b", from: "crossing", to: "dropoff", lengthMeters: 14, conflictZone: "aisle-b" },
        { id: "back-b", from: "dropoff", to: "crossing", lengthMeters: 14, conflictZone: "aisle-b" },
        { id: "back-a", from: "crossing", to: "pickup", lengthMeters: 12, conflictZone: "aisle-a" },
      ], fleets: [{ resourceId: "fleet", homeWaypointId: "pickup" }],
    },
  };
}
