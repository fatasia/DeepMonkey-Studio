import type { Availability, PlantLiteNode, PlantLiteReplication, PlantLiteModel, SimulationLimits } from "./model.js";
import { plantLiteEffectiveCapacity, plantLiteRequiredResourceIds } from "./capacity.js";
import { advancePlantLiteEnergy, createPlantLiteEnergyState } from "./energyRuntime.js";
import { SimulationEventQueue } from "./eventQueue.js";
import { addPlantLiteOperatingMinutes, isPlantLiteAvailableAt, unionPlantLiteAvailabilities } from "./operatingCalendar.js";
import { mixSeed, sample, seedNumber, Random } from "./random.js";
import type { ChangeoverEventData, Item, NodeState, ResourceState, Runtime, SimulationEvent } from "./runtimeTypes.js";
import type { PlantLiteTraceRecorder } from "./trace.js";
import { TransportNetworkScheduler } from "./transportNetwork.js";

export function runReplication(
  model: PlantLiteModel,
  replication: number,
  seed: number,
  limits: Required<SimulationLimits>,
  shouldCancel: (() => boolean) | undefined,
  toMetrics: (runtime: Runtime, termination: PlantLiteReplication["termination"], reason?: PlantLiteReplication["reason"]) => PlantLiteReplication,
  trace?: PlantLiteTraceRecorder,
): PlantLiteReplication {
  const runtime = createRuntime(model, seed, limits, trace);
  let termination: PlantLiteReplication["termination"] = "completed";
  let reason: PlantLiteReplication["reason"];
  while (true) {
    if (shouldCancel?.()) {
      termination = "cancelled";
      reason = "cancelled";
      break;
    }
    const event = runtime.events.peek();
    if (!event || event.at > limits.durationMinutes) break;
    if (runtime.eventsProcessed >= limits.maxEvents) {
      termination = "limit-reached";
      reason = "max-events";
      break;
    }
    runtime.events.pop();
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

function createRuntime(model: PlantLiteModel, seed: number, limits: Required<SimulationLimits>, trace?: PlantLiteTraceRecorder): Runtime {
  const energy = createPlantLiteEnergyState(model);
  const qualityStations = model.nodes.filter((node) => node.kind === "station" && node.yieldRate !== undefined);
  const runtime: Runtime = {
    model,
    random: new Random(seed),
    productRandom: new Random(mixSeed(seed, 0x504d)),
    qualityRandoms: new Map(qualityStations.map((node) => [node.id, new Random(mixSeed(seed, seedNumber(`quality:${node.id}`)))])),
    qualityEnabled: qualityStations.length > 0,
    limits,
    states: new Map(),
    resources: new Map(),
    outgoing: new Map(),
    events: new SimulationEventQueue(),
    now: 0,
    sequence: 0,
    eventsProcessed: 0,
    created: 0,
    completed: 0,
    scrapped: 0,
    measuredCompleted: 0,
    measuredScrapped: 0,
    completedByProductType: new Map(),
    productionOrders: new Map((model.productionOrders ?? []).map((order) => [order.id, {
      releasedItems: 0,
      completedItems: 0,
      scrappedItems: 0,
      completedOnTimeItems: 0,
    }])),
    productionOrderQueues: createProductionOrderQueues(model),
    leadTotal: 0,
    wipArea: 0,
    ...(energy ? { energy } : {}),
    ...(trace ? { trace } : {}),
    ...(model.transportNetwork ? { transport: new TransportNetworkScheduler(model.transportNetwork, model) } : {}),
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
  const hasProductionOrders = runtime.productionOrderQueues.size > 0;
  for (const node of runtime.model.nodes) {
    if (node.kind === "source" && !hasProductionOrders) schedule(runtime, node.initialDelay ?? 0, "arrival", node.id);
    if (node.kind === "source" && hasProductionOrders) {
      const releaseMinute = nextProductionOrderReleaseMinute(runtime, node.id);
      if (releaseMinute !== undefined) schedule(runtime, releaseMinute, "arrival", node.id);
    }
    if (node.kind === "station") scheduleAvailability(runtime, node.id, node.availability);
  }
  for (const resource of runtime.model.resources ?? []) {
    scheduleAvailability(runtime, resource.id, resource.availability);
    if (resource.failure) {
      for (let unitIndex = 0; unitIndex < resource.capacity; unitIndex += 1) {
        scheduleNextFailure(runtime, resource.id, unitIndex, 0);
      }
    }
  }
}

function handleEvent(runtime: Runtime, event: SimulationEvent): void {
  if (event.type === "arrival") return handleArrival(runtime, event);
  if (event.type === "changeover-complete") return handleChangeoverCompletion(runtime, event);
  if (event.type === "complete") return handleCompletion(runtime, event);
  if (event.type === "failure") return handleFailure(runtime, event.id, event.unitIndex ?? 0);
  if (event.type === "repair") return handleRepair(runtime, event.id, event.unitIndex ?? 0);
  // 班次边界只触发重新派工，不抢占正在执行的作业。
}

function handleArrival(runtime: Runtime, event: SimulationEvent): void {
  const node = findNode(runtime, event.id);
  if (node.kind !== "source") throw new Error("arrival targeted a non-source node");
  const state = nodeState(runtime, node.id);
  const hasProductionOrders = runtime.productionOrderQueues.size > 0;
  const order = hasProductionOrders ? selectReadyProductionOrder(runtime, node.id) : undefined;
  if (hasProductionOrders && !order) {
    const releaseMinute = nextProductionOrderReleaseMinute(runtime, node.id);
    if (releaseMinute !== undefined) schedule(runtime, releaseMinute, "arrival", node.id);
    return;
  }
  runtime.created += 1;
  state.generated += 1;
  const orderState = order ? runtime.productionOrders.get(order.id) : undefined;
  if (order && !orderState) throw new Error(`missing production order state ${order.id}`);
  if (orderState) orderState.releasedItems += 1;
  const productTypeId = order?.productTypeId ?? sampleProductType(runtime);
  const item: Item = {
    id: order ? `${node.id}:${order.id}:${orderState?.releasedItems ?? state.generated}` : `${node.id}:${state.generated}`,
    createdAt: runtime.now,
    ...(productTypeId ? { productTypeId } : {}),
    ...(order ? { orderId: order.id } : {}),
  };
  state.output.push(item);
  traceItem(runtime, "item-enter", item, node.id);
  if (order) {
    if ((orderState?.releasedItems ?? 0) >= order.quantity) removeProductionOrderFromQueue(runtime, node.id, order.id);
    scheduleNextProductionOrderArrival(runtime, node);
  } else if (node.maxItems === undefined || state.generated < node.maxItems) {
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
  traceItem(runtime, "item-complete", event.item, node.id);
  const scrapped = node.kind === "station" && itemIsScrapped(runtime, node);
  if (node.kind === "station" && node.yieldRate !== undefined && runtime.now >= runtime.limits.warmupMinutes) {
    state.qualityInspected += 1;
    if (scrapped) state.qualityScrapped += 1;
    else state.qualityPassed += 1;
  }
  if (scrapped && node.kind === "station") {
    runtime.scrapped += 1;
    if (runtime.now >= runtime.limits.warmupMinutes) runtime.measuredScrapped += 1;
    if (event.item.orderId) {
      const orderState = runtime.productionOrders.get(event.item.orderId);
      if (orderState) orderState.scrappedItems += 1;
    }
    traceItem(runtime, "item-scrap", event.item, node.id, undefined, {
      configuredYieldRate: node.yieldRate ?? 1,
      disposition: "scrap",
    });
  } else {
    state.output.push(event.item);
  }
  releaseResource(runtime, node);
}

function handleChangeoverCompletion(runtime: Runtime, event: SimulationEvent): void {
  const node = findNode(runtime, event.id);
  if (!event.item || !event.changeover || node.kind !== "station") {
    throw new Error("changeover completion event is malformed");
  }
  const state = nodeState(runtime, node.id);
  state.changeoverActive = Math.max(0, state.changeoverActive - 1);
  traceItem(runtime, "item-changeover-complete", event.item, node.id, event.changeover);
  startProcessing(runtime, node, event.item);
}

function handleFailure(runtime: Runtime, resourceId: string, unitIndex: number): void {
  const resource = resourceState(runtime, resourceId);
  if (resource.failedUnits.has(unitIndex)) return;
  resource.failedUnits.add(unitIndex);
  runtime.trace?.resource("resource-failure", runtime.now, resourceId, unitIndex, resource.failedUnits.size);
  const profile = resourceDefinition(runtime, resourceId).failure;
  if (profile) schedule(runtime, runtime.now + sample(profile.repairTime, runtime.random), "repair", resourceId, undefined, unitIndex);
}

function handleRepair(runtime: Runtime, resourceId: string, unitIndex: number): void {
  const resource = resourceState(runtime, resourceId);
  if (!resource.failedUnits.delete(unitIndex)) return;
  runtime.trace?.resource("resource-repair", runtime.now, resourceId, unitIndex, resource.failedUnits.size);
  scheduleNextFailure(runtime, resourceId, unitIndex, runtime.now);
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
      const target = findNode(runtime, targetId);
      if (!accept(runtime, target, item)) continue;
      items.shift();
      traceItem(runtime, "item-exit", item, node.id);
      traceItem(runtime, "item-enter", item, target.id);
      if (target.kind === "sink") traceItem(runtime, "item-complete", item, target.id);
      changed = true;
      break;
    }
  }
  return changed;
}

function accept(runtime: Runtime, target: PlantLiteNode, item: Item): boolean {
  if (target.kind === "source") return false;
  if (target.kind === "sink") {
    runtime.completed += 1;
    if (item.orderId) {
      const order = runtime.model.productionOrders?.find((candidate) => candidate.id === item.orderId);
      const orderState = runtime.productionOrders.get(item.orderId);
      if (order && orderState) {
        orderState.completedItems += 1;
        orderState.firstCompletionMinute ??= runtime.now;
        orderState.lastCompletionMinute = runtime.now;
        if (runtime.now <= runtime.limits.warmupMinutes + order.dueMinute) orderState.completedOnTimeItems += 1;
      }
    }
    if (runtime.now >= runtime.limits.warmupMinutes) {
      runtime.measuredCompleted += 1;
      if (item.productTypeId) {
        runtime.completedByProductType.set(item.productTypeId, (runtime.completedByProductType.get(item.productTypeId) ?? 0) + 1);
      }
      // 在正式窗口内完工的在制件保留从进入系统起的完整交付期，避免截短跨越预热边界的订单。
      runtime.leadTotal += runtime.now - item.createdAt;
    }
    return true;
  }
  const state = nodeState(runtime, target.id);
  const capacity = isBuffer(target) ? target.capacity : target.queueCapacity ?? 100;
  if (state.input.length >= capacity) return false;
  state.input.push(item);
  return true;
}

function createProductionOrderQueues(model: PlantLiteModel): Runtime["productionOrderQueues"] {
  const queues = new Map<string, NonNullable<PlantLiteModel["productionOrders"]>>();
  for (const order of model.productionOrders ?? []) {
    const queue = queues.get(order.sourceNodeId) ?? [];
    queue.push(order);
    queues.set(order.sourceNodeId, queue);
  }
  return queues;
}

function selectReadyProductionOrder(runtime: Runtime, sourceNodeId: string) {
  const releaseOffset = runtime.limits.warmupMinutes;
  return runtime.productionOrderQueues.get(sourceNodeId)
    ?.filter((order) => releaseOffset + order.releaseMinute <= runtime.now)
    .sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0)
      || left.releaseMinute - right.releaseMinute
      || left.id.localeCompare(right.id))[0];
}

