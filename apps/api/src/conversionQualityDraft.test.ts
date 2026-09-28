import { describe, expect, it } from "vitest";
import type { ConversionQualityDraft, PhysicsReadinessDeclaration } from "@bim-studio/contracts";
import { withPhysicsReadiness } from "./conversionQualityDraft.js";

const draft = (): ConversionQualityDraft => ({
  schemaVersion: 1,
  profileId: "test-v1",
  tier: "visual-complete",
  checks: [],
  losses: [],
  approximations: [],
});

const ready: PhysicsReadinessDeclaration = {
  tier: "physics-ready",
  colliderEvidence: { evidenceId: "physics:colliders", strategy: "convex-hull", evidenceSha256: "c".repeat(64) },
};

describe("withPhysicsReadiness", () => {
  it("无判定（null/undefined）时原样返回，不虚构物理能力", () => {
    for (const declaration of [null, undefined]) {
      const value = withPhysicsReadiness(draft(), declaration);
      expect(value.physicsReadiness).toBeUndefined();
      expect(value).not.toHaveProperty("physicsReadiness");
    }
  });

  it("有判定时叠加 physicsReadiness，其余字段不被改动", () => {
    const base = draft();
    const value = withPhysicsReadiness(base, ready);
    expect(value.physicsReadiness).toEqual(ready);
    expect(value.profileId).toBe(base.profileId);
    expect(value.tier).toBe(base.tier);
    // 原草稿不被原地修改。
    expect(base.physicsReadiness).toBeUndefined();
  });

  it("geometry-only 判定同样可叠加（保守结论进质量报告）", () => {
    const geometryOnly: PhysicsReadinessDeclaration = { tier: "geometry-only", reason: "no collider derivatives" };
    const value = withPhysicsReadiness(draft(), geometryOnly);
    expect(value.physicsReadiness).toEqual(geometryOnly);
  });
});
