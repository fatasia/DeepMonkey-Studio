import { assertFactoryFlowModel, type FactoryEdge, type FactoryFlowModel, type FactoryNode } from "./model.js";

export type SimulationStatus = "paused" | "running";

export interface FactoryNodeMetrics {
  nodeId: string;
  kind: FactoryNode["kind"];
  queueLength: number;
  completedItems: number;
  utilization: number;
}

export interface FactoryFlowMetrics {
  throughput: number;
  throughputPerHour: number;
  averageCycleTimeMs: number;
  wip: number;
  bottleneckNodeId?: string;
  nodes: FactoryNodeMetrics[];
}

export interface FactoryFlowSnapshot {
  status: SimulationStatus;
  clockMs: number;
  speed: number;
  metrics: FactoryFlowMetrics;
}

interface FlowItem {
  id: string;
  createdAtMs: number;
}

type SimulationEventType = "source-create" | "resource-complete";

interface SimulationEvent {
  timeMs: number;
  sequence: number;
  type: SimulationEventType;
  nodeId: string;
  item?: FlowItem;
  startedAtMs?: number;
}

interface NodeRuntime {
  node: FactoryNode;
  waiting: FlowItem[];
  output: FlowItem[];
  active: number;
  completed: number;
  accumulatedBusyMs: number;
  activeStartedAtMs: number[];
  generated: number;
}

const DEFAULT_QUEUE_CAPACITY = 100;
const MIN_SPEED = 0.1;
const MAX_SPEED = 100;

/** Lightweight deterministic discrete-event runtime. It performs no rendering or I/O. */
export class FactoryFlowSimulation {
  readonly #model: FactoryFlowModel;
  readonly #nodes = new Map<string, NodeRuntime>();
  readonly #outgoing = new Map<string, FactoryEdge[]>();
  #events: SimulationEvent[] = [];
  #sequence = 0;
  #status: SimulationStatus = "paused";
  #clockMs = 0;
  #speed = 1;
  #created = 0;
  #completed = 0;
  #totalCycleTimeMs = 0;

  public constructor(modelInput: FactoryFlowModel) {
    this.#model = assertFactoryFlowModel(modelInput);
    this.reset();
  }

  public get model(): FactoryFlowModel {
    return structuredClone(this.#model);
  }

  public run(): FactoryFlowSnapshot {
    this.#status = "running";
    return this.snapshot();
  }

  public pause(): FactoryFlowSnapshot {
    this.#status = "paused";
    return this.snapshot();
  }

  public setSpeed(multiplier: number): FactoryFlowSnapshot {
    if (!Number.isFinite(multiplier) || multiplier < MIN_SPEED || multiplier > MAX_SPEED) {
      throw new RangeError(`speed must be between ${MIN_SPEED} and ${MAX_SPEED}`);
    }
    this.#speed = multiplier;
    return this.snapshot();
  }

  /** Advances simulation time by wall-clock delta multiplied by the selected speed. */
  public advance(realDeltaMs: number): FactoryFlowSnapshot {
    if (!Number.isFinite(realDeltaMs) || realDeltaMs < 0) throw new RangeError("realDeltaMs must be a non-negative finite number");
    if (this.#status === "running") this.#advanceTo(this.#clockMs + realDeltaMs * this.#speed);
    return this.snapshot();
  }

  public reset(): FactoryFlowSnapshot {
    this.#status = "paused";
    this.#clockMs = 0;
    this.#sequence = 0;
    this.#created = 0;
    this.#completed = 0;
    this.#totalCycleTimeMs = 0;
    this.#events = [];
    this.#nodes.clear();
    this.#outgoing.clear();

    for (const node of this.#model.nodes) {
      this.#nodes.set(node.id, {
        node,
        waiting: [],
        output: [],
        active: 0,
        completed: 0,
        accumulatedBusyMs: 0,
        activeStartedAtMs: [],
        generated: 0
      });
    }
    for (const edge of this.#model.edges) {
      const outgoing = this.#outgoing.get(edge.from) ?? [];
      outgoing.push(edge);
      this.#outgoing.set(edge.from, outgoing);
    }
    for (const edges of this.#outgoing.values()) {
      edges.sort((left, right) => (left.priority ?? 0) - (right.priority ?? 0) || left.id.localeCompare(right.id));
    }
    for (const node of this.#model.nodes) {
      if (node.kind === "source") this.#schedule(node.initialDelayMs ?? 0, "source-create", node.id);
    }
    return this.snapshot();
  }

