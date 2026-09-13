import { describe, expect, it, vi } from "vitest";
import { WebIO } from "@gltf-transform/core";
import { createParametricGlb, downloadParametricGlb, safeParametricName } from "./parametricGlb";
import type { ParametricCadBuildResult } from "./parametricCadTypes";

describe("parametric scene asset", () => {
  it("round-trips real GLB geometry with millimetres/Z-up converted to metres/Y-up", async () => {
    const result = { vertices: new Float32Array([0, 0, 0, 1000, 0, 0, 0, 2000, 3000]), normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), triangles: new Uint32Array([0, 1, 2]) } as ParametricCadBuildResult;
    const binary = await createParametricGlb(result, "plate");
    const document = await new WebIO().readBinary(new Uint8Array(binary));
    const primitive = document.getRoot().listMeshes()[0]!.listPrimitives()[0]!;
    expect(Array.from(primitive.getAttribute("POSITION")!.getArray()!)).toEqual([0, 0, -0, 1, 0, -0, 0, 3, -2]);
    expect(Array.from(primitive.getAttribute("NORMAL")!.getArray()!)).toEqual([0, 1, -0, 0, 1, -0, 0, 1, -0]);
    expect(Array.from(primitive.getIndices()!.getArray()!)).toEqual([0, 1, 2]);
    expect(document.getRoot().listNodes()[0]!.getName()).toBe("plate");
    expect(result.vertices[3]).toBe(1000);
  });
  it("cleans exported filenames", () => {
    expect(safeParametricName(' a/b:*?"<>| ')).toBe("a-b-------");
    expect(safeParametricName(" ")).toBe("参数化模型");
  });

  it("creates a browser download from the generated GLB binary", () => {
    const anchor = { href: "", download: "", click: vi.fn() };
    const createObjectURL = vi.fn((blob: Blob) => {
      expect(blob).toHaveProperty("type", "model/gltf-binary");
      return "blob:parametric-glb";
    });
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("document", { createElement: () => anchor });
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    vi.stubGlobal("window", { setTimeout: vi.fn() });
    try {
      downloadParametricGlb(new ArrayBuffer(8), "安装板 / v1");
      expect(anchor.click).toHaveBeenCalledOnce();
      expect(anchor.download).toBe("安装板 - v1.glb");
      expect(anchor.href).toBe("blob:parametric-glb");
      expect(createObjectURL).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
