import type { PlantLiteModel, PlantTransportJourney } from "@bim-studio/contracts";
import "./PlantTransportNetwork.css";

export function PlantTransportNetworkEditor({ model, onChange }: { model: PlantLiteModel; onChange(model: PlantLiteModel): void }) {
  const network = model.transportNetwork;
  if (!network) return null;
  function journey(id: string, patch: Partial<PlantTransportJourney>) {
    onChange({ ...model, nodes: model.nodes.map(node => node.kind === "transport" && node.id === id && node.journey ? { ...node, journey: { ...node.journey, ...patch } } : node) });
  }
  return <details className="plant-transport-editor"><summary>车辆与轨道 · {network.waypoints.length} 站点 / {network.segments.length} 有向路段</summary>
    <p>车辆保留位置，空驶取料；共享冲突区按时间窗互斥。路段预约后再出发，避免循环占锁。</p>
    {model.nodes.filter(node => node.kind === "transport" && node.journey).map(node => node.kind === "transport" && node.journey && <section key={node.id}>
      <strong>{node.name}</strong>
      {(["from", "to"] as const).map(field => <label key={field}><span>{field === "from" ? "取料点" : "交接点"}</span><select value={node.journey![field]} onChange={event => journey(node.id, { [field]: event.target.value })}>{network.waypoints.map(point => <option key={point.id} value={point.id}>{point.name}</option>)}</select></label>)}
      {(["speedMetersPerMinute", "loadMinutes", "unloadMinutes"] as const).map((field, index) => <label key={field}><span>{["速度（米/分）", "装货（分）", "卸货（分）"][index]}</span><input type="number" min={field === "speedMetersPerMinute" ? 0.1 : 0} step={0.1} value={node.journey![field]} onChange={event => { if (Number.isFinite(event.target.valueAsNumber)) journey(node.id, { [field]: event.target.valueAsNumber }); }} /></label>)}
    </section>)}
    {network.segments.map(segment => <section key={segment.id}><strong>{segment.id} · {segment.from} → {segment.to}</strong>
      <label><span>长度（米）</span><input type="number" min={0.1} step={0.1} value={segment.lengthMeters} onChange={event => { if (Number.isFinite(event.target.valueAsNumber)) onChange({ ...model, transportNetwork: { ...network, segments: network.segments.map(item => item.id === segment.id ? { ...item, lengthMeters: event.target.valueAsNumber } : item) } }); }} /></label>
      <label><span>封闭至（仿真分钟）</span><input type="number" min={0} value={segment.blockedUntilMinute ?? 0} onChange={event => { if (Number.isFinite(event.target.valueAsNumber)) onChange({ ...model, transportNetwork: { ...network, segments: network.segments.map(item => item.id === segment.id ? { ...item, blockedUntilMinute: event.target.valueAsNumber } : item) } }); }} /></label>
      <label><span>共享冲突区</span><input value={segment.conflictZone ?? ""} maxLength={120} onChange={event => { const conflictZone = event.target.value.trim(); onChange({ ...model, transportNetwork: { ...network, segments: network.segments.map(item => { if (item.id !== segment.id) return item; const { conflictZone: previous, ...rest } = item; return conflictZone ? { ...rest, conflictZone } : rest; }) } }); }} /></label>
    </section>)}
  </details>;
}
