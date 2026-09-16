import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DEEP_PBR_MESH_V1_SHA256, DEEP_PBR_MESH_V2_SHA256, DEEP_PBR_MESH_V3, DEEP_PBR_MESH_V3_SHA256,
  DEEP_PBR_MESH_V4, DEEP_PBR_MESH_V4_BYTE_SIZES, DEEP_PBR_MESH_V4_COLOR_VERTEX,
  DEEP_PBR_MESH_V4_CANONICAL_JSON, DEEP_PBR_MESH_V4_SHA256,
} from "./index.js";

describe("deep.pbr.mesh.v4 optional vertex-color stream", () => {
  it("adds a separate frozen revision and preserves v1/v2/v3 goldens", () => {
    expect(DEEP_PBR_MESH_V1_SHA256).toBe("cbfaa36e9f2f689684e4a9086a61f165873d2a3398b6a4633aa5b2bcb117f46c");
    expect(DEEP_PBR_MESH_V2_SHA256).toBe("adcdc15ed7ff02966d4033b746da1af90c97a0fb657615fec3bcef375c015cf1");
    expect(DEEP_PBR_MESH_V3_SHA256).toBe("4f6183fcd7f4303163e2de6814292dbc28f5e97d94545c6dae58d953aa343c2c");
    expect(createHash("sha256").update(DEEP_PBR_MESH_V4_CANONICAL_JSON).digest("hex")).toBe(DEEP_PBR_MESH_V4_SHA256);
    expect(JSON.parse(DEEP_PBR_MESH_V4_CANONICAL_JSON)).toEqual(DEEP_PBR_MESH_V4);
    expect(Object.isFrozen(DEEP_PBR_MESH_V4.vertexStreams)).toBe(true);
  });

  it("appends exactly one color stream and keeps every other frozen section untouched", () => {
    expect(DEEP_PBR_MESH_V4.id).toBe("deep.pbr.mesh.v4");
    expect(DEEP_PBR_MESH_V4.vertexStreams.map(stream => stream.id)).toEqual(["geometry", "instance", "tangent", "color"]);
    expect(DEEP_PBR_MESH_V4.vertexStreams.at(-1)).toEqual({
      id: "color", slot: 3, arrayStride: DEEP_PBR_MESH_V4_BYTE_SIZES.colorVertex, stepMode: "vertex",
      attributes: [{ semantic: "COLOR_RGBA_F32_LINEAR", shaderLocation: 16, format: "float32x4", byteOffset: 0 }],
    });
    expect(DEEP_PBR_MESH_V4_COLOR_VERTEX).toEqual({ stream: "color", semantic: "COLOR_RGBA_F32_LINEAR",
      shaderLocation: 16, format: "float32x4", byteOffset: 0, arrayStride: 16 });
    // 其余章节与 v3 逐项相同：颜色变体的管线接入必须走新的修订，不能复用 v4 静默改语义。
    expect(DEEP_PBR_MESH_V4.passVariants).toEqual(DEEP_PBR_MESH_V3.passVariants);
    expect(DEEP_PBR_MESH_V4.materialModes).toEqual(DEEP_PBR_MESH_V3.materialModes);
    expect(DEEP_PBR_MESH_V4.dataLayouts).toEqual(DEEP_PBR_MESH_V3.dataLayouts);
    expect(DEEP_PBR_MESH_V4.bindGroupLayouts).toEqual(DEEP_PBR_MESH_V3.bindGroupLayouts);
    expect(DEEP_PBR_MESH_V4.attachmentProfiles).toEqual(DEEP_PBR_MESH_V3.attachmentProfiles);
    expect(DEEP_PBR_MESH_V4.alphaModes).toEqual(DEEP_PBR_MESH_V3.alphaModes);
    expect(DEEP_PBR_MESH_V4.rasterModes).toEqual(DEEP_PBR_MESH_V3.rasterModes);
  });
});
