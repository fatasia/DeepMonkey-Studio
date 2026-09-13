import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DEEP_PBR_MESH_V1, DEEP_PBR_MESH_V1_CANONICAL_JSON, DEEP_PBR_MESH_V1_SHA256,
  DEEP_PBR_MESH_V2, DEEP_PBR_MESH_V2_CANONICAL_JSON, DEEP_PBR_MESH_V2_SHA256,
} from "./index.js";

function frozenTree(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) frozenTree(child);
}

describe("deep.pbr.mesh.v2 CSM ABI", () => {
  it("pins separate independent fingerprints without changing v1", () => {
    expect(DEEP_PBR_MESH_V1_SHA256).toBe("cbfaa36e9f2f689684e4a9086a61f165873d2a3398b6a4633aa5b2bcb117f46c");
    expect(createHash("sha256").update(DEEP_PBR_MESH_V1_CANONICAL_JSON).digest("hex")).toBe(DEEP_PBR_MESH_V1_SHA256);
    expect(DEEP_PBR_MESH_V2_SHA256).toBe("adcdc15ed7ff02966d4033b746da1af90c97a0fb657615fec3bcef375c015cf1");
    expect(createHash("sha256").update(DEEP_PBR_MESH_V2_CANONICAL_JSON).digest("hex")).toBe(DEEP_PBR_MESH_V2_SHA256);
    expect(JSON.parse(DEEP_PBR_MESH_V2_CANONICAL_JSON)).toEqual(DEEP_PBR_MESH_V2);
    frozenTree(DEEP_PBR_MESH_V1);
    frozenTree(DEEP_PBR_MESH_V2);
  });

  it("adds exactly four matrices and five vec4 fields in 336 bytes", () => {
    expect(DEEP_PBR_MESH_V2.dataLayouts.slice(0, 3)).toEqual(DEEP_PBR_MESH_V1.dataLayouts);
    const csm = DEEP_PBR_MESH_V2.dataLayouts.find(layout => layout.id === "cascaded-shadow")!;
    expect(csm).toMatchObject({ storage: "uniform", byteSize: 336, byteAlignment: 16 });
    expect(csm.members.map(member => [member.name, member.byteOffset, member.byteSize])).toEqual([
      ["matrix0", 0, 64], ["matrix1", 64, 64], ["matrix2", 128, 64], ["matrix3", 192, 64],
      ["split_depths", 256, 16], ["blend_starts", 272, 16], ["texel_world", 288, 16],
      ["params", 304, 16], ["camera_forward", 320, 16],
    ]);
  });

  it("changes only forward depth-array and CSM bindings while preserving all pass variants", () => {
    const forward = DEEP_PBR_MESH_V2.bindGroupLayouts.find(layout => layout.id === "forward-frame")!;
    const previous = DEEP_PBR_MESH_V1.bindGroupLayouts.find(layout => layout.id === "forward-frame")!;
    expect(forward.bindings.filter(binding => ![1, 7].includes(binding.binding)))
      .toEqual(previous.bindings.filter(binding => binding.binding !== 1));
    expect(forward.bindings[1]!.resource).toEqual({ kind: "texture", sampleType: "depth", viewDimension: "2d-array", multisampled: false });
    expect(forward.bindings[7]).toEqual({ name: "cascadedShadow", binding: 7, visibility: ["fragment"],
      resource: { kind: "uniform-buffer", dataLayout: "cascaded-shadow", minBindingSize: 336 } });
    expect(DEEP_PBR_MESH_V2.bindGroupLayouts.filter(layout => layout.id !== "forward-frame"))
      .toEqual(DEEP_PBR_MESH_V1.bindGroupLayouts.filter(layout => layout.id !== "forward-frame"));
    for (const key of ["vertexStreams", "attachmentProfiles", "rasterModes", "passVariants"] as const) {
      expect(DEEP_PBR_MESH_V2[key]).toEqual(DEEP_PBR_MESH_V1[key]);
    }
  });
});