  public snapshot(): FactoryFlowSnapshot {
    const nodes = this.#model.nodes.map((node) => {
      const runtime = this.#runtime(node.id);
      const capacity = resourceCapacity(node);
      const activeBusyMs = runtime.activeStartedAtMs.reduce((total, startedAt) => total + (this.#clockMs - startedAt), 0);
      const utilization = capacity > 0 && this.#clockMs > 0
        ? Math.min(1, (runtime.accumulatedBusyMs + activeBusyMs) / (capacity * this.#clockMs))
        : 0;
      return {
        nodeId: node.id,
        kind: node.kind,
        queueLength: runtime.waiting.length + runtime.output.length,
        completedItems: runtime.completed,
        utilization
      } satisfies FactoryNodeMetrics;
    });
    const bottleneck = nodes
      .filter((node) => node.kind === "process" || node.kind === "agv")
      .sort((left, right) => right.utilization - left.utilization || left.nodeId.localeCompare(right.nodeId))[0];
    const metrics: FactoryFlowMetrics = {
      throughput: this.#completed,
      throughputPerHour: this.#clockMs > 0 ? this.#completed * 3_600_000 / this.#clockMs : 0,
      averageCycleTimeMs: this.#completed > 0 ? this.#totalCycleTimeMs / this.#completed : 0,
      wip: this.#created - this.#completed,
      nodes,
      ...(bottleneck ? { bottleneckNodeId: bottleneck.nodeId } : {})
    };
    return { status: this.#status, clockMs: this.#clockMs, speed: this.#speed, metrics };
  }

  #advanceTo(targetMs: number): void {
    while (true) {
      const event = this.#nextEvent();
      if (!event || event.timeMs > targetMs) break;
      this.#events.shift();
      this.#clockMs = event.timeMs;
      this.#handleEvent(event);
    }
    this.#clockMs = targetMs;
  }

  #handleEvent(event: SimulationEvent): void {
    const runtime = this.#runtime(event.nodeId);
    if (event.type === "source-create") {
      if (runtime.node.kind !== "source") throw new Error(`source event targeted ${runtime.node.kind}`);
      runtime.generated += 1;
      this.#created += 1;
      runtime.output.push({ id: `${runtime.node.id}:${runtime.generated}`, createdAtMs: this.#clockMs });
      if (runtime.node.maxItems === undefined || runtime.generated < runtime.node.maxItems) {
        this.#schedule(this.#clockMs + runtime.node.interarrivalTimeMs, "source-create", runtime.node.id);
      }
    } else {
      if (!event.item || event.startedAtMs === undefined) throw new Error("resource completion event is incomplete");
      runtime.active -= 1;
      const startedIndex = runtime.activeStartedAtMs.indexOf(event.startedAtMs);
      if (startedIndex >= 0) runtime.activeStartedAtMs.splice(startedIndex, 1);
      runtime.accumulatedBusyMs += this.#clockMs - event.startedAtMs;
      runtime.completed += 1;
      runtime.output.push(event.item);
    }
    this.#drainNetwork();
    this.#startResources();
    this.#drainNetwork();
  }

  #drainNetwork(): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of this.#model.nodes) {
        const runtime = this.#runtime(node.id);
        const queue = node.kind === "buffer" ? runtime.waiting : runtime.output;
        const item = queue[0];
        if (!item) continue;
        for (const edge of this.#outgoing.get(node.id) ?? []) {
          if (!this.#accept(edge.to, item)) continue;
          queue.shift();
          changed = true;
          break;
        }
      }
      if (changed) this.#startResources();
    }
  }

  #accept(nodeId: string, item: FlowItem): boolean {
    const runtime = this.#runtime(nodeId);
    const node = runtime.node;
    if (node.kind === "source") return false;
    if (node.kind === "sink") {
      runtime.completed += 1;
      this.#completed += 1;
      this.#totalCycleTimeMs += this.#clockMs - item.createdAtMs;
      return true;
    }
    if (node.kind === "buffer") {
      if (runtime.waiting.length >= node.capacity) return false;
      runtime.waiting.push(item);
      return true;
    }
    const queueCapacity = node.queueCapacity ?? DEFAULT_QUEUE_CAPACITY;
    if (runtime.waiting.length >= queueCapacity) return false;
    runtime.waiting.push(item);
    return true;
  }

  #startResources(): void {
    for (const node of this.#model.nodes) {
      if (node.kind !== "process" && node.kind !== "agv") continue;
      const runtime = this.#runtime(node.id);
      const capacity = resourceCapacity(node);
      const duration = node.kind === "process" ? node.cycleTimeMs : node.travelTimeMs;
      while (runtime.active < capacity && runtime.waiting.length > 0) {
        const item = runtime.waiting.shift()!;
        runtime.active += 1;
        runtime.activeStartedAtMs.push(this.#clockMs);
        this.#schedule(this.#clockMs + duration, "resource-complete", node.id, item, this.#clockMs);
      }
    }
  }

  #schedule(timeMs: number, type: SimulationEventType, nodeId: string, item?: FlowItem, startedAtMs?: number): void {
    this.#events.push({
      timeMs,
      sequence: this.#sequence++,
      type,
      nodeId,
      ...(item ? { item } : {}),
      ...(startedAtMs !== undefined ? { startedAtMs } : {})
    });
    this.#events.sort((left, right) => left.timeMs - right.timeMs || left.sequence - right.sequence);
  }

  #nextEvent(): SimulationEvent | undefined {
    return this.#events[0];
  }

  #runtime(nodeId: string): NodeRuntime {
    const runtime = this.#nodes.get(nodeId);
    if (!runtime) throw new Error(`unknown runtime node ${nodeId}`);
    return runtime;
  }
}

function resourceCapacity(node: FactoryNode): number {
  return node.kind === "process" || node.kind === "agv" ? node.capacity ?? 1 : 0;
}
