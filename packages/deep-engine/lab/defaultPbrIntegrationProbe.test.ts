import { describe, expect, it } from "vitest";
import { integrationLodPacket, integrationPacket } from "./defaultPbrIntegrationProbe.js";
import { prepareRenderPacket } from "@bim-studio/deep-engine";

describe("default PBR integration packet", () => {
  it("creates two 128-instance batches for the real Hi-Z and OIT thresholds", () => {
    const packet = integrationPacket();
    expect(packet.instances).toHaveLength(256);
    expect(packet.instances.filter(instance => instance.material === "opaque")).toHaveLength(128);
    expect(packet.instances.filter(instance => instance.material === "blend")).toHaveLength(128);
    expect(packet.materials.find(material => material.id === "blend")?.alphaMode).toBe("BLEND");
  });

  it("builds one validated multi-geometry LOD batch with a nonresident middle level", () => {
    const prepared = prepareRenderPacket(integrationLodPacket());
    expect(prepared.batches).toHaveLength(1);
    expect(prepared.batches[0]!.count).toBe(64);
    expect(prepared.batches[0]!.lod?.levels.map(level => [level.triangles, level.resident]))
      .toEqual([[168, true], [64, false], [16, true]]);
  });
});
