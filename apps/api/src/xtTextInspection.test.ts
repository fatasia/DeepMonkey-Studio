import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { minimalXtRevolvedSubsetFixture } from "./fixtures/minimalXtRevolvedSubset.js";
import { inspectXtTextBytes } from "./xtTextInspection.js";

const realFixturePath = fileURLToPath(new URL(
  "../../../data/external-assets/format-fixtures/x_t/cadconvert-small.x_t",
  import.meta.url,
));

describe("X_T text inspection and capability boundary", () => {
  it("recognizes a different schema without pretending to decode its topology", () => {
    const source = replaceSchema(minimalXtRevolvedSubsetFixture(), "SCH_2500000_20000_1300");
    const result = inspectXtTextBytes(source);

    expect(result).toMatchObject({
      status: "structure-read",
      geometryParsed: false,
      schema: "SCH_2500000_20000_1300",
      topology: {
        bodies: { status: "not-decoded" },
        shells: { status: "not-decoded" },
        assembly: { status: "not-decoded" },
      },
      metadata: {
        header: "decoded",
        entityNames: "not-decoded",
        colors: "not-decoded",
        properties: "header-only",
      },
      geometry: { status: "not-decoded" },
    });
    expect(result.geometry.reason).toContain("仅支持 SCH_2401231_20000_1300");
  });

  it("rejects an unverified topology instead of emitting fallback geometry", () => {
    const valid = new TextDecoder().decode(minimalXtRevolvedSubsetFixture());
    const extraCircle = " 31 999 100 0 1 2 3 0 .01 0 0 -1 0 0 0 0 1 .02";
    const result = inspectXtTextBytes(new TextEncoder().encode(valid + extraCircle));

    expect(result.status).toBe("structure-read");
    expect(result.geometryParsed).toBe(false);
    expect(result.geometry.reason).toContain("圆边 11");
    expect(result.topology.bodies.count).toBeUndefined();
    expect(result.limitations.join(" ")).toContain("占位体");
  });

  it.runIf(existsSync(realFixturePath))("extracts licensed real-file header metadata and the verified geometry scope", async () => {
    const source = await readFile(realFixturePath);
    expect(createHash("sha256").update(source).digest("hex")).toBe(
      "4a6c8c8e5b0a5f2b3674d2f3d15248512bdc19501fe42056374ee4c78b0f387f",
    );

    const result = inspectXtTextBytes(source);
    expect(result).toMatchObject({
      status: "geometry-supported",
      geometryParsed: true,
      schema: "SCH_2401231_20000_1300",
      header: {
        application: "SolidWorks 2013-2012270",
        sourceFileName: "500.081.x_t",
        productVersion: "Parasolid Version 24.1, build 231,  7-17-2012",
        guise: "transmit",
        key: "500.081",
        createdAt: "Mon Aug 13 12:52:39 2018",
        declaredSchema: "SCH_2401231_20000",
      },
      topology: {
        bodies: { status: "decoded", count: 1 },
        faces: { status: "decoded", count: 10 },
        shells: { status: "not-decoded" },
      },
      geometry: {
        status: "decoded-revolved-subset",
        capabilityId: "x-t-v24.1-coaxial-revolved-part",
      },
    });
  });
});

function replaceSchema(source: Uint8Array, nextSchema: string): Uint8Array {
  const text = new TextDecoder().decode(source)
    .replaceAll("SCH_2401231_20000_1300", nextSchema)
    .replaceAll("SCH_2401231_20000", nextSchema.replace(/_1300$/, ""));
  return new TextEncoder().encode(text);
}