function nextProductionOrderReleaseMinute(runtime: Runtime, sourceNodeId: string): number | undefined {
  const queue = runtime.productionOrderQueues.get(sourceNodeId);
  if (!queue?.length) return undefined;
  return runtime.limits.warmupMinutes + Math.min(...queue.map((order) => order.releaseMinute));
}

function removeProductionOrderFromQueue(runtime: Runtime, sourceNodeId: string, orderId: string): void {
  const queue = runtime.productionOrderQueues.get(sourceNodeId);
  if (!queue) return;
  const index = queue.findIndex((order) => order.id === orderId);
  if (index >= 0) queue.splice(index, 1);
  if (!queue.length) runtime.productionOrderQueues.delete(sourceNodeId);
}

function scheduleNextProductionOrderArrival(runtime: Runtime, source: Extract<PlantLiteNode, { kind: "source" }>): void {
  const nextReleaseMinute = nextProductionOrderReleaseMinute(runtime, source.id);
  if (nextReleaseMinute === undefined) return;
  const nextTaktMinute = runtime.now + sample(source.interarrivalTime, runtime.random);
  schedule(runtime, Math.max(nextTaktMinute, nextReleaseMinute), "arrival", source.id);
}

function startReadyNodes(runtime: Runtime): void {
  // 没有人工池时完整保留旧派工顺序与求解结果。
  if (!runtime.model.nodes.some((node) => node.kind === "station" && node.workerResourceId)) {
    startReadyNodesInModelOrder(runtime);
    return;
  }
  for (const node of runtime.model.nodes) {
    if ((node.kind !== "station" && node.kind !== "transport") || (node.kind === "station" && node.workerResourceId)) continue;
    startAvailableWork(runtime, node);
  }
  // 共享人工池按最早进入系统的工件优先，避免上游工位长期占满人员造成下游饥饿。
  while (true) {
    const ready = runtime.model.nodes
      .map((node, index) => ({ node, index }))
      .filter((entry): entry is { node: Extract<PlantLiteNode, { kind: "station" }>; index: number } =>
        entry.node.kind === "station"
        && Boolean(entry.node.workerResourceId)
        && nodeState(runtime, entry.node.id).input.length > 0
        && nodeState(runtime, entry.node.id).active < plantLiteEffectiveCapacity(runtime.model, entry.node)
        && canAcquire(runtime, entry.node))
      .sort((left, right) => {
        const leftItem = nodeState(runtime, left.node.id).input[0];
        const rightItem = nodeState(runtime, right.node.id).input[0];
        return (leftItem?.createdAt ?? 0) - (rightItem?.createdAt ?? 0) || left.index - right.index;
      });
    const selected = ready[0]?.node;
    if (!selected) break;
    startOne(runtime, selected);
  }
}

