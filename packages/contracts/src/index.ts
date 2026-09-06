import type { ApplicationDocument, ApplicationPublicationPointer, PublishedApplicationRecord } from "./application.js";
import type { SceneDashboardState } from "./dashboard.js";
import type { ProjectRecord } from "./project.js";
import type { PublishedSceneRecord, SceneSnapshot } from "./scene.js";
export * from "./directBinding.js";
export * from "./aiDataBinding.js";
export * from "./parametricModeling.js";
export * from "./operations.js";
export * from "./plantLiteModel.js";
export * from "./data.js";
export * from "./geometry.js";
export * from "./vision.js";
export * from "./virtualCommissioning.js";
export * from "./industrialAi.js";
export * from "./industrialValidationStudy.js";
export * from "./industrialStudy.js";
export * from "./industrialStudyValidation.js";
export * from "./workcellValidation.js";
export * from "./askData.js";
export * from "./dashboard.js";
export * from "./project.js";
export * from "./ergonomics.js";
export * from "./robot.js";
export * from "./scene.js";
export * from "./sceneModelAsset.js";
export * from "./industrialPrefab.js";
export * from "./publicationRendererPolicy.js";
export * from "./modelFormatCapability.js";
export * from "./modelFormatCatalog.js";
export * from "./ppr.js";
export * from "./assetLibrary.js";
export * from "./notification.js";






export type SystemUserRole = "admin" | "editor" | "viewer";

export interface SystemUserRecord {
  id: string;
  username: string;
  displayName: string;
  role: SystemUserRole;
  projectIds: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StoredSystemUserRecord extends SystemUserRecord {
  passwordHash: string;
}

export interface AuditLogRecord {
  id: string;
  userId?: string;
  username?: string;
  action: string;
  resource: string;
  method: string;
  statusCode: number;
  ip?: string;
  detail?: string;
  createdAt: string;
}

export interface AiProviderSettings {
  /** 插件注册的 AI provider ID；模型名和接口协议属于该 provider 的运行配置。 */
  providerId: string;
  baseUrl: string;
  model: string;
  protocol: "auto" | "responses" | "chat-completions";
  apiKeyConfigured: boolean;
  apiKey?: string;
  temperature: number;
  updatedAt?: string;
}

export interface ServiceHealthRecord {
  id: "api" | "web" | "node-red" | "media" | "vision" | "postgres" | "minio";
  name: string;
  status: "healthy" | "degraded" | "offline" | "not-configured";
  endpoint: string;
  latencyMs?: number;
  message?: string;
  checkedAt: string;
}

export interface ServiceLogRecord {
  service: string;
  file: string;
  lines: string[];
  updatedAt?: string;
}

export interface AiAssistantResponse {
  text: string;
  dashboard?: SceneDashboardState;
  model: string;
  reliability?: AiAssistantReliability;
}

export type ServiceLogLevel = "debug" | "info" | "warn" | "error";

export interface ServiceLogEntry {
  id: string;
  service: string;
  level: ServiceLogLevel;
  timestamp: string;
  message: string;
  file: string;
}

export interface ServiceLogQueryResult {
  items: ServiceLogEntry[];
  total: number;
  truncated: boolean;
  services: string[];
  generatedAt: string;
}

export interface SystemDiagnosticSnapshot {
  generatedAt: string;
  runtime: {
    platform: string;
    architecture: string;
    nodeVersion: string;
    uptimeSeconds: number;
    metadataStore: "json" | "postgres";
    objectStore: "local" | "minio";
  };
  health: ServiceHealthRecord[];
  logs: ServiceLogQueryResult;
}

export type AiAssistantVerification = "verified" | "supported" | "limited" | "unverified";
export type AiAssistantInputRisk = "low" | "medium" | "high";
export type AiAssistantWritePolicy = "read-only" | "confirm-required";
export type AiAssistantContextTrust = "client-snapshot" | "server-evidence" | "capability-result";

/**
 * AI文本与工业事实分层展示。模型名称或措辞不能证明结论可靠，只有完成的
 * Capability及其证据指纹才能标记为 verified。
 */
export interface AiAssistantReliability {
  traceId: string;
  verification: AiAssistantVerification;
  inputRisk: AiAssistantInputRisk;
  contextTrust: AiAssistantContextTrust;
  contextFingerprint: string;
  evidenceCount: number;
  warnings: string[];
  writePolicy: AiAssistantWritePolicy;
}

export interface SystemBrandingSettings {
  systemName: string;
  browserTitle: string;
  loginSubtitle: string;
  copyright: string;
  logoUrl: string;
  iconUrl: string;
  primaryColor: string;
  themeMode: "dark" | "light";
  defaultLocale: "zh-CN" | "en-US";
  defaultEntry: "manager" | "studio" | "data";
  defaultSceneBackground: string;
  defaultGridVisible: boolean;
  maintenanceEnabled: boolean;
  maintenanceMessage: string;
  updatedAt?: string;
}

/** Web、API 与本地客户端共享的默认品牌；部署方仍可在运行时覆盖这些字段。 */
export const DEFAULT_PRODUCT_BRANDING: Readonly<SystemBrandingSettings> = {
  systemName: "Deep Monkey Studio",
  browserTitle: "Deep Monkey Studio",
  loginSubtitle: "数字孪生场景平台",
  copyright: "Copyright © 张文鹏 Charlie",
  logoUrl: "/brand/logo-industrial.svg",
  iconUrl: "/brand/app-icon-industrial.svg",
  primaryColor: "#d6aa4d",
  themeMode: "dark",
  defaultLocale: "zh-CN",
  defaultEntry: "manager",
  defaultSceneBackground: "#202a31",
  defaultGridVisible: true,
  maintenanceEnabled: false,
  maintenanceMessage: "系统维护中，请稍后再试",
};

export interface DatabaseDocument {
  projects: ProjectRecord[];
  scenes: SceneSnapshot[];
  publishedScenes?: PublishedSceneRecord[];
  scenePublicationHistory?: PublishedSceneRecord[];
  applications?: ApplicationDocument[];
  publishedApplications?: PublishedApplicationRecord[];
  applicationPublicationPointers?: ApplicationPublicationPointer[];
  users?: StoredSystemUserRecord[];
  auditLogs?: AuditLogRecord[];
  aiSettings?: Omit<AiProviderSettings, "apiKeyConfigured"> & { apiKey?: string };
  branding?: SystemBrandingSettings;
  /** endpointId -> SHA-256(API key)，不会包含在 ProjectRecord API 响应中。 */
  dataEndpointSecrets?: Record<string, string>;
}

export * from "./application.js";
export * from "./battery.js";
export * from "./batteryDataContract.js";
export * from "./applicationMigration.js";
export * from "./resourceId.js";
export * from "./converter.js";
export * from "./unityReadiness.js";
export * from "./semantic.js";
export * from "./simulationEntities.js";
export * from "./robotAsset.js";
