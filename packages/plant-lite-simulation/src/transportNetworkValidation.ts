import type { PlantTransportNetwork } from "@bim-studio/contracts";
import type { PlantLiteModelIssue } from "./modelTypes.js";
import { transportShortestPath } from "./transportNetwork.js";

export function validateTransportNetwork(input: Record<string, unknown>, issues: PlantLiteModelIssue[]): void {
  const nodes = (input.nodes as Array<Record<string, unknown>>).filter(record);
  const journeys = nodes.filter(node => node.journey !== undefined);
  if (input.transportNetwork === undefined) {
    if (journeys.length) issues.push({ path: "$.transportNetwork", message: "行程需要配置物理轨道网络" });
    return;
  }
  const before = issues.length;
  const network = input.transportNetwork;
  const fail = (message: string) => issues.push({ path: "$.transportNetwork", message });
  if (!record(network) || !Array.isArray(network.waypoints) || !Array.isArray(network.segments) || !Array.isArray(network.fleets)) { fail("必须包含 waypoints、segments 与 fleets 数组"); return; }
  if (network.waypoints.length < 2 || network.waypoints.length > 200 || network.segments.length < 1 || network.segments.length > 800 || network.fleets.length < 1 || network.fleets.length > 100) { fail("轨道需 2–200 点、1–800 段及 1–100 车队"); return; }
  const waypointIds = new Set<string>();
  for (const waypoint of network.waypoints) {
    if (!record(waypoint) || !text(waypoint.id) || waypointIds.has(waypoint.id) || !text(waypoint.name)
      || !Array.isArray(waypoint.position) || waypoint.position.length !== 3 || !waypoint.position.every(value => typeof value === "number" && Number.isFinite(value))) { fail("轨道点 ID/名称必须唯一有效，坐标须为三维有限数"); continue; }
    waypointIds.add(waypoint.id);
  }
  const segmentIds = new Set<string>();
  for (const segment of network.segments) {
    if (!record(segment) || !text(segment.id) || segmentIds.has(segment.id) || !text(segment.from) || !text(segment.to)
      || segment.from === segment.to || !waypointIds.has(segment.from) || !waypointIds.has(segment.to) || !positive(segment.lengthMeters)
      || (segment.conflictZone !== undefined && !text(segment.conflictZone)) || (segment.blockedUntilMinute !== undefined && !nonnegative(segment.blockedUntilMinute))) { fail("路段 ID、连接、长度、冲突区或封闭时间无效"); continue; }
    segmentIds.add(segment.id);
  }
  const resources = Array.isArray(input.resources) ? input.resources.filter(record) : [];
  const fleetIds = new Set<string>();
  const homes = new Map<string, string>();
  for (const fleet of network.fleets) {
    if (!record(fleet) || !text(fleet.resourceId) || fleetIds.has(fleet.resourceId) || !text(fleet.homeWaypointId) || !waypointIds.has(fleet.homeWaypointId)
      || !resources.some(resource => resource.id === fleet.resourceId && resource.kind === "agv")) { fail("车队须绑定唯一 AGV 资源与有效停车点"); continue; }
    fleetIds.add(fleet.resourceId); homes.set(fleet.resourceId, fleet.homeWaypointId);
  }
  for (const node of journeys) {
    const journey = node.journey;
    if (node.kind !== "transport" || !record(journey) || !text(node.resourceId) || !fleetIds.has(node.resourceId)
      || !text(journey.from) || !text(journey.to) || journey.from === journey.to || !waypointIds.has(journey.from) || !waypointIds.has(journey.to)
      || !positive(journey.speedMetersPerMinute) || !nonnegative(journey.loadMinutes) || !nonnegative(journey.unloadMinutes)) fail(`节点 ${node.id} 的车队、起终点、速度或装卸时间无效`);
  }
  // 同车队混用旧随机搬运与网络搬运会失去车辆身份，必须显式迁移所有该车队节点。
  for (const node of nodes) if (node.kind === "transport" && typeof node.resourceId === "string" && fleetIds.has(node.resourceId) && !node.journey) fail(`节点 ${node.id} 使用轨道车队，必须配置行程`);
  if (issues.length !== before) return;
  const typed = network as unknown as PlantTransportNetwork;
  for (const node of journeys) {
    const journey = node.journey as { from: string; to: string };
    const originCandidates = [homes.get(String(node.resourceId))!, ...journeys.filter(other => other.resourceId === node.resourceId).map(other => (other.journey as { to: string }).to)];
    try {
      transportShortestPath(typed, journey.from, journey.to);
      for (const origin of new Set(originCandidates)) transportShortestPath(typed, origin, journey.from);
    } catch (reason) { fail(reason instanceof Error ? reason.message : String(reason)); }
  }
}

function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= 120; }
function positive(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value > 0; }
function nonnegative(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
