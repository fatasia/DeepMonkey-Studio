import type {
  PprOperation,
  PprOperationResourceAssignment,
  PprPrecedenceRelation,
  PprResource,
} from "@bim-studio/contracts";
import type {
  PprCriticalPath,
  PprResourceConflict,
  PprResourceLoad,
  PprScheduledOperation,
} from "./types.js";

export interface PprOperationGraph {
  predecessors: Map<string, PprPrecedenceRelation[]>;
  successors: Map<string, string[]>;
  inDegree: Map<string, number>;
}

export function createOperationGraph(operations: PprOperation[], relations: PprPrecedenceRelation[]): PprOperationGraph {
  const predecessors = new Map<string, PprPrecedenceRelation[]>();
  const successors = new Map<string, string[]>();
  const inDegree = new Map(operations.map((operation) => [operation.id, 0]));

  relations.forEach((relation) => {
    const prior = predecessors.get(relation.successorOperationId) ?? [];
    predecessors.set(relation.successorOperationId, [...prior, relation]);
    const following = successors.get(relation.predecessorOperationId) ?? [];
    successors.set(relation.predecessorOperationId, [...following, relation.successorOperationId]);
    inDegree.set(relation.successorOperationId, (inDegree.get(relation.successorOperationId) ?? 0) + 1);
  });

  return { predecessors, successors, inDegree };
}

export function buildTopologicalOrder(operationIds: string[], graph: PprOperationGraph): string[] {
  const inDegree = new Map(graph.inDegree);
  const ready = operationIds.filter((operationId) => inDegree.get(operationId) === 0);
  const ordered: string[] = [];

  while (ready.length) {
    const operationId = ready.shift();
    if (!operationId) break;
    ordered.push(operationId);
    (graph.successors.get(operationId) ?? []).forEach((successorId) => {
      const nextInDegree = (inDegree.get(successorId) ?? 0) - 1;
      inDegree.set(successorId, nextInDegree);
      if (nextInDegree === 0) ready.push(successorId);
    });
  }

  return ordered;
}

export function scheduleOperations(order: string[], operations: Map<string, PprOperation>, predecessors: Map<string, PprPrecedenceRelation[]>): PprScheduledOperation[] {
  const scheduled = new Map<string, PprScheduledOperation>();

  order.forEach((operationId) => {
    const timing = predecessorTiming(predecessors.get(operationId) ?? [], scheduled);
    const operation = operations.get(operationId);
    if (!operation) return;
    const item: PprScheduledOperation = {
      operationId,
      startMinutes: timing.startMinutes,
      endMinutes: timing.startMinutes + operation.standardTimeMinutes,
      ...(timing.criticalPredecessorId ? { criticalPredecessorId: timing.criticalPredecessorId } : {}),
    };
    scheduled.set(operationId, item);
  });

  return order.flatMap((operationId) => {
    const item = scheduled.get(operationId);
    return item ? [item] : [];
  });
}

export function buildCriticalPath(schedule: PprScheduledOperation[]): PprCriticalPath {
  const latest = schedule.reduce<PprScheduledOperation | undefined>((current, item) => {
    return !current || item.endMinutes > current.endMinutes ? item : current;
  }, undefined);
  if (!latest) return { operationIds: [], durationMinutes: 0 };

  const byId = new Map(schedule.map((item) => [item.operationId, item]));
  const operationIds: string[] = [];
  let current: PprScheduledOperation | undefined = latest;
  while (current) {
    operationIds.unshift(current.operationId);
    current = current.criticalPredecessorId ? byId.get(current.criticalPredecessorId) : undefined;
  }
  return { operationIds, durationMinutes: latest.endMinutes };
}

export function calculateResourceLoads(resources: PprResource[], assignments: PprOperationResourceAssignment[], schedule: PprScheduledOperation[], operations: Map<string, PprOperation>, makespan: number): PprResourceLoad[] {
  const scheduledIds = new Set(schedule.map((item) => item.operationId));
  return resources.map((resource) => {
    const assignedMinutes = assignments
      .filter((assignment) => assignment.resourceId === resource.id && scheduledIds.has(assignment.operationId))
      .reduce((total, assignment) => {
        const operation = operations.get(assignment.operationId);
        return total + (operation?.standardTimeMinutes ?? 0) * (assignment.requiredCapacity ?? 1);
      }, 0);
    const availableMinutes = makespan * (resource.capacity ?? 1);
    return {
      resourceId: resource.id,
      assignedMinutes,
      availableMinutes,
      utilization: availableMinutes ? assignedMinutes / availableMinutes : 0,
    };
  });
}

export function findResourceConflicts(resources: PprResource[], assignments: PprOperationResourceAssignment[], schedule: PprScheduledOperation[]): PprResourceConflict[] {
  const schedules = new Map(schedule.map((item) => [item.operationId, item]));
  return resources.flatMap((resource) => findConflictsForResource(resource, assignments, schedules));
}

function predecessorTiming(relations: PprPrecedenceRelation[], scheduled: Map<string, PprScheduledOperation>) {
  let startMinutes = 0;
  let criticalPredecessorId: string | undefined;
  relations.forEach((relation) => {
    const predecessor = scheduled.get(relation.predecessorOperationId);
    if (!predecessor) return;
    const candidate = predecessor.endMinutes + (relation.minimumLagMinutes ?? 0);
    if (candidate > startMinutes) {
      startMinutes = candidate;
      criticalPredecessorId = predecessor.operationId;
    }
  });
  return { startMinutes, criticalPredecessorId };
}

function findConflictsForResource(resource: PprResource, assignments: PprOperationResourceAssignment[], schedules: Map<string, PprScheduledOperation>): PprResourceConflict[] {
  const reservations = assignments
    .filter((assignment) => assignment.resourceId === resource.id)
    .flatMap((assignment) => reservationFor(assignment, schedules));
  const points = [...new Set(reservations.flatMap((reservation) => [reservation.start, reservation.end]))].sort((left, right) => left - right);
  const conflicts: PprResourceConflict[] = [];

  for (let index = 0; index < points.length - 1; index += 1) {
    const startMinutes = points[index];
    const endMinutes = points[index + 1];
    if (startMinutes === undefined || endMinutes === undefined) continue;
    const active = reservations.filter((reservation) => reservation.start < endMinutes && reservation.end > startMinutes);
    const requiredCapacity = active.reduce((total, reservation) => total + reservation.required, 0);
    const availableCapacity = resource.capacity ?? 1;
    if (requiredCapacity > availableCapacity) {
      conflicts.push({
        resourceId: resource.id,
        startMinutes,
        endMinutes,
        operationIds: active.map((reservation) => reservation.operationId),
        requiredCapacity,
        availableCapacity,
      });
    }
  }
  return conflicts;
}

function reservationFor(assignment: PprOperationResourceAssignment, schedules: Map<string, PprScheduledOperation>) {
  const operation = schedules.get(assignment.operationId);
  if (!operation) return [];
  return [{
    operationId: assignment.operationId,
    start: operation.startMinutes,
    end: operation.endMinutes,
    required: assignment.requiredCapacity ?? 1,
  }];
}
