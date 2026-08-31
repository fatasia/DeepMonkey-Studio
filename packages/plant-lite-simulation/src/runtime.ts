import type { Availability, PlantLiteNode, PlantLiteReplication, PlantLiteModel, SimulationLimits } from "./model.js";
import { sample, Random } from "./random.js";
import type { Item, NodeState, ResourceState, Runtime, SimulationEvent } from "./runtimeTypes.js";

export function runReplication(
  model: PlantLiteModel,
  replication: number,
  seed: number,
  limits: Required<SimulationLimits>,
  shouldCancel: (() => boolean) | undefined,
  toMetrics: (runtime: Runtime, termination: PlantLiteReplication["termination"], reason?: PlantLiteReplication["reason"]) => PlantLiteReplication,
): PlantLiteReplication {
  const runtime = createRuntime(model, seed, limits);
  let termination: PlantLiteReplication["termination"] = "completed";
  let reason: PlantLiteReplication["reason"];
  while (true) {
    if (shouldCancel?.()) {
      termination = "cancelled";
      reason = "cancelled";
      break;
    }
    if (runtime.eventsProcessed >= limits.maxEvents) {
      termination = "limit-reached";
      reason = "max-events";
      break;
    }
    const event = runtime.events[0];
    if (!event || event.at > limits.durationMinutes) break;
    runtime.events.shift();
    advance(runtime, event.at);
    runtime.eventsProcessed += 1;
    handleEvent(runtime, event);
    drainAndStart(runtime);
  }
  if (runtime.now < limits.durationMinutes && termination === "completed") {
    advance(runtime, limits.durationMinutes);
  }
  return toMetrics(runtime, termination, reason);
}

function createRuntime(model: PlantLiteModel, seed: number, limits: Required<SimulationLimits>): Runtime {
  const runtime: Runtime = {
    model,
    random: new Random(seed),
    limits,
    states: new Map(),
    resources: new Map(),
    outgoing: new Map(),
    events: [],
    now: 0,
    sequence: 0,
    eventsProcessed: 0,
    created: 0,
    completed: 0,
    leadTotal: 0,
    wipArea: 0,
  };
  for (const node of model.nodes) runtime.states.set(node.id, emptyNodeState());
  for (const resource of model.resources ?? []) runtime.resources.set(resource.id, emptyResourceState());
  initializeOutgoing(runtime);
  initializeEvents(runtime);
  return runtime;
}

function initializeOutgoing(runtime: Runtime): void {
  const edges = [...runtime.model.edges].sort((left, right) => (left.priority ?? 0) - (right.priority ?? 0) || left.id.localeCompare(right.id));
  for (const edge of edges) {
    const targets = runtime.outgoing.get(edge.from) ?? [];
    targets.push(edge.to);
    runtime.outgoing.set(edge.from, targets);
  }
}

function initializeEvents(runtime: Runtime): void {
  for (const node of runtime.model.nodes) {
    if (node.kind === "source") schedule(runtime, node.initialDelay ?? 0, "arrival", node.id);
    if (node.kind === "station") scheduleAvailability(runtime, node.id, node.availability);
  }
  for (const resource of runtime.model.resources ?? []) {
    scheduleAvailability(runtime, resource.id, resource.availability);
    if (resource.failure) schedule(runtime, sample(resource.failure.timeToFailure, runtime.random), "failure", resource.id);
  }
}

function handleEvent(runtime: Runtime, event: SimulationEvent): void {
  if (event.type === "arrival") return handleArrival(runtime, event);
  if (event.type === "complete") return handleCompletion(runtime, event);
  if (event.type === "failure") return handleFailure(runtime, event.id);
  if (event.type === "repair") return handleRepair(runtime, event.id);
  // 班次边界只触发重新派工，不抢占正在执行的作业。
}

function handleArrival(runtime: Runtime, event: SimulationEvent): void {
  const node = findNode(runtime, event.id);
  if (node.kind !== "source") throw new Error("arrival targeted a non-source node");
  const state = nodeState(runtime, node.id);
  runtime.created += 1;
  state.generated += 1;
  state.output.push({ id: `${node.id}:${state.generated}`, createdAt: runtime.now });
  if (node.maxItems === undefined || state.generated < node.maxItems) {
    schedule(runtime, runtime.now + sample(node.interarrivalTime, runtime.random), "arrival", node.id);
  }
}

