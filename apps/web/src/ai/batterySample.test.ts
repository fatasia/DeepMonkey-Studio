import { describe, expect, it } from "vitest";
import { assessBatteryDataContract } from "@bim-studio/contracts";
import {
  BATTERY_EXAMPLES,
  batteryExampleById,
  batteryOutOfDomainCsv,
} from "./batterySample";

describe("battery built-in examples", () => {
  it("ports the original multiscale cases plus useful runtime scenarios", () => {
    expect(BATTERY_EXAMPLES).toHaveLength(8);
    expect(new Set(BATTERY_EXAMPLES.map((example) => example.id)).size).toBe(8);
    expect(BATTERY_EXAMPLES.filter((example) => example.tasks.includes("rul"))).toHaveLength(5);
    expect(BATTERY_EXAMPLES.some((example) => example.id === "pack-multicell")).toBe(true);
    expect(BATTERY_EXAMPLES.some((example) => example.id === "lfp-tempest-280ah")).toBe(true);
    expect(batteryExampleById("missing").id).toBe("nca-validation");
  });

  it("keeps the generated out-of-domain case deterministic and runnable for state models", () => {
    const csv = batteryOutOfDomainCsv();
    expect(csv).toBe(batteryOutOfDomainCsv());
    const [header, ...rows] = csv.split("\n");
    expect(rows).toHaveLength(144);
    const fields = header!.split(",").map(key => ({ key, type: "number" }));
    for (const model of ["socformer", "bmsformer"] as const) {
      expect(assessBatteryDataContract(model, fields, { nominalCapacityProvided: true }).compatible).toBe(true);
    }
    expect(assessBatteryDataContract("batterymformer", fields, { nominalCapacityProvided: true }).compatible).toBe(false);
    expect(rows.some(row => row.includes("temperature-intermittent"))).toBe(true);
  });

  it("ships every static example under the upload limit with a verified manifest", () => {
    const sampleRoot = path.resolve(import.meta.dirname, "../../public/samples");
    const manifest = JSON.parse(readFileSync(path.join(sampleRoot, "battery-examples.manifest.json"), "utf8")) as {
      artifacts: Array<{ file: string; sha256: string }>;
    };
    for (const example of BATTERY_EXAMPLES.filter((item) => item.url)) {
      const filePath = path.join(sampleRoot, example.fileName);
      const bytes = readFileSync(filePath);
      const header = bytes.subarray(0, bytes.indexOf(10)).toString("utf8").replace(/\r$/, "").split(",");
      expect(statSync(filePath).size, example.id).toBeLessThanOrEqual(15 * 1024 * 1024);
      expect(header, example.id).toEqual(expect.arrayContaining([...example.headers]));
      const recorded = manifest.artifacts.find((item) => item.file === example.fileName);
      expect(recorded, example.id).toBeDefined();
      expect(createHash("sha256").update(bytes).digest("hex").toUpperCase(), example.id).toBe(recorded!.sha256);
    }
  });
});
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
