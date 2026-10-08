import type { ApplicationDocument, ApplicationPublicationPointer, PublishedApplicationRecord } from "./application.js";
import type { AgentAutonomySettings } from "./agentAutonomy.js";
import type { SceneDashboardState } from "./dashboard.js";
import type { ProjectRecord } from "./project.js";
import type { PublishedSceneRecord, SceneSnapshot } from "./scene.js";
export * from "./directBinding.js";
export type { AiSessionMessageStatus, AiSessionReliability, AiSessionSummary, AiSessionMessageInput, AiSessionMessage, AiSessionList, AiSessionMessages } from "./aiSession.js";
export * from "./aiDataBinding.js";
export * from "./agentAutonomy.js";
export * from "./aiHypothesis.js";
export * from "./provenance.js";
export * from "./parametricModeling.js";
export * from "./operations.js";
export * from "./plantClassLibrary.js";
export * from "./plantLiteModel.js";
export * from "./data.js";
export * from "./dataWriteback.js";
export * from "./geometry.js";
export * from "./vision.js";
export * from "./virtualCommissioning.js";
export * from "./opcUaLive.js";
export * from "./industrialAi.js";
export * from "./industrialValidationStudy.js";
export * from "./industrialStudy.js";
export * from "./industrialStudyValidation.js";
export * from "./workcellValidation.js";
export * from "./askData.js";
export * from "./dashboard.js";
export * from "./dashboardSampleData.js";
export * from "./displayContract.js";
export * from "./project.js";
export * from "./ergonomics.js";
export * from "./humanFigure.js";
export * from "./robot.js";
export * from "./scene.js";
export { validateScene } from "./sceneValidation.js";
export * from "./sceneWeatherFog.js";
export * from "./sceneModelAsset.js";
export * from "./industrialPrefab.js";
export * from "./userPrefab.js";
export * from "./publicationRendererPolicy.js";
export * from "./modelFormatCapability.js";
export * from "./modelFormatCatalog.js";
export * from "./ppr.js";
export * from "./fingerprint.js";
export * from "./simulationEngine.js";
export * from "./plantExperiment.js";
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
  /** 「自动」模型路由回执：仅当用户选择自动时出现，说明实际选用的模型与原因。 */
  route?: AiAssistantRoute;
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

/**
 * T5（审计 20260929 §二 T5）：逐条引用锚——回答中被出域复核器命中的数值/编号 token，
 * 与其**真实证据定位**（来源+指纹+已发送窗口内的偏移）的一一对齐。
 * 锚由服务端在真正发送的上下文上计算；模型未见过的位置绝不产出（防伪造引用/引用漂移）。
 */
export interface AiAssistantCitation {
  /** 回答中被锚定的数值或编号 token（与 K2 出域复核器同源抽取）。 */
  token: string;
  /** 该 token 的证据锚列表；每个锚都是可独立复核的定位（sha256 与 contextFingerprint 同族）。 */
  anchors: Array<{
    sourceId: string;
    sourcePath: string;
    /** 来源准备文本内的 UTF-16 偏移（与 contextDelivery 同一坐标系）。 */
    offset: number;
    /** 来源准备文本的 sha256 指纹（auditFingerprint 同一载体）。 */
    fingerprint: string;
  }>;
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
  /** T5：逐条引用锚——回答数值/编号到已发送证据的逐条对齐；无锚（或全部未命中）时缺省。 */
  citations?: AiAssistantCitation[];
  warnings: string[];
  writePolicy: AiAssistantWritePolicy;
  /** 本次响应实际由哪个配置提供服务；缺省视为 primary，兼容旧响应。 */
  servedProvider?: "primary" | "fallback";
  /** 主模型切换到备用模型的原因分类（额度、限流、服务端、超时、网络）。 */
  failoverReason?: string;
}

/** 自动路由回执：reason 为稳定码（前端本地化），fellBack 表示小模型失败后已改用强模型。 */
export interface AiAssistantRoute {
  mode: "auto";
  tier: "fast" | "strong";
  model: string;
  reason: string;
  fellBack?: boolean;
}

/** 上下文预算裁剪回执：逐来源说明被压缩/缩减/省略了什么。 */
export interface AiContextBudgetReport {
  budgetChars: number;
  originalChars: number;
  usedChars: number;
  trimmed: Array<{
    id: string;
    action: "compacted" | "shrunk" | "omitted";
    fromChars: number;
    toChars: number;
    reason: string;
  }>;
}

export interface AiContextDelivery {
  unit: "utf16";
  /** 统一上下文预算器的裁剪回执；缺省表示未触发任何裁剪。 */
  budget?: AiContextBudgetReport;
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
  /** provider 回执的缓存命中输入 token（未回执则缺省，不推断）。 */
  cachedInputTokens?: number;
  /** 发送给模型的上下文字符数（预算器之后）。 */
  contextChars?: number;
  route?: AiAssistantRoute;
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
  /** H-autonomy：工业 Agent 授权范围/执行模式全局默认（运行启动可逐次覆盖）。 */
  agentSettings?: AgentAutonomySettings;
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
export * from "./ontology.js";
export * from "./ontologyAction.js";
export * from "./ontologyGraph.js";
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
export * from "./robotSync.js";
export * from "./plantAnalytics.js";
export * from "./studyReport.js";
export * from "./resultExport.js";
export * from "./modelStructure.js";
export * from "./mtm.js";
export * from "./geneticOptimization.js";
export * from "./multiObjective.js";
export * from "./vsm.js";
export * from "./textOrder.js";
export * from "./rendererCapabilityManifest.js";
export * from "./eventRecording.js";
export * from "./processAdmission.js";
export * from "./worldApi.js";
export * from "./worldApiValidation.js";
export * from "./ontologyGraphQuery.js";
