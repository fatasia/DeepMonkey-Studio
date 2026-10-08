import { describe, expect, it } from "vitest";
import { prepareRenderPacket } from "../renderPacket.js";
import { decodeDeformablePacketGlb } from "./decodeDeformablePacketGlb.js";
import { initialPoseFixture } from "./initialPoseFixture.testSupport.js";
import type { GltfImageDecoder } from "./textureTypes.js";

const imageDecoder: GltfImageDecoder = { decode: async () => ({ width: 1, height: 1, data: new Uint8Array([100, 150, 200, 255]) }) };
const options = { resourcePrefix: "pose", advancedMaterials: true, preserveTexCoords: true } as const;

describe("initial static glTF pose", () => {
  it("bakes initial morph, inverse bind and nonidentity joint world instead of animation clip zero", async () => {
    const { packet, mode } = await decodeDeformablePacketGlb(initialPoseFixture(), imageDecoder, options);
    expect(mode).toBe("bind-pose"); expect(packet.deformation).toBeUndefined();
    const instance = packet.instances[0]!, geometry = packet.geometries[0]!;
    expect(instance.pose).toBeUndefined(); expect(instance.transform[12]).toBe(-23.5);
    // world = root(1) + joint(10) + jointScale(2) * (morphedPosition(.2) - inverseBind(1)).
    expect(geometry.vertices[0]! + instance.transform[12]!).toBeCloseTo(9.4, 5);
    expect(geometry.vertices[6]! + instance.transform[12]!).toBeCloseTo(11.4, 5);
    // Inverse transpose of joint scale(2,1,1), then normalized: (1/sqrt5,2/sqrt5,0).
    expect(geometry.vertices[3]).toBeCloseTo(1 / Math.sqrt(5));
    expect(geometry.vertices[4]).toBeCloseTo(2 / Math.sqrt(5));
    expect(Array.from(geometry.tangents!.slice(0, 4))).toEqual([0, 0, 1, 1]);
    expect(() => prepareRenderPacket(packet)).not.toThrow();
  });

  it("keeps shared skin primitives independent across node transforms and initial morph weights", async () => {
    const { packet } = await decodeDeformablePacketGlb(initialPoseFixture({ secondInstance: true }), imageDecoder, options);
    expect(packet.geometries).toHaveLength(2);
    expect(packet.instances[0]!.geometry).not.toBe(packet.instances[1]!.geometry);
    const worldX = packet.instances.map(instance => packet.geometries.find(g => g.id === instance.geometry)!.vertices[0]!
      + instance.transform[12]!);
    expect(worldX[0]).toBeCloseTo(9.4, 5); expect(worldX[1]).toBeCloseTo(10.6, 5);
    expect(() => prepareRenderPacket(packet)).not.toThrow();
  });

  it("bakes morph-only assets without applying joint transforms", async () => {
    const { packet } = await decodeDeformablePacketGlb(initialPoseFixture({ morphOnly: true }), imageDecoder, options);
    expect(packet.geometries[0]!.vertices[0]).toBeCloseTo(0.2);
    expect(packet.instances[0]!.transform[12]).toBe(-23.5);
  });

  it("preserves indices, UV sets, exact pixels and physical material slots", async () => {
    const bytes = initialPoseFixture();
    const live = await decodeDeformablePacketGlb(bytes, imageDecoder, { ...options, liveDeformation: true });
    const baked = await decodeDeformablePacketGlb(bytes, imageDecoder, options);
    expect(baked.packet.materials).toEqual(live.packet.materials);
    expect(baked.packet.textures).toEqual(live.packet.textures);
    const material = baked.packet.materials[0]!;
    expect(material.specularFactor).toBeCloseTo(0.4); expect(material.specularTexture?.texCoord).toBe(1);
    expect(material.specularColorTexture).toBeDefined(); expect(material.extendedParameters?.transmission.factor).toBe(1);
    const geometry = baked.packet.geometries[0]!, source = live.packet.geometries[0]!;
    expect(geometry.indices).toEqual(source.indices); expect(geometry.uv0).toEqual(source.uv0);
    expect(geometry.uv1).toEqual(source.uv1);
  });

  it("keeps the bounded deformation budget and cancellation", async () => {
    await expect(decodeDeformablePacketGlb(initialPoseFixture(), imageDecoder, { ...options, maxDeformationBytes: 1000 }))
      .rejects.toMatchObject({ code: "limit" });
    const controller = new AbortController(); controller.abort();
    await expect(decodeDeformablePacketGlb(initialPoseFixture(), imageDecoder, { ...options, signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
  });
});