function handleCompletion(runtime: Runtime, event: SimulationEvent): void {
  const node = findNode(runtime, event.id);
  if (!event.item || (node.kind !== "station" && node.kind !== "transport")) {
    throw new Error("completion event is malformed");
  }
  const state = nodeState(runtime, node.id);
  state.active -= 1;
  state.output.push(event.item);
  releaseResource(runtime, node);
}

function handleFailure(runtime: Runtime, resourceId: string): void {
  const resource = resourceState(runtime, resourceId);
  resource.failed = true;
  const profile = resourceDefinition(runtime, resourceId).failure;
  if (profile) schedule(runtime, runtime.now + sample(profile.repairTime, runtime.random), "repair", resourceId);
}

function handleRepair(runtime: Runtime, resourceId: string): void {
  const resource = resourceState(runtime, resourceId);
  resource.failed = false;
  const profile = resourceDefinition(runtime, resourceId).failure;
  if (profile) schedule(runtime, runtime.now + sample(profile.timeToFailure, runtime.random), "failure", resourceId);
}

function drainAndStart(runtime: Runtime): void {
  let changed = true;
  while (changed) {
    changed = drainNetwork(runtime);
    startReadyNodes(runtime);
  }
  startReadyNodes(runtime);
}

function drainNetwork(runtime: Runtime): boolean {
  let changed = false;
  for (const node of runtime.model.nodes) {
    const items = isBuffer(node) ? nodeState(runtime, node.id).input : nodeState(runtime, node.id).output;
    const item = items[0];
    if (!item) continue;
    for (const targetId of runtime.outgoing.get(node.id) ?? []) {
      if (!accept(runtime, targetId, item)) continue;
      items.shift();
      changed = true;
      break;
    }
  }
  return changed;
}

function accept(runtime: Runtime, targetId: string, item: Item): boolean {
  const target = findNode(runtime, targetId);
  if (target.kind === "source") return false;
  if (target.kind === "sink") {
    runtime.completed += 1;
    runtime.leadTotal += runtime.now - item.createdAt;
    return true;
  }
  const state = nodeState(runtime, targetId);
  const capacity = isBuffer(target) ? target.capacity : target.queueCapacity ?? 100;
  if (state.input.length >= capacity) return false;
  state.input.push(item);
  return true;
}

function startReadyNodes(runtime: Runtime): void {
  for (const node of runtime.model.nodes) {
    if (node.kind !== "station" && node.kind !== "transport") continue;
    const state = nodeState(runtime, node.id);
    const capacity = node.kind === "station" ? node.capacity ?? 1 : Number.POSITIVE_INFINITY;
    while (state.input.length > 0 && state.active < capacity && canAcquire(runtime, node)) {
      const item = state.input.shift()!;
      state.active += 1;
      acquireResource(runtime, node);
      const distribution = node.kind === "station" ? node.processingTime : node.travelTime;
      schedule(runtime, runtime.now + sample(distribution, runtime.random), "complete", node.id, item);
    }
  }
}

function advance(runtime: Runtime, target: number): void {
  const elapsed = target - runtime.now;
  if (elapsed < 0) throw new Error("event queue is not ordered");
  if (elapsed === 0) return;
  runtime.wipArea += (runtime.created - runtime.completed) * elapsed;
  for (const node of runtime.model.nodes) advanceNode(runtime, node, elapsed);
  for (const resource of runtime.model.resources ?? []) advanceResource(runtime, resource.id, resource.availability, resource.capacity, elapsed);
  runtime.now = target;
}

function advanceNode(runtime: Runtime, node: PlantLiteNode, elapsed: number): void {
  const state = nodeState(runtime, node.id);
  state.queueArea += state.input.length * elapsed;
  state.busyArea += state.active * elapsed;
  if ((node.kind === "station" || node.kind === "transport") && isOperational(runtime, node)) {
    state.availableArea += nodeCapacity(runtime, node) * elapsed;
  }
  if (state.output.length > 0) state.blocked += elapsed;
  if ((node.kind === "station" || node.kind === "transport") && state.input.length === 0 && canAcquire(runtime, node)) {
    state.starved += elapsed;
  }
}

