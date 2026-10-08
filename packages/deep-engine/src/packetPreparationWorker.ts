import { buildPacketPreparationWork, preparationTransferables } from "./packetPreparationWork.js";
import type { RenderPacket } from "./renderPacket.js";
import type { MaterialInstanceOptions } from "./materialInstanceAbi.js";

type Input = { packet: RenderPacket; options: MaterialInstanceOptions; skinInputs: boolean };
const worker = globalThis as unknown as { onmessage: ((event: { data: Input }) => void) | null;
  postMessage(value: unknown, transfer?: ArrayBuffer[]): void };
worker.onmessage = (event: { data: Input }) => {
  try {
    const work = buildPacketPreparationWork(event.data.packet, event.data.options, event.data.skinInputs);
    worker.postMessage({ work }, preparationTransferables(work));
  } catch (error) {
    worker.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