function startReadyNodesInModelOrder(runtime: Runtime): void {
  for (const node of runtime.model.nodes) {
    if (node.kind !== "station" && node.kind !== "transport") continue;
    startAvailableWork(runtime, node);
  }
}

function startAvailableWork(runtime: Runtime, node: Extract<PlantLiteNode, { kind: "station" | "transport" }>): void {
  const state = nodeState(runtime, node.id);
  const capacity = plantLiteEffectiveCapacity(runtime.model, node);
  while (state.input.length > 0 && state.active < capacity && canAcquire(runtime, node)) startOne(runtime, node);
}

function startOne(runtime: Runtime, node: Extract<PlantLiteNode, { kind: "station" | "transport" }>): void {
  const state = nodeState(runtime, node.id);
  const item = state.input.shift();
  if (!item) return;
  state.active += 1;
  acquireResource(runtime, node);
  beginProcessing(runtime, node, item);
}

function beginProcessing(runtime: Runtime, node: Extract<PlantLiteNode, { kind: "station" | "transport" }>, item: Item): void {
  if (node.kind === "station" && item.productTypeId) {
    const state = nodeState(runtime, node.id);
    const previousProductTypeId = state.lastProductTypeId;
    state.lastProductTypeId = item.productTypeId;
    const rule = previousProductTypeId === undefined || previousProductTypeId === item.productTypeId
      ? undefined
      : node.changeovers?.find((candidate) =>
        candidate.fromProductTypeId === previousProductTypeId && candidate.toProductTypeId === item.productTypeId);
    if (rule) {
      const changeover: ChangeoverEventData = {
        fromProductTypeId: rule.fromProductTypeId,
        toProductTypeId: rule.toProductTypeId,
        startMinute: runtime.now,
        durationMinutes: rule.minutes,
      };
      if (runtime.now >= runtime.limits.warmupMinutes) state.changeoverCount += 1;
      state.changeoverActive += 1;
      traceItem(runtime, "item-changeover-start", item, node.id, changeover);
      schedule(runtime, runtime.now + rule.minutes, "changeover-complete", node.id, item, undefined, changeover);
      return;
    }
  }
  startProcessing(runtime, node, item);
}

