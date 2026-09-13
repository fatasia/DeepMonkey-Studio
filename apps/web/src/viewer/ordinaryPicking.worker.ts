import { buildPickingIndex } from "./ordinaryPickingBuild";
import type { PickingSnapshot } from "./ordinaryPickingGeometry";

self.onmessage = (event: MessageEvent<PickingSnapshot>) => {
  try {
    const serialized = buildPickingIndex(event.data);
    const transfer: Transferable[] = [...serialized.roots];
    if (serialized.indirectBuffer) transfer.push(serialized.indirectBuffer.buffer as ArrayBuffer);
    self.postMessage({ serialized }, { transfer });
  } catch {
    self.postMessage({ error: "Picking index generation failed" });
  }
};
