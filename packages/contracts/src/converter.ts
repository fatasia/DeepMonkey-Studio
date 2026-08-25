/** Converter protocol shared by the browser, API workers, and future desktop sidecars. */
export const converterContractVersion = 1 as const;

export type ConverterExecutionEnvironment = "server-worker" | "desktop-sidecar";
export type ConverterCapability = "filesystem.read-input" | "filesystem.write-output" | "network.outbound";

export interface ConverterResourceLimits {
  timeoutMs: number;
  maxInputBytes: number;
  maxOutputBytes: number;
  maxMemoryMb: number;
  maxCpuPercent: number;
}

export type ConversionArtifactKind = "geometry" | "hierarchy" | "properties" | "pmi" | "lod" | "thumbnail" | "log";

export interface ConverterOutputDeclaration {
  kind: ConversionArtifactKind;
  format: string;
  required: boolean;
  multiple?: boolean;
}

export interface ConverterPluginManifest {
  contractVersion: typeof converterContractVersion;
  id: string;
  name: string;
  version: string;
  execution: ConverterExecutionEnvironment;
  inputFormats: string[];
  outputs: ConverterOutputDeclaration[];
  configurationSchema: Record<string, unknown>;
  capabilities: ConverterCapability[];
  limits: ConverterResourceLimits;
}

export interface ConverterPluginDescriptor {
  manifest: ConverterPluginManifest;
  available: boolean;
  unavailableReason?: string;
  provider?: ConverterProviderProbe;
}

export type ConverterProviderProbeStatus = "not_configured" | "not_found" | "probe_failed" | "detected";

export interface ConverterProviderProbe {
  id: string;
  name: string;
  deployment: "server" | "desktop";
  status: ConverterProviderProbeStatus;
  command?: string;
  detectedVersion?: string;
  message: string;
  remediation: string;
}

export type ConversionTaskStatus =
  | "queued"
  | "waiting_converter"
  | "running"
  | "cancelling"
  | "cancelled"
  | "succeeded"
  | "failed";

export interface ConversionTaskInput {
  objectKey: string;
  fileName: string;
  format: string;
  size: number;
  sha256?: string;
}

export interface ConversionArtifact {
  kind: ConversionArtifactKind;
  format: string;
  objectKey: string;
  size: number;
  sha256?: string;
  metadata?: Record<string, unknown>;
}

export interface ConversionTaskRecord {
  id: string;
  projectId: string;
  pluginId: string;
  pluginVersion: string;
  input: ConversionTaskInput;
  configuration: Record<string, unknown>;
  status: ConversionTaskStatus;
  progress: number;
  message: string;
  artifacts: ConversionArtifact[];
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface SubmitConversionTaskRequest {
  projectId: string;
  pluginId: string;
  input: ConversionTaskInput;
  configuration?: Record<string, unknown>;
}
