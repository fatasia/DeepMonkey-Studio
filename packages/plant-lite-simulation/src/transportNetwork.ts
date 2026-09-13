import type { PlantTransportJourney, PlantTransportNetwork, PlantTransportReservation } from "@bim-studio/contracts";
import type { PlantLiteModel } from "./modelTypes.js";

type Segment = PlantTransportNetwork["segments"][number];
interface Vehicle { id: string; unit: number; resourceId: string; waypoint: string; availableAt: number }
interface Slot { start: number; end: number }

/** 整次行程一次性预约，等待发生在出发前，不持有部分路段，因此不会形成循环占锁。 */
export class TransportNetworkScheduler {
  private vehicles: Vehicle[];
  private reservations = new Map<string, Slot[]>();
  private pathCache = new Map<string, Segment[]>();
  constructor(private readonly network: PlantTransportNetwork, model: PlantLiteModel) {
    this.vehicles = network.fleets.flatMap(fleet => Array.from({ length: model.resources?.find(resource => resource.id === fleet.resourceId)?.capacity ?? 0 }, (_, unit) => ({
      id: `${fleet.resourceId}:${unit + 1}`, unit, resourceId: fleet.resourceId, waypoint: fleet.homeWaypointId, availableAt: 0,
    })));
  }

  reserve(resourceId: string, journey: PlantTransportJourney, now: number, failedUnits: ReadonlySet<number>): PlantTransportReservation {
    const candidates = this.vehicles.filter(vehicle => vehicle.resourceId === resourceId && vehicle.availableAt <= now + 1e-9 && !failedUnits.has(vehicle.unit));
    if (!candidates.length) throw new Error(`车队 ${resourceId} 无可派车辆`);
    const plans = candidates.map(vehicle => ({ vehicle, plan: this.plan(vehicle, journey, now) }));
    plans.sort((a, b) => a.plan.finishMinute - b.plan.finishMinute || a.vehicle.unit - b.vehicle.unit);
    const selected = plans[0]!;
    for (const leg of selected.plan.legs) {
      const segment = this.network.segments.find(item => item.id === leg.segmentId)!;
      const key = conflictKey(segment);
      const slots = this.reservations.get(key) ?? [];
      // 过去区间不再影响新派工，保持长运行内存有界。
      this.reservations.set(key, [...slots.filter(slot => slot.end > now), { start: leg.startMinute, end: leg.endMinute }].sort((a, b) => a.start - b.start));
    }
    selected.vehicle.availableAt = selected.plan.finishMinute;
    selected.vehicle.waypoint = journey.to;
    return selected.plan;
  }

  private plan(vehicle: Vehicle, journey: PlantTransportJourney, now: number): PlantTransportReservation {
    const empty = this.path(vehicle.waypoint, journey.from);
    const loaded = this.path(journey.from, journey.to);
    let offset = 0;
    const relative: PlantTransportReservation["legs"] = [];
    for (const [segments, isLoaded] of [[empty, false], [loaded, true]] as const) {
      if (isLoaded) offset += journey.loadMinutes;
      for (const segment of segments) {
        const duration = segment.lengthMeters / journey.speedMetersPerMinute;
        relative.push({ segmentId: segment.id, from: segment.from, to: segment.to, loaded: isLoaded, startMinute: offset, endMinute: offset + duration });
        offset += duration;
      }
    }
    offset += journey.unloadMinutes;
    let departure = now;
    // 每次冲突把出发时间前推到冲突区间尾端，不能退回；区间有限必然终止。
    for (let attempt = 0; attempt < 100_000; attempt += 1) {
      let nextDeparture = departure;
      for (const leg of relative) {
        const segment = this.network.segments.find(item => item.id === leg.segmentId)!;
        nextDeparture = Math.max(nextDeparture, (segment.blockedUntilMinute ?? 0) - leg.startMinute);
        for (const slot of this.reservations.get(conflictKey(segment)) ?? []) {
          if (departure + leg.startMinute < slot.end - 1e-9 && departure + leg.endMinute > slot.start + 1e-9) {
            nextDeparture = Math.max(nextDeparture, slot.end - leg.startMinute);
          }
        }
      }
      if (nextDeparture <= departure + 1e-9) return {
        vehicleId: vehicle.id, waitMinutes: departure - now, startMinute: departure, finishMinute: departure + offset,
        legs: relative.map(leg => ({ ...leg, startMinute: departure + leg.startMinute, endMinute: departure + leg.endMinute })),
      };
      departure = nextDeparture;
    }
    throw new Error("轨道预约计算达到上限，请减少路段冲突或缩短运行窗口");
  }

  private path(from: string, to: string): Segment[] {
    const key = JSON.stringify([from, to]);
    let result = this.pathCache.get(key);
    if (!result) { result = transportShortestPath(this.network, from, to); this.pathCache.set(key, result); }
    return result;
  }
}

export function transportShortestPath(network: PlantTransportNetwork, from: string, to: string): Segment[] {
  if (from === to) return [];
  const distance = new Map<string, number>([[from, 0]]);
  const previous = new Map<string, Segment>();
  const pending = new Set(network.waypoints.map(point => point.id));
  while (pending.size) {
    const current = [...pending].sort((a, b) => (distance.get(a) ?? Infinity) - (distance.get(b) ?? Infinity) || a.localeCompare(b))[0]!;
    const cost = distance.get(current);
    if (cost === undefined) break;
    pending.delete(current);
    if (current === to) {
      const path: Segment[] = [];
      let waypoint = to;
      while (waypoint !== from) { const edge = previous.get(waypoint)!; path.unshift(edge); waypoint = edge.from; }
      return path;
    }
    for (const segment of [...network.segments].sort((a, b) => a.id.localeCompare(b.id))) {
      if (segment.from !== current || !pending.has(segment.to)) continue;
      const next = cost + segment.lengthMeters;
      if (next < (distance.get(segment.to) ?? Infinity)) { distance.set(segment.to, next); previous.set(segment.to, segment); }
    }
  }
  throw new Error(`轨道不可达：${from} → ${to}`);
}

function conflictKey(segment: Segment): string { return segment.conflictZone ?? JSON.stringify([segment.from, segment.to].sort()); }
