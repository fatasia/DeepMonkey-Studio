import type { ConverterPluginManifest } from "@bim-studio/contracts";
import type { ConverterPluginRegistration } from "./conversionTasks.js";
import { loadParasolidProviderConfig, probeParasolidProvider, type ParasolidProbeRunner } from "./parasolidProvider.js";

const sharedLimits = {
  timeoutMs: 30 * 60_000,
  maxInputBytes: 2 * 1024 * 1024 * 1024,
  maxOutputBytes: 4 * 1024 * 1024 * 1024,
  maxMemoryMb: 8192,
  maxCpuPercent: 400
};

const parasolidManifest: ConverterPluginManifest = {
  contractVersion: 1,
  id: "industrial-cad.parasolid",
  name: "Parasolid x_t/x_b converter",
  version: "0.1.0",
  execution: "server-worker",
  inputFormats: ["x_t", "x_b"],
  outputs: [
    { kind: "geometry", format: "glb", required: true },
    { kind: "hierarchy", format: "json", required: true },
    { kind: "properties", format: "json", required: true }
  ],
  configurationSchema: { type: "object", additionalProperties: true },
  capabilities: ["filesystem.read-input", "filesystem.write-output"],
  limits: sharedLimits
};

const jtManifest: ConverterPluginManifest = {
  contractVersion: 1,
  id: "industrial-cad.jt",
  name: "JT external converter",
  version: "0.1.0",
  execution: "server-worker",
  inputFormats: ["jt"],
  outputs: [
    { kind: "geometry", format: "glb", required: true },
    { kind: "hierarchy", format: "json", required: true },
    { kind: "properties", format: "json", required: true },
    { kind: "pmi", format: "json", required: false },
    { kind: "lod", format: "glb", required: false, multiple: true }
  ],
  configurationSchema: { type: "object", additionalProperties: true },
  capabilities: ["filesystem.read-input", "filesystem.write-output"],
  limits: sharedLimits
};

/**
 * x_t/x_b and JT require a licensed native SDK. The manifests are visible so
 * deployments can bind an executor later, while tasks truthfully remain
 * waiting_converter until that executor exists.
 */
export async function externalCadConverterRegistrations(
  environment: NodeJS.ProcessEnv = process.env,
  probeRunner?: ParasolidProbeRunner
): Promise<ConverterPluginRegistration[]> {
  const provider = await probeParasolidProvider(loadParasolidProviderConfig(environment), probeRunner);
  const parasolidReason = provider.status === "detected"
    ? `${provider.message}；M5 下一步按 provider adapter 协议绑定转换执行器`
    : `${provider.message}。${provider.remediation}`;
  return [
    { manifest: parasolidManifest, provider, unavailableReason: parasolidReason },
    { manifest: jtManifest, unavailableReason: "等待已授权 JT 转换器；源文件及 PMI/LOD 需求已保留" }
  ];
}
