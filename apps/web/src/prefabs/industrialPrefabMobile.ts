import type { IndustrialPrefabDefinition } from "@bim-studio/contracts";
import { bool, definition, fixed, number, ROUTE_ACTIONS, select, text } from "./industrialPrefabShared";

const MOBILE_VARIANTS = [
  ["person.worker", "person", "作业人员", "Worker", "worker", 1.35, 0],
  ["person.guard", "person", "巡检人员", "Inspector", "inspector", 1.25, 0],
  ["person.visitor", "person", "访客", "Visitor", "visitor", 1.15, 0],
  ["person.maintenance", "person", "维修技师", "Maintenance technician", "maintenance", 1.2, 0],
  ["person.operator", "person", "产线操作员", "Line operator", "operator", 1.3, 0],
  ["agv.carrier", "agv", "背负式 AGV", "Carrier AGV", "carrier", 1.5, 1000],
  ["agv.tugger", "agv", "牵引式 AGV", "Tugger AGV", "tugger", 1.8, 1500],
  ["agv.forklift", "agv", "叉车式 AGV", "Forklift AGV", "forklift", 1.2, 1200],
  ["agv.unit-load", "agv", "单元载荷 AGV", "Unit-load AGV", "unit-load", 1.4, 600],
  ["agv.amr", "agv", "自主移动机器人", "Autonomous mobile robot", "amr", 2, 500],
  ["agv.amr-shelf", "agv", "潜伏顶升 AMR", "Shelf-lifting AMR", "shelf-amr", 1.5, 800],
  ["vehicle.car", "vehicle", "园区车辆", "Campus vehicle", "car", 8, 400],
  ["vehicle.truck", "vehicle", "物流货车", "Logistics truck", "truck", 6, 8000],
  ["vehicle.forklift", "vehicle", "人工叉车", "Manned forklift", "forklift", 3, 1800],
  ["vehicle.tow-tractor", "vehicle", "牵引车", "Tow tractor", "tow-tractor", 4, 2500],
  ["vehicle.reach-truck", "vehicle", "前移式叉车", "Reach truck", "reach-truck", 2.5, 1400],
] as const;

export const MOBILE_PREFABS: IndustrialPrefabDefinition[] = MOBILE_VARIANTS.map(
  ([id, kind, name, englishName, subtype, speedMps, loadKg]) =>
    routeDefinition(id, kind, name, englishName, subtype, speedMps, loadKg),
);

function routeDefinition(id: string, kind: "person" | "agv" | "vehicle", name: string, englishName: string, subtype: string, speedMps: number, loadKg: number): IndustrialPrefabDefinition {
  const parameters = [
    fixed("subtype", "类型", "Subtype", subtype),
    number("speedMps", "巡航速度", "Cruise speed", speedMps, "m/s", 0.1, 20, 0.05),
    number("accelerationMps2", "加速度", "Acceleration", kind === "person" ? 0.8 : 0.6, "m/s²", 0.1, 5, 0.05),
    number("stopDistanceM", "安全停车距离", "Stopping distance", kind === "person" ? 0.4 : 0.8, "m", 0.1, 10, 0.1),
    number("avoidanceRadiusM", "避让半径", "Avoidance radius", kind === "person" ? 0.5 : 1, "m", 0.1, 10, 0.1),
    select("routeMode", "路线模式", "Route mode", "loop", ["once", "loop", "ping-pong"]),
    bool("orientToPath", "跟随路线转向", "Orient to path", true),
    bool("obstacleAvoidance", "障碍避让", "Obstacle avoidance", true),
  ];
  if (kind === "person") {
    parameters.push(select("animation", "动作", "Animation", subtype === "maintenance" ? "inspect" : "walk", ["idle", "walk", "run", "inspect"]));
  } else {
    parameters.push(
      number("ratedLoadKg", "额定载荷", "Rated load", loadKg, "kg", 0, 20000, 10),
      number("batterySoc", "初始电量", "Initial battery", 100, "%", 0, 100, 1),
      number("lowBatteryThreshold", "低电量阈值", "Low battery threshold", 20, "%", 1, 80, 1),
      text("chargeStationId", "充电站", "Charge station", ""),
    );
  }
  const ports = kind === "person"
    ? ["position", "speed", "animation", "status", "routeProgress"]
    : ["position", "speed", "batterySoc", "loadKg", "stationId", "routeProgress", "status", "faultCode"];
  return definition(id, kind, name, englishName, parameters, ROUTE_ACTIONS, ports, { routeCapable: true, description: `${name}的路线、避让、载荷与状态数据配置` });
}
