import { describe, expect, it } from "vitest";
import { compilePbrFrameGraph } from "./pbrFrameGraph.js";

describe("production PBR frame graph", () => {
  it("orders every core GPU-driven and visual stage in one valid frame", () => {
    const result = compilePbrFrameGraph({ transparency: true });
    expect(result.valid, result.issues.map(issue => issue.message).join("\n")).toBe(true);
    expect(result.order).toEqual([
      "deform",
      "visibility",
      "shadows",
      "cluster-lights",
      "opaque",
      "build-hiz",
      "publish-hiz",
      "ambient-occlusion",
      "apply-ambient-occlusion",
      "transparent-oit",
      "composite-oit",
      "temporal-aa",
      "bloom",
      "present",
    ]);
    const resources = new Map(result.resources.map(resource => [resource.id, resource]));
    expect(resources.get("previous-hiz")?.external).toBe(true);
    expect(resources.get("next-hiz")?.external).toBe(true);
    expect(resources.get("opaque-hdr")?.transientSlot).toBe(resources.get("bloom-hdr")?.transientSlot);
    expect(resources.get("ao-hdr")?.transientSlot).toBe(resources.get("temporal-hdr")?.transientSlot);
    expect(resources.get("ao-hdr")?.transientSlot).not.toBe(resources.get("opaque-hdr")?.transientSlot);
  });

  it("removes only transparency work when a scene has no blend materials", () => {
    const result = compilePbrFrameGraph({ transparency: false });
    expect(result.valid).toBe(true);
    expect(result.order).not.toContain("transparent-oit");
    expect(result.order).not.toContain("composite-oit");
    expect(result.order.slice(-3)).toEqual(["temporal-aa", "bloom", "present"]);
    expect(result.resources.some(resource => resource.id.startsWith("oit-"))).toBe(false);
  });

  it("inserts opt-in volumetric fog after transparency and before temporal effects", () => {
    const result = compilePbrFrameGraph({ transparency: true, features: { volumetricFog: true } });
    expect(result.valid).toBe(true);
    const fogMarch = result.order.indexOf("volumetric-fog-march");
    const fogComposite = result.order.indexOf("volumetric-fog-composite");
    expect(fogMarch).toBeGreaterThan(result.order.indexOf("composite-oit"));
    expect(fogComposite).toBe(fogMarch + 1);
    expect(result.order.indexOf("temporal-aa")).toBeGreaterThan(fogComposite);
    expect(result.resources.find(resource => resource.id === "volumetric-fog-scatter")?.descriptor).toBe("rgba16float-half");
  });
});
