import type { PlantLiteModel, PlantLiteReplicationTrace, PlantTransportNetwork, PlantTransportReservation } from "@bim-studio/contracts";

export function transportPositionAt(network: PlantTransportNetwork, trip: PlantTransportReservation, minute: number, includeEmpty = true): [number, number, number] | undefined {
  const legs = trip.legs.filter(leg => includeEmpty || leg.loaded);
  const points = new Map(network.waypoints.map(point => [point.id, point.position]));
  for (const leg of legs) {
    const from = points.get(leg.from), to = points.get(leg.to);
    if (!from || !to) return undefined;
    if (minute < leg.startMinute) return [...from];
    if (minute <= leg.endMinute) {
      const progress = Math.max(0, Math.min(1, (minute - leg.startMinute) / (leg.endMinute - leg.startMinute)));
      return [from[0] + (to[0] - from[0]) * progress, from[1] + (to[1] - from[1]) * progress, from[2] + (to[2] - from[2]) * progress];
    }
  }
  const destination = legs.at(-1)?.to;
  return destination ? points.get(destination) : undefined;
}

export function prepareTransportTrips(trace: PlantLiteReplicationTrace) {
  return trace.events.flatMap(event => "transport" in event && event.transport ? [{ atMinute: event.atMinute, itemId: event.itemId, trip: event.transport }] : []);
}

export function transportFleetFrame(model: PlantLiteModel, trips: ReturnType<typeof prepareTransportTrips>, minute: number) {
  const network = model.transportNetwork;
  if (!network) return [];
  return network.fleets.flatMap(fleet => Array.from({ length: model.resources?.find(resource => resource.id === fleet.resourceId)?.capacity ?? 0 }, (_, unit) => {
    const id = `${fleet.resourceId}:${unit + 1}`;
    const latest = trips.filter(item => item.trip.vehicleId === id && item.atMinute <= minute).at(-1);
    const active = latest && minute < latest.trip.finishMinute;
    const leg = active ? latest.trip.legs.find(item => item.startMinute <= minute && item.endMinute > minute) : undefined;
    const state = !active ? "待机" : minute < latest.trip.startMinute ? "让行" : leg ? leg.loaded ? "载货" : "空驶" : "装卸";
    return { id, label: `${unit + 1}`, state, itemId: active ? latest.itemId : undefined,
      position: latest ? transportPositionAt(network, latest.trip, minute) : network.waypoints.find(point => point.id === fleet.homeWaypointId)?.position };
  }));
}
