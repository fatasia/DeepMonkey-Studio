import type { PlantLiteModel, PlantLiteTraceEvent } from "@bim-studio/contracts";

type ItemEvent = Extract<PlantLiteTraceEvent, { itemId: string }>;
export interface PlantLiteTransportInterval {
  toNodeId: string;
  startMinute: number;
  endMinute: number;
}

/** 只使用同一物料已记录的搬运完成与后继入站；分流不猜第一条边，截断不补造行程。 */
export function indexPlantLiteTransport(timelines: Map<string, ItemEvent[]>, model: PlantLiteModel) {
  const intervals = new Map<number, PlantLiteTransportInterval>();
  const transports = new Set(model.nodes.filter(node => node.kind === "transport").map(node => node.id));
  const edges = new Set(model.edges.map(edge => JSON.stringify([edge.from, edge.to])));
  for (const timeline of timelines.values()) {
    let nextEnter: ItemEvent | undefined;
    const completed = new Map<string, { event: ItemEvent; destination: string }>();
    for (let index = timeline.length - 1; index >= 0; index -= 1) {
      const event = timeline[index]!;
      if (event.type === "item-enter") nextEnter = event;
      if (!transports.has(event.nodeId)) continue;
      if (event.type === "item-complete" && nextEnter && edges.has(JSON.stringify([event.nodeId, nextEnter.nodeId]))) {
        completed.set(event.nodeId, { event, destination: nextEnter.nodeId });
      } else if (event.type === "item-start") {
        const target = completed.get(event.nodeId);
        completed.delete(event.nodeId);
        if (!target || target.event.atMinute <= event.atMinute) continue;
        const loadedLegs = event.transport?.legs.filter(leg => leg.loaded);
        const interval = { toNodeId: target.destination, startMinute: loadedLegs?.[0]?.startMinute ?? event.atMinute, endMinute: loadedLegs?.at(-1)?.endMinute ?? target.event.atMinute };
        intervals.set(event.sequence, interval);
        intervals.set(target.event.sequence, interval);
      }
    }
  }
  return intervals;
}
