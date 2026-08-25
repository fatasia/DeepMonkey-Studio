import { describe, expect, it } from "vitest";
import type { FactoryFlowModel } from "./model.js";
import { FactoryFlowSimulation } from "./simulation.js";

const PROCESS_LINE: FactoryFlowModel = {
  id: "process-line",
  name: "Process line",
  nodes: [
    { id: "source", name: "Source", kind: "source", interarrivalTimeMs: 1_000, maxItems: 3 },
    { id: "process", name: "Assembly", kind: "process", cycleTimeMs: 500 },
    { id: "sink", name: "Sink", kind: "sink" }
  ],
  edges: [
    { id: "e1", from: "source", to: "process" },
    { id: "e2", from: "process", to: "sink" }
  ]
};

describe("FactoryFlowSimulation", () => {
  it("runs a repeatable process line and calculates throughput, cycle, WIP and utilization", () => {
    const simulation = new FactoryFlowSimulation(PROCESS_LINE);
    simulation.run();
    const result = simulation.advance(3_000);

    expect(result).toMatchObject({
      status: "running",
      clockMs: 3_000,
      speed: 1,
      metrics: {
        throughput: 3,
        throughputPerHour: 3_600,
        averageCycleTimeMs: 500,
        wip: 0,
        bottleneckNodeId: "process"
      }
    });
    expect(result.metrics.nodes.find((node) => node.nodeId === "process")?.utilization).toBeCloseTo(0.5);

    simulation.reset();
    simulation.run();
    expect(simulation.advance(3_000)).toEqual(result);
  });

  it("pauses, changes speed and resets its clock without background timers", () => {
    const simulation = new FactoryFlowSimulation(PROCESS_LINE);
    expect(simulation.advance(1_000).clockMs).toBe(0);
    simulation.setSpeed(4);
    simulation.run();
    expect(simulation.advance(250).clockMs).toBe(1_000);
    simulation.pause();
    expect(simulation.advance(500).clockMs).toBe(1_000);
    expect(simulation.reset()).toMatchObject({ status: "paused", clockMs: 0, speed: 4, metrics: { throughput: 0, wip: 0 } });
    expect(() => simulation.setSpeed(0)).toThrow(RangeError);
  });

  it("models buffer backpressure and AGV transport as deterministic events", () => {
    const model: FactoryFlowModel = {
      id: "agv-line",
      name: "AGV line",
      nodes: [
        { id: "source", name: "Source", kind: "source", interarrivalTimeMs: 100, maxItems: 2 },
        { id: "buffer", name: "Buffer", kind: "buffer", capacity: 1 },
        { id: "agv", name: "AGV", kind: "agv", travelTimeMs: 200, queueCapacity: 1 },
        { id: "sink", name: "Sink", kind: "sink" }
      ],
      edges: [
        { id: "e1", from: "source", to: "buffer" },
        { id: "e2", from: "buffer", to: "agv" },
        { id: "e3", from: "agv", to: "sink" }
      ]
    };
    const simulation = new FactoryFlowSimulation(model);
    simulation.run();
    const result = simulation.advance(400);
    expect(result.metrics).toMatchObject({
      throughput: 2,
      averageCycleTimeMs: 250,
      wip: 0,
      bottleneckNodeId: "agv"
    });
    expect(result.metrics.nodes.find((node) => node.nodeId === "agv")?.utilization).toBe(1);
  });

  it("uses stable edge priority when multiple downstream nodes are available", () => {
    const model: FactoryFlowModel = {
      id: "branch",
      name: "Branch",
      nodes: [
        { id: "source", name: "Source", kind: "source", interarrivalTimeMs: 1_000, maxItems: 1 },
        { id: "sink-a", name: "Sink A", kind: "sink" },
        { id: "sink-b", name: "Sink B", kind: "sink" }
      ],
      edges: [
        { id: "later", from: "source", to: "sink-a", priority: 2 },
        { id: "first", from: "source", to: "sink-b", priority: 1 }
      ]
    };
    const simulation = new FactoryFlowSimulation(model);
    simulation.run();
    const result = simulation.advance(1);
    expect(result.metrics.nodes.find((node) => node.nodeId === "sink-a")?.completedItems).toBe(0);
    expect(result.metrics.nodes.find((node) => node.nodeId === "sink-b")?.completedItems).toBe(1);
  });
});