function advanceResource(runtime: Runtime, resourceId: string, availability: Availability | undefined, capacity: number, elapsed: number): void {
  const state = resourceState(runtime, resourceId);
  state.busyArea += state.busy * elapsed;
  if (!state.failed && inShift(runtime.now, availability)) state.availableArea += capacity * elapsed;
  if (state.failed) state.failedArea += elapsed;
}

function canAcquire(runtime: Runtime, node: Extract<PlantLiteNode, { kind: "station" | "transport" }>): boolean {
  if (!isOperational(runtime, node)) return false;
  if (!node.resourceId) return true;
  const resource = resourceState(runtime, node.resourceId);
  return resource.busy < resourceDefinition(runtime, node.resourceId).capacity;
}

function isOperational(runtime: Runtime, node: Extract<PlantLiteNode, { kind: "station" | "transport" }>): boolean {
  if (node.kind === "station" && !inShift(runtime.now, node.availability)) return false;
  if (!node.resourceId) return true;
  const resource = resourceState(runtime, node.resourceId);
  return !resource.failed && inShift(runtime.now, resourceDefinition(runtime, node.resourceId).availability);
}

function acquireResource(runtime: Runtime, node: Extract<PlantLiteNode, { kind: "station" | "transport" }>): void {
  if (node.resourceId) resourceState(runtime, node.resourceId).busy += 1;
}

function releaseResource(runtime: Runtime, node: Extract<PlantLiteNode, { kind: "station" | "transport" }>): void {
  if (node.resourceId) resourceState(runtime, node.resourceId).busy -= 1;
}

function scheduleAvailability(runtime: Runtime, id: string, availability: Availability | undefined): void {
  if (!availability?.shifts?.length) return;
  for (let day = 0; day * 1_440 <= runtime.limits.durationMinutes; day += 1) {
    for (const shift of availability.shifts) {
      for (const minute of [shift.startMinute, shift.endMinute]) {
        const at = day * 1_440 + minute;
        if (at <= runtime.limits.durationMinutes) schedule(runtime, at, "availability", id);
      }
    }
  }
}

function schedule(runtime: Runtime, at: number, type: SimulationEvent["type"], id: string, item?: Item): void {
  runtime.events.push({ at, sequence: runtime.sequence++, type, id, ...(item ? { item } : {}) });
  runtime.events.sort((left, right) => left.at - right.at || left.sequence - right.sequence);
}

function inShift(minute: number, availability: Availability | undefined): boolean {
  const shifts = availability?.shifts;
  if (!shifts?.length) return true;
  const dayMinute = minute % 1_440;
  return shifts.some((shift) => dayMinute >= shift.startMinute && dayMinute < shift.endMinute);
}

function isBuffer(node: PlantLiteNode): node is Extract<PlantLiteNode, { kind: "buffer" | "queue-buffer" }> {
  return node.kind === "buffer" || node.kind === "queue-buffer";
}

function findNode(runtime: Runtime, nodeId: string): PlantLiteNode {
  const node = runtime.model.nodes.find((item) => item.id === nodeId);
  if (!node) throw new Error(`unknown node ${nodeId}`);
  return node;
}

function nodeState(runtime: Runtime, nodeId: string): NodeState {
  const state = runtime.states.get(nodeId);
  if (!state) throw new Error(`unknown node ${nodeId}`);
  return state;
}

function resourceState(runtime: Runtime, resourceId: string): ResourceState {
  const state = runtime.resources.get(resourceId);
  if (!state) throw new Error(`unknown resource ${resourceId}`);
  return state;
}

function resourceDefinition(runtime: Runtime, resourceId: string) {
  const resource = (runtime.model.resources ?? []).find((item) => item.id === resourceId);
  if (!resource) throw new Error(`unknown resource ${resourceId}`);
  return resource;
}

function nodeCapacity(runtime: Runtime, node: Extract<PlantLiteNode, { kind: "station" | "transport" }>): number {
  return node.kind === "station" ? node.capacity ?? 1 : resourceDefinition(runtime, node.resourceId).capacity;
}

function emptyNodeState(): NodeState {
  return { input: [], output: [], active: 0, generated: 0, busyArea: 0, availableArea: 0, queueArea: 0, blocked: 0, starved: 0 };
}

function emptyResourceState(): ResourceState {
  return { busy: 0, busyArea: 0, availableArea: 0, failed: false, failedArea: 0 };
}