function startProcessing(runtime: Runtime, node: Extract<PlantLiteNode, { kind: "station" | "transport" }>, item: Item): void {
  if (node.kind === "transport" && node.journey && runtime.transport) {
    const reservation = runtime.transport.reserve(node.resourceId, node.journey, runtime.now, resourceState(runtime, node.resourceId).failedUnits);
    runtime.trace?.item("item-start", runtime.now, item.id, node.id, item.productTypeId, item.orderId, undefined, undefined, reservation);
    schedule(runtime, reservation.finishMinute, "complete", node.id, item);
    return;
  }
  traceItem(runtime, "item-start", item, node.id);
  const distribution = node.kind === "station" ? node.processingTime : node.travelTime;
  schedule(runtime, runtime.now + sample(distribution, runtime.random), "complete", node.id, item);
}

function sampleProductType(runtime: Runtime): string | undefined {
  const productTypes = runtime.model.productTypes;
  if (!productTypes?.length) return undefined;
  const draw = runtime.productRandom.next();
  let cumulative = 0;
  for (const productType of productTypes) {
    cumulative += productType.share;
    if (draw < cumulative) return productType.id;
  }
  return productTypes.at(-1)?.id;
}

function traceItem(
  runtime: Runtime,
  type: Parameters<NonNullable<Runtime["trace"]>["item"]>[0],
  item: Item,
  nodeId: string,
  changeover?: ChangeoverEventData,
  quality?: { configuredYieldRate: number; disposition: "scrap" },
): void {
  runtime.trace?.item(type, runtime.now, item.id, nodeId, item.productTypeId, item.orderId, changeover, quality);
}

