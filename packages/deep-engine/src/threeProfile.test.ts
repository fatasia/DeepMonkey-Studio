import { describe, expect, it } from "vitest";
import {
  THREE_COMPAT_PROFILE_SCHEMA_VERSION,
  validateThreeCompatibilityProfile,
  type ThreeCompatibilityProfile,
} from "./threeProfile.js";

const profile: ThreeCompatibilityProfile = {
  schemaVersion: THREE_COMPAT_PROFILE_SCHEMA_VERSION,
  threeVersion: "0.185.1",
  classes: [
    {
      name: "Mesh",
      level: "project",
      semantics: ["constructor", "position", "visible", "material"],
      rawGraphOperations: ["add", "remove", "traverse"],
      evidence: [{ source: "source", id: "apps/web/src/viewer", usageCount: 12 }],
    },
  ],
};

describe("validateThreeCompatibilityProfile", () => {
  it.each([null, undefined, [], {}, { ...profile, classes: [] }, { ...profile, classes: [null] },
    { ...profile, classes: [{ ...profile.classes[0], rawGraphOperations: 42 }] },
    { ...profile, classes: [{ ...profile.classes[0], evidence: [null] }] },
  ])("reports malformed JSON without throwing: %j", (value) => {
    expect(validateThreeCompatibilityProfile(value).valid).toBe(false);
  });
  it("accepts a project-scoped contract", () => {
    expect(validateThreeCompatibilityProfile(profile)).toEqual({ valid: true, issues: [] });
  });

  it("rejects invalid versions and class names deterministically", () => {
    const result = validateThreeCompatibilityProfile({
      ...profile,
      schemaVersion: 0,
      threeVersion: "latest",
      classes: [{ ...profile.classes[0]!, name: "mesh-helper" }],
    });
    expect(result.valid).toBe(false);
    expect(result.issues.map((item) => item.code)).toEqual([
      "invalid-schema-version",
      "invalid-three-version",
      "invalid-class-name",
    ]);
  });

  it("rejects duplicate semantics and unsupported levels", () => {
    const result = validateThreeCompatibilityProfile({
      ...profile,
      classes: [
        {
          ...profile.classes[0]!,
          level: "partial" as never,
          semantics: ["position", "position"],
        },
      ],
    });
    expect(result.issues.map((item) => item.code)).toEqual(["invalid-level", "duplicate-semantics"]);
  });

  it("keeps excluded classes free of compatibility contracts", () => {
    const result = validateThreeCompatibilityProfile({
      ...profile,
      classes: [{ ...profile.classes[0]!, level: "excluded" }],
    });
    expect(result.issues.map((item) => item.code)).toEqual([
      "excluded-has-contract",
      "excluded-has-contract",
    ]);
  });
});
