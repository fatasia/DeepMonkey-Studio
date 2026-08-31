import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { loadBatteryOnnxDeployment } from "./batteryOnnxDeployment.js";

describe("battery ONNX deployment", () => {
  it("keeps Python as the explicit default", async () => {
    await expect(loadBatteryOnnxDeployment({})).resolves.toMatchObject({
      enabled: false,
      requestedModels: [],
    });
  });

  it("verifies approved artifacts before exposing a model", async () => {
    const fixture = await deploymentFixture();
    const deployment = await loadBatteryOnnxDeployment({
      BATTERY_ONNX_MANIFEST_FILE: fixture.manifestFile,
      BATTERY_ONNX_ARTIFACT_ROOT: fixture.root,
      BATTERY_ONNX_MODELS: "socformer",
    });
    expect(deployment).toMatchObject({ enabled: true, requestedModels: ["socformer"] });
    expect(deployment.models.socformer?.artifactPath).toBe(fixture.artifactPath);
  });

  it("rejects a modified artifact instead of silently falling back", async () => {
    const fixture = await deploymentFixture();
    await writeFile(fixture.artifactPath, "tampered");
    await expect(loadBatteryOnnxDeployment({
      BATTERY_ONNX_MANIFEST_FILE: fixture.manifestFile,
      BATTERY_ONNX_ARTIFACT_ROOT: fixture.root,
      BATTERY_ONNX_MODELS: "socformer",
    })).rejects.toThrow(/体积与清单不一致|哈希与清单不一致/);
  });

  it("rejects path traversal in a signed descriptor", async () => {
    const fixture = await deploymentFixture("../socformer.onnx");
    await expect(loadBatteryOnnxDeployment({
      BATTERY_ONNX_MANIFEST_FILE: fixture.manifestFile,
      BATTERY_ONNX_ARTIFACT_ROOT: fixture.root,
    })).rejects.toThrow("清单结构无效");
  });
});

async function deploymentFixture(artifactName = "socformer.onnx") {
  const root = await mkdtemp(join(tmpdir(), "battery-onnx-"));
  const artifactPath = join(root, "socformer.onnx");
  const adapterPath = join(root, "socformer.runtime-adapter.json");
  const artifact = Buffer.from("onnx-model");
  const adapter = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    modelId: "battery.socformer",
    modelVersion: "socformer-li-hybrid-v2",
    kind: "socformer-window-v1",
  }));
  await writeFile(artifactPath, artifact);
  await writeFile(adapterPath, adapter);
  const manifest = approvedManifest(artifactName, artifact, adapter);
  const manifestFile = join(root, "manifests.json");
  await writeFile(manifestFile, JSON.stringify([manifest]));
  return { root, artifactPath, adapterPath, manifestFile };
}

function approvedManifest(artifactName: string, artifact: Buffer, adapter: Buffer) {
  return {
    schemaVersion: 1,
    modelId: "battery.socformer",
    source: { modelVersion: "socformer-li-hybrid-v2", checkpointSha256: "a".repeat(64) },
    artifact: { fileName: artifactName, sha256: digest(artifact), sizeBytes: artifact.length, opset: 18, precision: "fp32" },
    runtimeAdapter: { fileName: "socformer.runtime-adapter.json", sha256: digest(adapter), sizeBytes: adapter.length, schemaVersion: 1 },
    contract: {
      input: "socformer-normalized-sequence-window-v1",
      output: "soc-fraction-v1",
      preprocessing: "socformer-sequence-anchor-v1",
      postprocessing: "socformer-hybrid-soc-product-v1",
    },
    validation: {
      outputs: [{ task: "soc", samples: 70, maxAbsoluteError: 0, meanAbsoluteError: 0, allowedMaxAbsoluteError: 0.001, allowedMeanAbsoluteError: 0.0001 }],
      boundaryCases: 8, boundaryPassed: 8, outOfDomainCases: 4, outOfDomainPassed: 4,
      invalidInputCases: 6, invalidInputRejected: 6, repeatRuns: 5, maxRepeatDrift: 0, allowedRepeatDrift: 1e-7,
      businessReplayCases: 3, businessReplayPassed: 3,
    },
    approval: {
      decisionStatus: "production-approved", independentDatasetSplit: true, externalLockboxCases: 1,
      approvedBy: "battery-release-board", approvedAt: "2026-08-29T00:00:00.000Z", evidenceFingerprint: "c".repeat(64),
    },
    generatedAt: "2026-08-29T00:00:00.000Z",
  };
}

function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