function itemIsScrapped(runtime: Runtime, node: Extract<PlantLiteNode, { kind: "station" }>): boolean {
  if (node.yieldRate === undefined || node.yieldRate >= 1) return false;
  if (node.yieldRate <= 0) return true;
  const random = runtime.qualityRandoms.get(node.id);
  if (!random) throw new Error(`missing quality random stream for ${node.id}`);
  return random.next() >= node.yieldRate;
}

function advance(runtime: Runtime, target: number): void {
  const elapsed = target - runtime.now;
  if (elapsed < 0) throw new Error("event queue is not ordered");
  if (elapsed === 0) return;
  const measuredElapsed = Math.max(0, target - Math.max(runtime.now, runtime.limits.warmupMinutes));
  if (measuredElapsed > 0) {
    advancePlantLiteEnergy(runtime, measuredElapsed);
    runtime.wipArea += (runtime.created - runtime.completed - runtime.scrapped) * measuredElapsed;
    for (const node of runtime.model.nodes) advanceNode(runtime, node, measuredElapsed);
    for (const resource of runtime.model.resources ?? []) {
      advanceResource(runtime, resource.id, resourceOperatingAvailability(runtime, resource.id), resource.capacity, measuredElapsed);
    }
  }
  runtime.now = target;
}

function advanceNode(runtime: Runtime, node: PlantLiteNode, elapsed: number): void {
  const state = nodeState(runtime, node.id);
  state.queueArea += state.input.length * elapsed;
  state.busyArea += state.active * elapsed;
  state.changeoverArea += state.changeoverActive * elapsed;
  if ((node.kind === "station" || node.kind === "transport") && isScheduled(runtime, node)) {
    state.availableArea += nodeCapacity(runtime, node) * elapsed;
  } else if ((node.kind === "station" || node.kind === "transport") && state.active > 0) {
    // 非抢占任务可跨班完成；把实际加班占用计入分母，避免计划利用率虚高到 100% 以上。
    state.availableArea += state.active * elapsed;
  }
  if (isBuffer(node) ? state.input.length >= node.capacity : state.output.length > 0) state.blocked += elapsed;
  if (
    (node.kind === "station" || node.kind === "transport")
    && state.input.length === 0
    && state.active < nodeCapacity(runtime, node)
    && canAcquire(runtime, node)
  ) {
    state.starved += elapsed;
  }
}

function advanceResource(runtime: Runtime, resourceId: string, availability: Availability | undefined, capacity: number, elapsed: number): void {
  const state = resourceState(runtime, resourceId);
  state.busyArea += state.busy * elapsed;
  if (isPlantLiteAvailableAt(runtime.now, availability)) state.availableArea += capacity * elapsed;
  else if (state.busy > 0) state.availableArea += state.busy * elapsed;
  if (isPlantLiteAvailableAt(runtime.now, availability)) state.failedArea += state.failedUnits.size * elapsed;
}

