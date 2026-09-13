import { useMemo } from "react";
import type { PlantLiteModel, PlantLiteReplicationTrace } from "@bim-studio/contracts";
import { prepareTransportTrips, transportFleetFrame } from "./plantTransportPlayback";
import "./PlantTransportNetwork.css";

export function PlantTransportNetworkView({ model, trace, minute }: { model: PlantLiteModel; trace: PlantLiteReplicationTrace; minute: number }) {
  const trips = useMemo(() => prepareTransportTrips(trace), [trace]);
  const fleet = useMemo(() => transportFleetFrame(model, trips, minute), [model, trips, minute]);
  const network = model.transportNetwork;
  if (!network) return null;
  const xs = network.waypoints.map(point => point.position[0]), zs = network.waypoints.map(point => point.position[2]);
  const minX = Math.min(...xs), minZ = Math.min(...zs), width = Math.max(1, Math.max(...xs) - minX), depth = Math.max(1, Math.max(...zs) - minZ);
  const point = (position: readonly number[]) => [60 + ((position[0] ?? 0) - minX) / width * 600, 55 + ((position[2] ?? 0) - minZ) / depth * 130];
  return <section className="plant-transport-network" aria-label="多车轨道回放">
    <header><strong>车辆与共享轨道</strong><span>{fleet.length} 台 · {trips.length} 次已记录调度 · 累计让行 {trips.reduce((sum, item) => sum + item.trip.waitMinutes, 0).toFixed(2)} 分</span></header>
    <svg viewBox="0 0 720 250" role="img" aria-label="车辆按实际预约时间沿轨道连续移动">
      {network.segments.map(segment => {
        const from = network.waypoints.find(item => item.id === segment.from), to = network.waypoints.find(item => item.id === segment.to);
        if (!from || !to) return null;
        const [x1, y1] = point(from.position), [x2, y2] = point(to.position);
        return <line key={segment.id} x1={x1} y1={y1} x2={x2} y2={y2} className={minute < (segment.blockedUntilMinute ?? 0) ? "blocked" : "track"}><title>{segment.id} · {segment.lengthMeters} 米 · {segment.conflictZone ?? "对向互斥"}</title></line>;
      })}
      {network.waypoints.map(waypoint => { const [x, y] = point(waypoint.position); return <g key={waypoint.id}><circle cx={x} cy={y} r={7} className="waypoint" /><text x={x} y={y! + 28} textAnchor="middle">{waypoint.name}</text></g>; })}
      {fleet.filter(vehicle => vehicle.position).map((vehicle, index) => { const [x, y] = point(vehicle.position!); return <g key={vehicle.id} transform={`translate(${x},${y! - 12 - (index % 3) * 17})`} className={vehicle.state === "让行" ? "vehicle waiting" : "vehicle"}><title>{vehicle.id} · {vehicle.state}{vehicle.itemId ? ` · ${vehicle.itemId}` : ""}</title><rect x={-12} y={-9} width={24} height={18} rx={4} /><text textAnchor="middle" y={4}>{vehicle.label}</text></g>; })}
    </svg>
    <div className="plant-transport-vehicle-list">{fleet.map(vehicle => <span key={vehicle.id} title={vehicle.itemId}><b>{vehicle.id}</b>{vehicle.state}</span>)}</div>
    {trace.truncated && <p>轨迹已截断，车辆状态仅表示已记录时段。</p>}
  </section>;
}
