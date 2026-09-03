import type { PprBopVersion, PprOperation } from "@bim-studio/contracts";
import type { PprLineBalance, PprStationBalance } from "./types.js";

/**
 * 用 BOP 标准工时与工位分配计算确定性线平衡；设备、工具和人员负载仍由 resourceLoads 表达，
 * 避免同一道工序因多类资源同时参与而被重复计入工位节拍。
 */
export function calculateLineBalance(
  version: PprBopVersion,
  operations: Map<string, PprOperation>,
): PprLineBalance {
  const targetTaktMinutes = validTakt(version.targetTaktMinutes) ? version.targetTaktMinutes : null;
  const stations = version.resources.filter((resource) => resource.kind === "station");
  const stationIds = new Set(stations.map((resource) => resource.id));
  const stationAssignments = version.resourceAssignments.filter((assignment) => stationIds.has(assignment.resourceId));
  const assignedOperationIds = new Set(stationAssignments.map((assignment) => assignment.operationId));
  const totalWorkContentMinutes = version.operations.reduce((sum, operation) => sum + operation.standardTimeMinutes, 0);
  const configuredStationUnits = stations.reduce((sum, station) => sum + (station.capacity ?? 1), 0);
  const stationLoads = stations.map((station) => stationBalance(
    station.id,
    station.capacity ?? 1,
    stationAssignments,
    operations,
    targetTaktMinutes,
  ));
  return {
    targetTaktMinutes,
    totalWorkContentMinutes,
    configuredStationUnits,
    theoreticalMinimumStationUnits: targetTaktMinutes
      ? Math.ceil(totalWorkContentMinutes / targetTaktMinutes)
      : null,
    balanceEfficiency: targetTaktMinutes && configuredStationUnits
      ? totalWorkContentMinutes / (targetTaktMinutes * configuredStationUnits)
      : null,
    stationLoads,
    unassignedOperationIds: version.operations
      .filter((operation) => !assignedOperationIds.has(operation.id))
      .map((operation) => operation.id),
    overloadedResourceIds: stationLoads
      .filter((station) => station.status === "overloaded")
      .map((station) => station.resourceId),
  };
}

function stationBalance(
  resourceId: string,
  stationUnits: number,
  assignments: PprBopVersion["resourceAssignments"],
  operations: Map<string, PprOperation>,
  targetTaktMinutes: number | null,
): PprStationBalance {
  const matching = assignments.filter((assignment) => assignment.resourceId === resourceId);
  const operationIds = [...new Set(matching.map((assignment) => assignment.operationId))];
  const assignedMinutes = matching.reduce((sum, assignment) => {
    const operation = operations.get(assignment.operationId);
    return sum + (operation?.standardTimeMinutes ?? 0) * (assignment.requiredCapacity ?? 1);
  }, 0);
  const loadPerUnitMinutes = stationUnits > 0 ? assignedMinutes / stationUnits : assignedMinutes;
  const taktUtilization = targetTaktMinutes ? loadPerUnitMinutes / targetTaktMinutes : null;
  return {
    resourceId,
    operationIds,
    assignedMinutes,
    stationUnits,
    loadPerUnitMinutes,
    taktUtilization,
    status: balanceStatus(taktUtilization),
  };
}

function balanceStatus(utilization: number | null): PprStationBalance["status"] {
  if (utilization === null) return "not-configured";
  if (utilization > 1) return "overloaded";
  return utilization < 0.7 ? "underloaded" : "balanced";
}

function validTakt(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
