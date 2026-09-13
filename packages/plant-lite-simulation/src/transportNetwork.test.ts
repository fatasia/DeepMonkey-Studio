import { describe, expect, it } from "vitest";
import { runPlantLiteExperiment } from "./engine.js";
import { validatePlantLiteModel } from "./modelValidation.js";
import { createAgvNetworkPlantLiteModel } from "./transportNetworkTemplate.js";

const execute = (model = createAgvNetworkPlantLiteModel()) => runPlantLiteExperiment({ model, seed: "network-v1", replications: 1, limits: { durationMinutes: 60 }, trace: { maxEvents: 2000, maxItems: 50 } });

describe("multi-AGV network and domain handoff", () => {
  it("keeps unique vehicles, empty returns and conflict-free reservations through conveyor/robot handoffs", () => {
    const model = createAgvNetworkPlantLiteModel();
    const result = execute(model);
    const events = result.representativeTrace!.events;
    const starts = events.filter(event => "transport" in event && event.transport);
    const reservations = starts.flatMap(event => "transport" in event && event.transport ? [event.transport] : []);
    expect(new Set(reservations.map(item => item.vehicleId)).size).toBe(3);
    expect(reservations.some(item => item.waitMinutes > 0)).toBe(true);
    expect(reservations.some(item => item.legs.some(leg => !leg.loaded))).toBe(true);
    const legs = reservations.flatMap(item => item.legs);
    for (let i = 0; i < legs.length; i += 1) for (let j = i + 1; j < legs.length; j += 1) {
      const a = legs[i]!, b = legs[j]!;
      const zone = (id: string) => model.transportNetwork!.segments.find(edge => edge.id === id)!.conflictZone;
      if (zone(a.segmentId) === zone(b.segmentId)) expect(Math.min(a.endMinute, b.endMinute) - Math.max(a.startMinute, b.startMinute)).toBeLessThanOrEqual(1e-8);
    }
    expect(result.replications[0]!.completedItems).toBe(30);
    for (const nodeId of ["agv", "belt", "station", "sink"]) expect(events.some(event => "itemId" in event && event.itemId === "source:1" && event.nodeId === nodeId && event.type === "item-complete")).toBe(true);
    expect(execute(model)).toEqual(result);
  });

  it("waits for a blocked corridor and recovers without holding a circular chain of locks", () => {
    const model = createAgvNetworkPlantLiteModel();
    model.transportNetwork!.segments.forEach(segment => { segment.blockedUntilMinute = 10; });
    const result = execute(model);
    const trips = result.representativeTrace!.events.flatMap(event => "transport" in event && event.transport ? [event.transport] : []);
    expect(trips[0]!.legs[0]!.startMinute).toBeGreaterThanOrEqual(10);
    expect(result.replications[0]!.completedItems).toBe(30);
  });

  it("rejects unreachable empty returns and invalid mixed fleet modes before execution", () => {
    const model = createAgvNetworkPlantLiteModel();
    model.transportNetwork!.segments = model.transportNetwork!.segments.filter(segment => !segment.id.startsWith("back"));
    expect(validatePlantLiteModel(model)).toMatchObject({ valid: false });
    const mixed = createAgvNetworkPlantLiteModel();
    const transport = mixed.nodes.find(node => node.kind === "transport" && node.id === "agv")!;
    if (transport.kind === "transport") delete transport.journey;
    expect(validatePlantLiteModel(mixed)).toMatchObject({ valid: false });
    const invalid = createAgvNetworkPlantLiteModel();
    invalid.transportNetwork!.segments[0]!.lengthMeters = Number.NaN;
    expect(validatePlantLiteModel(invalid)).toMatchObject({ valid: false });
  });
});
