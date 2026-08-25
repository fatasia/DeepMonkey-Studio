import { describe, expect, it } from "vitest";
import type { ConverterPluginManifest, ConversionTaskRecord } from "./converter.js";

describe("converter contract", () => {
  it("keeps execution, permissions, limits, and semantic outputs explicit", () => {
    const manifest: ConverterPluginManifest = {
      contractVersion: 1,
      id: "industrial-cad.parasolid",
      name: "Parasolid external converter",
      version: "0.1.0",
      execution: "server-worker",
      inputFormats: ["x_t", "x_b"],
      outputs: [
        { kind: "geometry", format: "glb", required: true },
        { kind: "hierarchy", format: "json", required: true },
        { kind: "properties", format: "json", required: true }
      ],
      configurationSchema: { type: "object", additionalProperties: false },
      capabilities: ["filesystem.read-input", "filesystem.write-output"],
      limits: { timeoutMs: 600_000, maxInputBytes: 2_000_000_000, maxOutputBytes: 4_000_000_000, maxMemoryMb: 4096, maxCpuPercent: 200 }
    };

    expect(manifest.inputFormats).toEqual(["x_t", "x_b"]);
    expect(manifest.outputs.map((output) => output.kind)).toEqual(["geometry", "hierarchy", "properties"]);
    expect(manifest.capabilities).not.toContain("network.outbound");
  });

  it("does not confuse waiting for a licensed converter with conversion failure", () => {
    const task: ConversionTaskRecord = {
      id: "task-1",
      projectId: "project-1",
      pluginId: "industrial-cad.jt",
      pluginVersion: "0.1.0",
      input: { objectKey: "projects/project-1/imports/source.jt", fileName: "source.jt", format: "jt", size: 100 },
      configuration: {},
      status: "waiting_converter",
      progress: 0,
      message: "等待已授权 JT 转换器",
      artifacts: [],
      createdAt: "2026-08-25T00:00:00.000Z",
      updatedAt: "2026-08-25T00:00:00.000Z"
    };

    expect(task.status).toBe("waiting_converter");
    expect(task.artifacts).toEqual([]);
  });
});
