import { describe, expect, it } from "vitest";
import { compileIesAuthorProfile } from "./sceneIesAuthoring";

const fixture = ["IESNA:LM-63-2002", "[TEST] AUTHOR", "TILT=NONE",
  "1 1000 1.0 3 1 1 1 1 1 0", "1.0 1.0 60", "0 45 90", "0", "1000 500 100", ""].join("\n");

describe("IES author import", () => {
  it("parses, quantizes and gives identical source bytes a stable profile identity", () => {
    const first = compileIesAuthorProfile("Factory Beam.ies", fixture);
    expect(first).toMatchObject({ profileId: expect.stringMatching(/^ies-Factory-Beam-[0-9a-f]{8}$/),
      format: "LM-63-2002", verticalAngles: [0, 45, 90], candela: [[1000, 500, 100]], horizontalSymmetry: 1 });
    expect(compileIesAuthorProfile("Factory Beam.ies", fixture)).toEqual(first);
    expect(compileIesAuthorProfile("Factory Beam.ies", fixture.replace("1000 500 100", "900 500 100")).profileId)
      .not.toBe(first.profileId);
  });

  it("rejects unsupported or malformed LM-63 instead of creating a fallback profile", () => {
    expect(() => compileIesAuthorProfile("broken.ies", "not ies")).toThrow();
    expect(() => compileIesAuthorProfile("bad.ies", fixture.replace("3 1 1 1 1 1 0", "3 1 2 1 1 1 0"))).toThrow(/photometricType 2/);
  });
});
