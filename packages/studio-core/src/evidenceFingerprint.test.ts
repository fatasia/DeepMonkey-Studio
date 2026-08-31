import { describe, expect, it } from "vitest";
import { createEvidenceFingerprint } from "./evidenceFingerprint.js";

describe("evidence fingerprint", () => {
  it("is stable across object key ordering and sensitive to evidence changes", () => {
    const first = createEvidenceFingerprint({ asset: { id: "pump-1", score: 0.8 }, evidence: ["pressure", "vibration"] });
    const reordered = createEvidenceFingerprint({ evidence: ["pressure", "vibration"], asset: { score: 0.8, id: "pump-1" } });
    const changed = createEvidenceFingerprint({ asset: { id: "pump-1", score: 0.7 }, evidence: ["pressure", "vibration"] });

    expect(first).toBe(reordered);
    expect(first).toMatch(/^fnv1a64-canonical-v1:[a-f0-9]{16}$/);
    expect(changed).not.toBe(first);
  });
});
