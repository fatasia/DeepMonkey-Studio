import type { ApplicationDocument, ApplicationPublicationPointer, PublishedApplicationRecord } from "./application.js";
import type { SceneDashboardState } from "./dashboard.js";
import type { ProjectRecord } from "./project.js";
import type { PublishedSceneRecord, SceneSnapshot } from "./scene.js";
export * from "./directBinding.js";
export type { AiSessionMessageStatus, AiSessionReliability, AiSessionSummary, AiSessionMessageInput, AiSessionMessage, AiSessionList, AiSessionMessages } from "./aiSession.js";
export * from "./aiDataBinding.js";
export * from "./parametricModeling.js";
export * from "./operations.js";
export * from "./plantLiteModel.js";
export * from "./data.js";
export * from "./dataWriteback.js";
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
export * from "./dashboardSampleData.js";
export * from "./project.js";
export * from "./ergonomics.js";
export * from "./robot.js";
export * from "./scene.js";
export * from "./sceneWeatherFog.js";
export * from "./sceneModelAsset.js";
export * from "./industrialPrefab.js";
export * from "./publicationRendererPolicy.js";
export * from "./modelFormatCapability.js";
export * from "./modelFormatCatalog.js";
export * from "./ppr.js";
export * from "./fingerprint.js";
export * from "./simulationEngine.js";
export * from "./digitalThread.js";
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
  /** 思考深度；未配置时保持历史默认行为。仅 OpenAI 兼容 provider 支持。 */
  reasoningEffort?: "minimal" | "standard" | "deep";
  updatedAt?: string;
  /** 备用模型自动切换档；主模型出现额度/限流/服务端/超时/网络类错误时重试一次。 */
  failover?: AiFailoverSettings;
  /** 3D 生成厂商配置档；仅保存配置，不代表厂商适配器已注册或连接已验证。 */
  modeling3d?: {
    tripo3d: AiModelProviderSettings;
    tencentHunyuan: AiModelProviderSettings;
  };
}

export type AiModelCatalogFailure = {
  ok: false;
  category: "auth" | "network" | "unsupported" | "server" | "invalid";
  message: string;
};

export type AiModelCatalogResult =
  | { ok: true; models: string[]; cachedAt?: string }
  | AiModelCatalogFailure;

export interface AiFailoverSettings {
  enabled: boolean;
  /** 信息性字段；持久层可省略，运行时由 AI_FALLBACK_PROVIDER_ID 或主配置推导。 */
  providerId?: string;
  baseUrl: string;
  model: string;
  /** 可省略；省略时跟随主配置协议。 */
  protocol?: "auto" | "responses" | "chat-completions";
  apiKeyConfigured?: boolean;
  apiKey?: string;
}

export interface AiModelProviderSettings {
  providerId: string;
  baseUrl: string;
  model: string;
  protocol: "auto" | "responses" | "chat-completions";
  apiKeyConfigured?: boolean;
  apiKey?: string;
  secretIdConfigured?: boolean;
  secretId?: string;
  region?: string;
}

export interface ServiceHealthRecord {
  id: "api" | "web" | "media" | "vision" | "postgres" | "minio";
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
  /** 模型返回的二维页面草案仍不可信，必须经当前页面与数据目录验证后才能应用。 */
  dashboardPageDraft?: unknown;
  model: string;
  /** 发送参数与供应商回执分别记录，未回执不推断为已采用。 */
  execution?: {
    protocol: "responses" | "chat-completions";
    requestedModel: string;
    reportedModel?: string;
    reasoningEffortSent?: string;
    reasoningEffortReported?: string;
  servedBy?: "primary" | "fallback";
  failoverCategory?: string;
  };
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
    metadataStore: "json" | "sqlite" | "postgres";
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
  /** Server receipt for the context actually included in this answer's provider request. */
  contextDelivery?: AiContextDelivery;
  traceId: string;
  verification: AiAssistantVerification;
  inputRisk: AiAssistantInputRisk;
  contextTrust: AiAssistantContextTrust;
  contextFingerprint: string;
  evidenceCount: number;
  warnings: string[];
  writePolicy: AiAssistantWritePolicy;
  /** 本次响应实际由哪个配置提供服务；缺省视为 primary，兼容旧响应。 */
  servedProvider?: "primary" | "fallback";
  /** 主模型切换到备用模型的原因分类（额度、限流、服务端、超时、网络）。 */
  failoverReason?: string;
}

export interface AiContextDelivery {
  unit: "utf16";
  preparedChars: number;
  sentChars: number;
  sources: Array<{
    id: string;
    path: string;
    status: "sent" | "partial" | "omitted";
    preparedChars: number;
    sentChars: number;
    transformed: boolean;
  }>;
}

export type AiTelemetrySource = "assistant" | "agent-decision";

export type AiFailureCategory = "auth" | "quota" | "rate-limit" | "server" | "timeout" | "network" | "policy" | "invalid" | "cancelled" | "unknown";

export interface AiRequestTelemetryRecord {
  id: string;
  occurredAt: string;
  source: AiTelemetrySource;
  mode?: string;
  providerId: string;
  model: string;
  servedBy: "primary" | "fallback";
  status: "completed" | "failed" | "cancelled";
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  errorCategory?: AiFailureCategory;
  errorMessage?: string;
}

export interface AiTelemetrySummary {
  generatedAt: string;
  limit: number;
  records: AiRequestTelemetryRecord[];
  lastFailover?: AiRequestTelemetryRecord;
  totals: { completed: number; failed: number; cancelled: number; fallbackServed: number };
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
  systemName: "DeepMonkey Studio",
  browserTitle: "DeepMonkey Studio",
  loginSubtitle: "元宇宙平台",
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
  conversionTasks?: import("./converter.js").ConversionTaskRecord[];
  projects: ProjectRecord[];
  scenes: SceneSnapshot[];
  publishedScenes?: PublishedSceneRecord[];
  scenePublicationHistory?: PublishedSceneRecord[];
  scenePublicationDependencies?: import("./scenePublicationDependencies.js").ScenePublicationDependencies[];
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
export * from "./scenePublicationDependencies.js";
export * from "./battery.js";
export * from "./batteryDataContract.js";
export * from "./applicationMigration.js";
export * from "./resourceId.js";
export * from "./converter.js";
export * from "./conversionQuality.js";
export * from "./unityReadiness.js";
export * from "./semantic.js";
export * from "./simulationEntities.js";
export * from "./robotAsset.js";
export * from "./aiSamples.js";
export * from "./plantTransportNetwork.js";
export * from "./deviceSignal.js";
export * from "./modelProcessing.js";
export * from "./scenePublicationCompatibility.js";
export * from "./dashboardDocument.js";
export * from "./dashboardLayerOrder.js";
export * from "./dashboardWebPackage.js";
export * from "./formatImportContracts.js";
export * from "./sceneScriptProtocol.js";
