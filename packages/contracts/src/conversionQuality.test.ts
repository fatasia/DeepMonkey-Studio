import { describe, expect, it } from "vitest";
import { assertConversionQualityReport, type ConversionQualityReport } from "./conversionQuality.js";
import { assertSourceBundleRecord } from "./formatImportContracts.js";
const hash = "a".repeat(64);
const report = (): ConversionQualityReport => ({ schemaVersion: 1, profileId: "test-v1", tier: "visual-complete", sourceHash: hash,
  checks: ["geometry", "structure", "identity", "coordinates", "dependencies"].map(dimension => ({ dimension: dimension as ConversionQualityReport["checks"][number]["dimension"], passed: true, evidenceSha256: hash })), losses: [], approximations: [] });
describe("conversion quality publication contract", () => {
  it("requires separate evidence for all five visual dimensions", () => {
    expect(() => assertConversionQualityReport(report())).not.toThrow();
    for (let index = 0; index < 5; index++) {
      const value = report(); value.checks.splice(index, 1);
      expect(() => assertConversionQualityReport(value)).toThrow("必需证据");
    }
  });
  it("rejects losses, duplicate evidence dimensions and unhashed passed checks", () => {
    const loss = report(); loss.losses.push("missing-face"); expect(() => assertConversionQualityReport(loss)).toThrow("损失");
    const duplicate = report(); duplicate.checks.push(duplicate.checks[0]!); expect(() => assertConversionQualityReport(duplicate)).toThrow("重复");
    const noHash = report(); delete noHash.checks[0]!.evidenceSha256; expect(() => assertConversionQualityReport(noHash)).toThrow("证据哈希");
  });
  it("reserves engineering grade for additional topology and accuracy proof", () => {
    const value = report(); value.tier = "engineering-verified";
    expect(() => assertConversionQualityReport(value)).toThrow("必需证据");
    value.checks.push({ dimension: "topology", passed: true, evidenceSha256: hash }, { dimension: "accuracy", passed: true, evidenceSha256: hash });
    expect(() => assertConversionQualityReport(value)).not.toThrow();
    value.approximations.push("unclosed-error-bound"); expect(() => assertConversionQualityReport(value)).toThrow("近似");
  });
  it("accepts inspect only with explicit reasons for missing geometry", () => {
    const value = report(); value.tier = "inspect"; value.losses = ["geometry.missing"];
    value.checks = [{ dimension: "geometry", passed: false, reason: "unsupported-profile" }];
    expect(() => assertConversionQualityReport(value)).not.toThrow();
    delete value.checks[0]!.reason; expect(() => assertConversionQualityReport(value)).toThrow("原因");
  });
  it.each(["", "\\\\server\\file.jt", "a\\..\\file.jt", "a//file.jt", "a/./file.jt", "file.jt:stream", "a\u0000.jt"])("rejects unsafe SourceBundle path %s", bundledPath => {
    expect(() => assertSourceBundleRecord({ schemaVersion: 1, sourceName: "file.jt", sourceFormat: "jt", contentHash: hash,
      bundledPath, licenseReference: "local-only" })).toThrow("相对路径");
  });
});
