import { describe, expect, it, vi } from "vitest";
import type { PacketResidencyTicket } from "./packetResidencyDomain.js";
import type { PacketResidencySetProjection } from "./packetResidencySet.js";
import type { ResidentPacketProjection } from "./residentPacketProjection.js";
import { createResidentSceneChunkFrame } from "./sceneChunkResidencyFrame.js";

function projection(release: () => void): ResidentPacketProjection {
  return { batches: [], released: false, geometry: () => undefined, geometrySource: () => undefined,
    texture: () => undefined, textureSource: () => undefined, release };
}
function ticket(): PacketResidencyTicket {
  return Object.freeze({ requests: [] }) as unknown as PacketResidencyTicket;
}

describe("createResidentSceneChunkFrame", () => {
  it("releases every acquired projection and aggregates cleanup errors if an internal binding is absent", () => {
    const firstRelease = vi.fn(), cleanupFailure = new Error("cleanup failed");
    const secondRelease = vi.fn(() => { throw cleanupFailure; });
    const first = ticket(), missing = ticket();
    const values = [
      { ticket: first, projection: projection(firstRelease) },
      { ticket: missing, projection: projection(secondRelease) },
    ] as readonly PacketResidencySetProjection[];

    let thrown: unknown;
    try { createResidentSceneChunkFrame(1, values, new Map([[first, "known"]])); }
    catch (error) { thrown = error; }

    expect(firstRelease).toHaveBeenCalledOnce(); expect(secondRelease).toHaveBeenCalledOnce();
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([
      expect.objectContaining({ message: "Scene residency projection has no chunk binding." }),
      cleanupFailure,
    ]);
  });
});
