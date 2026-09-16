import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DEEP_PBR_MESH_V1_SHA256, DEEP_PBR_MESH_V2_SHA256, DEEP_PBR_MESH_V3,
  DEEP_PBR_MESH_V3_CANONICAL_JSON, DEEP_PBR_MESH_V3_OBJECT_ID_SEMANTICS, DEEP_PBR_MESH_V3_SHA256,
} from "./index.js";

describe("deep.pbr.mesh.v3 auxiliary pass ABI", () => {
  it("adds a separate frozen revision and preserves both old goldens", () => {
    expect(DEEP_PBR_MESH_V1_SHA256).toBe("cbfaa36e9f2f689684e4a9086a61f165873d2a3398b6a4633aa5b2bcb117f46c");
    expect(DEEP_PBR_MESH_V2_SHA256).toBe("adcdc15ed7ff02966d4033b746da1af90c97a0fb657615fec3bcef375c015cf1");
    expect(createHash("sha256").update(DEEP_PBR_MESH_V3_CANONICAL_JSON).digest("hex"))
      .toBe(DEEP_PBR_MESH_V3_SHA256);
    expect(JSON.parse(DEEP_PBR_MESH_V3_CANONICAL_JSON)).toEqual(DEEP_PBR_MESH_V3);
    expect(Object.isFrozen(DEEP_PBR_MESH_V3.passVariants)).toBe(true);
  });

  it("pins depth and picking attachments, layouts, and MASK variants", () => {
    expect(DEEP_PBR_MESH_V3.dataLayouts.find((entry) => entry.id === "instance"))
      .toMatchObject({ byteSize: 160, members: expect.arrayContaining([
        { name: "objectId", format: "vec4<f32>", byteOffset: 144, byteSize: 16 },
      ]) });
    expect(DEEP_PBR_MESH_V3.vertexStreams.find((entry) => entry.id === "instance"))
      .toMatchObject({ arrayStride: 160, attributes: expect.arrayContaining([
        { semantic: "OBJECT_ID_RGBA8", shaderLocation: 14, format: "float32x4", byteOffset: 144 },
      ]) });
    expect(DEEP_PBR_MESH_V3_OBJECT_ID_SEMANTICS).toEqual({ member: "objectId",
      semantic: "OBJECT_ID_RGBA8", byteOffset: 144, encoding: "rgba8-unorm", background: [0, 0, 0, 0] });
    expect(DEEP_PBR_MESH_V3.bindGroupLayouts.find((entry) => entry.id === "view-frame"))
      .toEqual({ id: "view-frame", group: 0, bindings: [{ name: "frame", binding: 0,
        visibility: ["vertex"], resource: { kind: "uniform-buffer", dataLayout: "frame", minBindingSize: 208 } }] });
    expect(DEEP_PBR_MESH_V3.attachmentProfiles.slice(-2)).toEqual([
      expect.objectContaining({ id: "depth", pass: "depth", sampleCount: 1, resolve: "none", colorAttachments: [] }),
      expect.objectContaining({ id: "picking", pass: "picking", sampleCount: 1, resolve: "none",
        colorAttachments: [{ format: "rgba16float", writeMask: "all", blend: null }] }),
    ]);
    expect(DEEP_PBR_MESH_V3.passVariants.slice(-6).map((entry) => [entry.id, entry.pass])).toEqual([
      ["depth-solid", "depth"], ["depth-mask-plain", "depth"], ["depth-mask-material", "depth"],
      ["picking-solid", "picking"], ["picking-mask-plain", "picking"], ["picking-mask-material", "picking"],
    ]);
    expect(DEEP_PBR_MESH_V3.passVariants.find((entry) => entry.id === "depth-mask-material"))
      .toMatchObject({ bindGroupLayouts: ["view-frame", "material"], alphaModes: ["MASK"] });
    expect(DEEP_PBR_MESH_V3.passVariants.find((entry) => entry.id === "picking-mask-material"))
      .toMatchObject({ bindGroupLayouts: ["view-frame", "material"], alphaModes: ["MASK"] });
  });
});