function canAcquire(runtime: Runtime, node: Extract<PlantLiteNode, { kind: "station" | "transport" }>): boolean {
  if (!isOperational(runtime, node)) return false;
  return plantLiteRequiredResourceIds(node).every((resourceId) => {
    const resource = resourceState(runtime, resourceId);
    return resource.busy < resourceDefinition(runtime, resourceId).capacity - resource.failedUnits.size;
  });
}

function isOperational(runtime: Runtime, node: Extract<PlantLiteNode, { kind: "station" | "transport" }>): boolean {
  if (!isScheduled(runtime, node)) return false;
  return plantLiteRequiredResourceIds(node).every((resourceId) => {
    const resource = resourceState(runtime, resourceId);
    return resource.failedUnits.size < resourceDefinition(runtime, resourceId).capacity;
  });
}

function isScheduled(runtime: Runtime, node: Extract<PlantLiteNode, { kind: "station" | "transport" }>): boolean {
  if (node.kind === "station" && !isPlantLiteAvailableAt(runtime.now, node.availability)) return false;
  return plantLiteRequiredResourceIds(node).every((resourceId) =>
    isPlantLiteAvailableAt(runtime.now, resourceOperatingAvailability(runtime, resourceId)));
}

function acquireResource(runtime: Runtime, node: Extract<PlantLiteNode, { kind: "station" | "transport" }>): void {
  for (const resourceId of plantLiteRequiredResourceIds(node)) resourceState(runtime, resourceId).busy += 1;
}

function releaseResource(runtime: Runtime, node: Extract<PlantLiteNode, { kind: "station" | "transport" }>): void {
  for (const resourceId of plantLiteRequiredResourceIds(node)) resourceState(runtime, resourceId).busy -= 1;
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

function schedule(
  runtime: Runtime,
  at: number,
  type: SimulationEvent["type"],
  id: string,
  item?: Item,
  unitIndex?: number,
  changeover?: ChangeoverEventData,
  orderId?: string,
): void {
  runtime.events.push({
    at,
    sequence: runtime.sequence++,
    type,
    id,
    ...(item ? { item } : {}),
    ...(unitIndex !== undefined ? { unitIndex } : {}),
    ...(changeover ? { changeover } : {}),
    ...(orderId ? { orderId } : {}),
  });
}

function scheduleNextFailure(runtime: Runtime, resourceId: string, unitIndex: number, from: number): void {
  const profile = resourceDefinition(runtime, resourceId).failure;
  if (!profile) return;
  const operatingMinutes = sample(profile.timeToFailure, runtime.random);
  const at = addPlantLiteOperatingMinutes(from, operatingMinutes, resourceOperatingAvailability(runtime, resourceId));
  schedule(runtime, at, "failure", resourceId, undefined, unitIndex);
}

function resourceOperatingAvailability(runtime: Runtime, resourceId: string): Availability | undefined {
  const resource = resourceDefinition(runtime, resourceId);
  if (resource.availability?.shifts?.length) return resource.availability;
  if (resource.kind !== "equipment") return undefined;
  const stations = runtime.model.nodes.filter((node): node is Extract<typeof node, { kind: "station" }> =>
    node.kind === "station" && node.resourceId === resourceId);
  return unionPlantLiteAvailabilities(stations.map((station) => station.availability));
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
  return plantLiteEffectiveCapacity(runtime.model, node);
}

function emptyNodeState(): NodeState {
  return {
    input: [],
    output: [],
    active: 0,
    generated: 0,
    busyArea: 0,
    availableArea: 0,
    queueArea: 0,
    blocked: 0,
    starved: 0,
    changeoverCount: 0,
    changeoverActive: 0,
    changeoverArea: 0,
    qualityInspected: 0,
    qualityPassed: 0,
    qualityScrapped: 0,
  };
}

function emptyResourceState(): ResourceState {
  return { busy: 0, busyArea: 0, availableArea: 0, failedUnits: new Set(), failedArea: 0 };
}
