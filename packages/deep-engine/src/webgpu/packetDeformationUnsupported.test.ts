import { expect, it, vi } from "vitest";
import { stagePacketBuffers } from "./packetBufferStaging.js";
import { updatePacketInstances } from "./packetInstanceUpdate.js";
import { createResidentPacketProjection } from "./residentPacketProjection.js";
import type { PreparedPacket } from "../renderPacket.js";

it("does not silently discard deformation in the not-yet-wired static staging path", () => {
  const packet: PreparedPacket = { geometries: new Map(), textures: [], batches: [], deformation: { sources: [], poses: [] } };
  expect(() => stagePacketBuffers(undefined as never, packet)).toThrow("not enabled");
  const acquire = vi.fn();
  expect(() => createResidentPacketProjection(packet, acquire)).toThrow("not enabled");
  expect(acquire).not.toHaveBeenCalled();
});

it("rejects dynamic pose updates before touching static buffers", () => {
  expect(() => updatePacketInstances(undefined as never, { materials: [], instances: [], poses: [] })).toThrow("not enabled");
  expect(() => updatePacketInstances(undefined as never, { materials: [], instances: [
    { id: "i", geometry: "g", material: "m", transform: [], pose: "p" },
  ] })).toThrow("not enabled");
});
