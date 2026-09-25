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
  it("rejects duplicate evidence dimensions and unhashed passed checks", () => {
    const duplicate = report(); duplicate.checks.push(duplicate.checks[0]!); expect(() => assertConversionQualityReport(duplicate)).toThrow("重复");
    const noHash = report(); delete noHash.checks[0]!.evidenceSha256; expect(() => assertConversionQualityReport(noHash)).toThrow("证据哈希");
  });
  it("allows visual-complete only with machine-readable declared losses, never free text", () => {
    // visual-complete 表示可视内容完整但允许显式保真损失（如 JT 缺 UV）；损失必须可机读。
    const declared = report(); declared.losses.push("geometry.uv", "vertex.colors");
    expect(() => assertConversionQualityReport(declared)).not.toThrow();
    const narrative = report(); narrative.losses.push("missing some faces");
    expect(() => assertConversionQualityReport(narrative)).toThrow("损失");
    const engineering = report(); engineering.tier = "engineering-verified";
    engineering.checks.push({ dimension: "topology", passed: true, evidenceSha256: hash }, { dimension: "accuracy", passed: true, evidenceSha256: hash });
    engineering.losses.push("geometry.uv");
    expect(() => assertConversionQualityReport(engineering)).toThrow("工程验证档");
  });
  it("validates optional engine metrics when present", () => {
    const withMetrics = report(); withMetrics.metrics = { engine: "builtin-jt-lod0", triangleCount: 12, entityCounts: { bodies: 1 } };
    expect(() => assertConversionQualityReport(withMetrics)).not.toThrow();
    const noEngine = report(); (noEngine.metrics as unknown) = { triangleCount: 1 };
    expect(() => assertConversionQualityReport(noEngine)).toThrow("引擎标识");
    const negative = report(); negative.metrics = { engine: "x", triangleCount: -1 };
    expect(() => assertConversionQualityReport(negative)).toThrow("计数无效");
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
