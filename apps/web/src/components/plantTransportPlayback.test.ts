import { describe, expect, it } from "vitest";
import { createAgvNetworkPlantLiteModel, runPlantLiteExperiment } from "@bim-studio/plant-lite-simulation";
import { prepareTransportTrips, transportFleetFrame, transportPositionAt } from "./plantTransportPlayback";
import { derivePlantLitePlaybackFrame } from "./plantLitePlaybackModel";
import { createPlantLiteModelExchange, parsePlantLiteModelExchange } from "./plantLiteModelExchangeCodec";

describe("network transport playback and exchange", () => {
  const model = createAgvNetworkPlantLiteModel();
  const trace = runPlantLiteExperiment({ model, seed: "playback", replications: 1, limits: { durationMinutes: 60 }, trace: { maxEvents: 2000, maxItems: 50 } }).representativeTrace!;
  const trips = prepareTransportTrips(trace);

  it("moves vehicles along recorded legs while material stays at pickup during empty return", () => {
    const returning = trips.find(item => item.trip.legs.some(leg => !leg.loaded))!;
    const leg = returning.trip.legs.find(item => !item.loaded)!;
    const minute = (leg.startMinute + leg.endMinute) / 2;
    const from = model.transportNetwork!.waypoints.find(point => point.id === leg.from)!.position;
    const to = model.transportNetwork!.waypoints.find(point => point.id === leg.to)!.position;
    expect(transportPositionAt(model.transportNetwork!, returning.trip, minute)).toEqual(from.map((coordinate, index) => (coordinate + to[index]!) / 2));
    expect(transportFleetFrame(model, trips, minute).find(vehicle => vehicle.id === returning.trip.vehicleId)?.state).toBe("空驶");
    const item = derivePlantLitePlaybackFrame(trace, model, minute, 100).items.find(item => item.itemId === returning.itemId)!;
    expect(item.state).toBe("queued");
    expect(item.worldPosition).toEqual([0, 0, 0]);
    expect(transportFleetFrame(model, trips, 60).every(vehicle => vehicle.state === "待机")).toBe(true);
  });

  it("preserves network routing, blockages and journeys through portable export/import", () => {
    const exchange = createPlantLiteModelExchange(model);
    const parsed = parsePlantLiteModelExchange(JSON.stringify(exchange), "network.json");
    expect(parsed.status).toBe("ready");
    if (parsed.status !== "ready") throw new Error("invalid exchange");
    expect(parsed.preview.model.transportNetwork).toEqual(model.transportNetwork);
    expect(parsed.preview.model.nodes.find(node => node.id === "agv")).toEqual(model.nodes.find(node => node.id === "agv"));
  });
});
