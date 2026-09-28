import type { RenderPacket } from "../renderPacket.js";

/** Keep author identity outside the frame-local GPU visibility slots. */
export function indexObjectBindings(packet: Pick<RenderPacket, "objectBindings">): Map<string, string> {
  const byInstance = new Map<string, string>();
  for (const binding of packet.objectBindings ?? []) {
    for (const instanceId of binding.instanceIds) {
      // Match the former linear lookup when a malformed in-memory packet repeats an id.
      if (!byInstance.has(instanceId)) byInstance.set(instanceId, binding.nodeId);
    }
  }
  return byInstance;
}
