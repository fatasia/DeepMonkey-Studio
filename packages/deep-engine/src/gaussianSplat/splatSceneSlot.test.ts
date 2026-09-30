import { describe, expect, it } from "vitest";
import { SPLAT_SLOT_BLEND_CONTRACT, SPLAT_RENDER_SLOT_KIND,
  assertValidSplatSceneSlotPlan,
  buildSplatSceneSlotPlan,
  validateSplatSceneSlotCoexistence } from "./splatSceneSlot.js";
import type { SceneSlot } from "./splatSceneSlot.js";

describe("splatSceneSlot (coexistence with the opaque mesh pipeline)", () => {
  it("places the splat pass after every opaque mesh pass, even with no mesh passes", () => {
    const plan = buildSplatSceneSlotPlan(["mesh:static", "mesh:instanced", "mesh:lod"]);
    expect(plan.slots.map((slot) => slot.kind)).toEqual([
      "mesh-opaque", "mesh-opaque", "mesh-opaque", SPLAT_RENDER_SLOT_KIND,
    ]);
    expect(plan.splatSlotIndex).toBe(3);

    const bare = buildSplatSceneSlotPlan([]);
    expect(bare.slots).toHaveLength(1);
    expect(bare.slots[0]!.kind).toBe(SPLAT_RENDER_SLOT_KIND);
    expect(() => assertValidSplatSceneSlotPlan(bare)).not.toThrow();
  });

  it("rejects duplicate splat slots and mesh passes that land after the splat pass", () => {
    const duplicated: SceneSlot[] = [
      { kind: "mesh-opaque", id: "mesh:a" },
      { kind: SPLAT_RENDER_SLOT_KIND, id: "splat:1" },
      { kind: SPLAT_RENDER_SLOT_KIND, id: "splat:2" },
    ];
    expect(() => validateSplatSceneSlotCoexistence(duplicated))
      .toThrow(/single sorted pass/u);

    const afterSplat: SceneSlot[] = [
      { kind: SPLAT_RENDER_SLOT_KIND, id: "splat:1" },
      { kind: "mesh-opaque", id: "mesh:b" },
    ];
    expect(() => validateSplatSceneSlotCoexistence(afterSplat))
      .toThrow(/after the gaussian-splat slot/u);
  });

  it("rejects duplicate pass ids regardless of kind", () => {
    const slots: SceneSlot[] = [
      { kind: "mesh-opaque", id: "mesh:a" },
      { kind: "mesh-opaque", id: "mesh:a" },
    ];
    expect(() => validateSplatSceneSlotCoexistence(slots)).toThrow(/duplicated/u);
  });

  it("freezes the blend contract (depth write off, depth test on, premultiplied alpha, far-to-near)", () => {
    expect(SPLAT_SLOT_BLEND_CONTRACT).toEqual({
      colorBlend: "premultiplied-alpha",
      depthCompare: "less",
      depthWriteEnabled: false,
      drawOrder: "far-to-near",
    });
  });
});
