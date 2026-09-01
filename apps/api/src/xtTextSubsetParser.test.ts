import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { minimalXtRevolvedSubsetFixture } from "./fixtures/minimalXtRevolvedSubset.js";
import { parseXtRevolvedSubset, UnsupportedXtTextSubsetError } from "./xtTextSubsetParser.js";

const realFixturePath = fileURLToPath(new URL("../../../data/external-assets/format-fixtures/x_t/cadconvert-small.x_t", import.meta.url));

describe("X_T clean-room revolved subset parser", () => {
  it("parses the bounded synthetic contract fixture", () => {
    const result = parseXtRevolvedSubset(minimalXtRevolvedSubsetFixture());

    expect(result).toMatchObject({
      schema: "SCH_2401231_20000_1300",
      bodyCount: 1,
      faceCount: 10,
      sourceUnits: "meter",
      outputUnits: "millimeter",
    });
    expect(result.profile).toHaveLength(10);
    expect(result.torusProfiles).toHaveLength(1);
    expect(result.torusProfiles[0]?.axialCenterMm).toBeCloseTo(61, 6);
    expect(result.torusProfiles[0]?.majorRadiusMm).toBeCloseTo(32.290625, 6);
    expect(result.torusProfiles[0]?.minorRadiusMm).toBeCloseTo(7, 6);
  });

  it.runIf(existsSync(realFixturePath))("reproduces the licensed real sample measurements", async () => {
    const source = await readFile(realFixturePath);
    expect(createHash("sha256").update(source).digest("hex")).toBe(
      "4a6c8c8e5b0a5f2b3674d2f3d15248512bdc19501fe42056374ee4c78b0f387f",
    );
    const result = parseXtRevolvedSubset(source);
    expect(result).toMatchObject({ bodyCount: 1, faceCount: 10, application: "SolidWorks 2013-2012270" });
    expect(Math.min(...result.profile.map((point) => point.axialMm))).toBeCloseTo(0, 6);
    expect(Math.max(...result.profile.map((point) => point.axialMm))).toBeCloseTo(63, 6);
    expect(Math.max(...result.profile.map((point) => point.radiusMm))).toBeCloseTo(51.5, 6);
  });

  it("rejects unknown schema, damaged topology and oversized input", () => {
    const valid = new TextDecoder().decode(minimalXtRevolvedSubsetFixture());
    const unknownSchema = valid.replaceAll("SCH_2401231_20000_1300", "SCH_2500000_20000_1300");
    const missingTorus = valid.replace(/54 86[^]*$/, "");
    const unknownGeometry = `${valid} 31 999 100 0 1 2 3 0 .01 0 0 -1 0 0 0 0 1 .02`;

    expect(() => parseXtRevolvedSubset(new TextEncoder().encode(unknownSchema))).toThrow(/仅支持 SCH_2401231_20000_1300/);
    expect(() => parseXtRevolvedSubset(new TextEncoder().encode(missingTorus))).toThrow(/圆环面 0/);
    expect(() => parseXtRevolvedSubset(new TextEncoder().encode(unknownGeometry))).toThrow(/圆边 11/);
    expect(() => parseXtRevolvedSubset(new Uint8Array(16 * 1024 * 1024 + 1))).toThrow(UnsupportedXtTextSubsetError);
  });
});
