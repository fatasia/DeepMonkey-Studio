import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { prepareRenderPacket } from "./renderPacket.js";
import { bridge, mesh, project } from "./threeBridge/testFixture.js";
import { materializeRuntimeRenderPacket } from "./runtimePackage/renderPacket.js";

describe("author per-instance shadow policy", () => {
  it.each([[false, false], [false, true], [true, false], [true, true]])("projects cast=%s receive=%s without changing author objects", (cast, receive) => {
    const author = mesh(); author.castShadow = cast; author.receiveShadow = receive;
    const packet = project(bridge(), author).packet;
    expect(packet.instances[0]!.castShadow ?? true).toBe(cast);
    expect(packet.instances[0]!.receiveShadow ?? true).toBe(receive);
    const batch = prepareRenderPacket(packet).batches[0]!;
    expect(batch.castShadow ?? true).toBe(cast);
    expect((batch.data[31]! & 16) === 0).toBe(receive);
    expect(batch.data.length).toBe(36);
    expect(author.castShadow).toBe(cast); expect(author.receiveShadow).toBe(receive);
  });
  it("keeps enabled default ABI and batch keys unchanged and updates flags without a geometry upload", () => {
    const author = mesh(); author.castShadow = true; author.receiveShadow = true;
    const target = bridge(), first = project(target, author); first.acknowledge();
    expect(first.packet.instances[0]).not.toHaveProperty("castShadow");
    expect(first.packet.instances[0]).not.toHaveProperty("receiveShadow");
    const initial = prepareRenderPacket(first.packet).batches[0]!;
    author.receiveShadow = false;
    const second = project(target, author), changed = prepareRenderPacket(second.packet).batches[0]!;
    expect(second.update).toBe("instances"); expect(changed.key).toBe(initial.key);
    expect(changed.data[31]).toBe(initial.data[31]! + 16);
  });
  it("only separates caster batches, retaining mixed receiver flags within the same draw", () => {
    const author = mesh(); author.castShadow = true; author.receiveShadow = true;
    const other = new THREE.Mesh(author.geometry, author.material); other.castShadow = true; other.receiveShadow = false;
    const nonCaster = new THREE.Mesh(author.geometry, author.material); nonCaster.castShadow = false; nonCaster.receiveShadow = true;
    const root = new THREE.Group(); root.add(author, other, nonCaster);
    const batches = prepareRenderPacket(project(bridge(), root).packet).batches;
    expect(batches).toHaveLength(2);
    expect(batches[0]!.count).toBe(2); expect(batches[0]!.data[31]).toBe(0); expect(batches[0]!.data[67]).toBe(16);
    expect(batches[1]!.castShadow).toBe(false); expect(batches[1]!.count).toBe(1);
  });
  it.each(["OPAQUE", "MASK", "BLEND"] as const)("keeps %s alpha, mirror and double-sided bits alongside receiver control", mode => {
    const author = mesh(); author.material.side = THREE.DoubleSide; author.receiveShadow = false;
    if (mode === "MASK") author.material.alphaTest = 0.5;
    if (mode === "BLEND") { author.material.transparent = true; author.material.depthWrite = false; author.material.forceSinglePass = true; }
    const batch = prepareRenderPacket(project(bridge(), author).packet).batches[0]!;
    expect(batch.alphaMode).toBe(mode);
    expect(batch.data[31]).toBe(16 + 1 + (mode === "MASK" ? 2 : mode === "BLEND" ? 4 : 0));
  });
  it("retains optional flags through runtime JSON hydration", () => {
    const packet = project(bridge(), mesh()).packet;
    const encoded = JSON.parse(JSON.stringify(packet));
    const hydrated = materializeRuntimeRenderPacket(encoded, "$.packet");
    expect(hydrated.instances[0]).toMatchObject({ castShadow: false, receiveShadow: false });
    expect(prepareRenderPacket(hydrated).batches[0]!.castShadow).toBe(false);
  });
  it.each([null, 0, "false"])("rejects non-boolean shadow metadata %s", value => {
    const packet = project(bridge(), mesh()).packet;
    const encoded = JSON.parse(JSON.stringify(packet));
    encoded.instances[0].receiveShadow = value;
    expect(() => materializeRuntimeRenderPacket(encoded, "$.packet")).toThrow("boolean");
  });
});
