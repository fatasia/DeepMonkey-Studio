import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { prepareRenderPacket } from "./renderPacket.js";
import { bridge, mesh, project } from "./threeBridge/testFixture.js";
import { materializeRuntimeRenderPacket } from "./runtimePackage/renderPacket.js";

describe("per-material scene fog", () => {
  it("preserves default flags and detects author fog edits as instance updates", () => {
    const author = mesh(), target = bridge(); author.receiveShadow = true;
    const first = project(target, author); first.acknowledge();
    expect(first.packet.materials[0]).not.toHaveProperty("fog");
    const before = prepareRenderPacket(first.packet).batches[0]!;
    author.material.fog = false;
    const next = project(target, author), after = prepareRenderPacket(next.packet).batches[0]!;
    expect(next.update).toBe("instances");
    expect(next.packet.materials[0]!.fog).toBe(false);
    expect(after.key).toBe(before.key);
    expect(after.data.length).toBe(36);
    expect(after.data[31]).toBe(before.data[31]! + 32);
    expect(author.material.fog).toBe(false);
  });

  it.each(["OPAQUE", "MASK", "BLEND"] as const)("keeps %s alpha, double-sided and receive flags distinct", mode => {
    const author = mesh(); author.material.fog = false; author.material.side = THREE.DoubleSide;
    if (mode === "MASK") author.material.alphaTest = 0.3;
    if (mode === "BLEND") Object.assign(author.material, { transparent: true, depthWrite: false, forceSinglePass: true });
    const batch = prepareRenderPacket(project(bridge(), author).packet).batches[0]!;
    expect(batch.data[31]).toBe(32 + 16 + 1 + (mode === "MASK" ? 2 : mode === "BLEND" ? 4 : 0));
  });

  it("retains mixed fog materials in one draw with independent packed flags", () => {
    const author = mesh(); author.receiveShadow = true;
    const second = new THREE.Mesh(author.geometry, author.material.clone());
    second.receiveShadow = true; second.material.fog = false;
    const root = new THREE.Group(); root.add(author, second);
    const batches = prepareRenderPacket(project(bridge(), root).packet).batches;
    expect(batches).toHaveLength(1);
    expect([batches[0]!.data[31], batches[0]!.data[67]]).toEqual([0, 32]);
  });

  it.each([true, false])("retains explicit fog=%s during export and hydration", fog => {
    const packet = project(bridge(), mesh()).packet;
    const source = { ...packet, materials: [{ ...packet.materials[0]!, fog }] };
    const hydrated = materializeRuntimeRenderPacket(JSON.parse(JSON.stringify(source)), "$.packet");
    expect(hydrated.materials[0]!.fog).toBe(fog);
    expect(prepareRenderPacket(hydrated).batches[0]!.data[31]! & 32).toBe(fog ? 0 : 32);
  });

  it.each([null, 0, "false"])("rejects malformed fog=%s in packet and author state", fog => {
    const author = mesh(), packet = project(bridge(), author).packet;
    expect(() => prepareRenderPacket({ ...packet, materials: [{ ...packet.materials[0]!, fog: fog as boolean }] }))
      .toThrow("fog must be boolean");
    Object.assign(author.material, { fog });
    expect(bridge().project(author, { cameraLayerMask: 1 }).ok).toBe(false);
  });
});
