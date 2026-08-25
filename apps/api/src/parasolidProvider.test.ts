import { describe, expect, it, vi } from "vitest";
import { inspectParasolidHeader, loadParasolidProviderConfig, probeParasolidProvider } from "./parasolidProvider.js";

describe("Parasolid provider probe", () => {
  it("selects CAD Exchanger Batch on the server and gives an actionable configuration message", async () => {
    const config = loadParasolidProviderConfig({});
    const result = await probeParasolidProvider(config, vi.fn());

    expect(config).toMatchObject({ id: "cadexchanger-batch", deployment: "server", probeArgs: ["--probe", "--json"] });
    expect(result).toMatchObject({ status: "not_configured", id: "cadexchanger-batch" });
    expect(result.remediation).toContain("PARASOLID_CONVERTER_COMMAND");
  });

  it("reports a detected configured provider without assuming an executor is bound", async () => {
    const runner = vi.fn(async () => ({ exitCode: 0, stdout: "CAD Exchanger Batch 3.24.0\n", stderr: "" }));
    const config = loadParasolidProviderConfig({
      PARASOLID_CONVERTER_PROVIDER: "cadexchanger-batch",
      PARASOLID_CONVERTER_COMMAND: "C:\\CADExchanger\\batch.exe",
      PARASOLID_CONVERTER_PROBE_ARGS: "[\"version\"]"
    });

    const result = await probeParasolidProvider(config, runner);
    expect(runner).toHaveBeenCalledWith("C:\\CADExchanger\\batch.exe", ["version"]);
    expect(result).toMatchObject({ status: "detected", detectedVersion: "CAD Exchanger Batch 3.24.0" });
  });

  it("distinguishes a missing executable from a failed license or probe", async () => {
    const config = loadParasolidProviderConfig({ PARASOLID_CONVERTER_COMMAND: "missing.exe" });
    const missing = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    const notFound = await probeParasolidProvider(config, async () => { throw missing; });
    const failed = await probeParasolidProvider(config, async () => ({ exitCode: 12, stdout: "", stderr: "license unavailable" }));

    expect(notFound.status).toBe("not_found");
    expect(failed).toMatchObject({ status: "probe_failed" });
    expect(failed.message).toContain("license unavailable");
  });

  it("extracts a best-effort schema version from x_t and keeps x_b detection conservative", () => {
    const text = new TextEncoder().encode("**PARASOLID ! Parasolid XT text schema SCH_35006 PART1;");
    const binary = new TextEncoder().encode("PARASOLID binary payload without exposed schema");

    expect(inspectParasolidHeader(text, "x_t")).toEqual({ encoding: "text", signatureFound: true, schemaId: "35006", majorVersion: 35 });
    expect(inspectParasolidHeader(binary, "x_b")).toEqual({ encoding: "binary", signatureFound: true });
  });
});
