import { describe, expect, it } from "vitest";
import { findModelFormatCapability } from "./modelFormatCatalog.js";

describe("robot format catalog scope", () => {
  it("groups URDF and robot ZIP while making no unverified runtime/fidelity claim", () => {
    const urdf = findModelFormatCapability(".URDF");
    expect(urdf).toBe(findModelFormatCapability("zip"));
    expect(urdf).toMatchObject({ id: "urdf", scope: "core", implementationStatus: "planned", validationStatus: "unverified" });
    expect(urdf?.decisionReason).toContain("ZIP 仅限机器人包");
    expect(urdf?.validatedFidelity).toEqual({});
  });
});
