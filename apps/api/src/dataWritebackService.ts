import { assertDataWritebackConfig, validateDataWritebackValues, type DataConnectionRecord, type DataDatasetRecord, type DataWritebackIssue, type DataWritebackRequest, type DataWritebackSnapshot, type DataWritebackValue } from "@bim-studio/contracts";
import { DirectBindingGatewayError, requestControlledHttp, type DirectBindingGatewayOptions } from "./connectorGateway.js";
import { httpConnectionHeaders } from "./dataIntegration.js";

export class DataWritebackError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string, readonly outcome: "not-written" | "unknown" = "not-written", readonly issues?: DataWritebackIssue[]) { super(message); }
}
const strongVersion = (value: unknown): value is string => typeof value === "string" && /^"[\x21\x23-\x7e]{1,200}"$/.test(value);

export class DataWritebackService {
  constructor(private readonly options: DirectBindingGatewayOptions) {}

  async read(connection: DataConnectionRecord, dataset: DataDatasetRecord, recordId: string): Promise<DataWritebackSnapshot> {
    const endpoint = this.endpoint(connection, dataset, recordId);
    try {
      const response = await requestControlledHttp(endpoint, "GET", this.headers(connection), undefined, this.options);
      if (response.status === 404) throw new DataWritebackError(404, "record-not-found", "填报记录不存在");
      if (response.status !== 200) throw new DataWritebackError(502, "record-read-failed", "无法读取填报记录");
      return this.snapshot(response, dataset);
    } catch (error) { throw normalizeError(error, false); }
  }

  async write(connection: DataConnectionRecord, dataset: DataDatasetRecord, recordId: string, body: unknown): Promise<DataWritebackSnapshot> {
    const endpoint = this.endpoint(connection, dataset, recordId);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !["values", "expectedVersion"].includes(key))) throw new DataWritebackError(400, "invalid-request", "填报提交格式无效");
    const input = body as DataWritebackRequest;
    if (!strongVersion(input.expectedVersion)) throw new DataWritebackError(400, "version-required", "请先读取记录的有效版本");
    const issues = validateDataWritebackValues(dataset.writeback!, input.values);
    if (issues.length) throw new DataWritebackError(422, "validation-error", "请修正填报字段", "not-written", issues);
    const current = await this.read(connection, dataset, recordId);
    if (current.version !== input.expectedVersion) throw new DataWritebackError(409, "revision-conflict", "记录已更新，请重新读取并核对草稿");
    const payload = Buffer.from(JSON.stringify(input.values), "utf8");
    const headers = { ...this.headers(connection), "content-type": "application/json", "content-length": String(payload.length), "if-match": input.expectedVersion };
    try {
      const response = await requestControlledHttp(endpoint, "PATCH", headers, payload, this.options);
      if (response.status === 409 || response.status === 412) throw new DataWritebackError(409, "revision-conflict", "记录已更新，请重新读取并核对草稿");
      if (response.status >= 300 && response.status < 400) throw new DataWritebackError(502, "redirect-denied", "写回目标不允许重定向");
      if ([400, 401, 403, 404, 405, 422, 428, 429].includes(response.status)) throw new DataWritebackError(502, "write-rejected", "数据源拒绝写入，请核对配置与记录");
      if (response.status !== 200) throw new DataWritebackError(502, "write-outcome-unknown", "写入结果未确认，请重新读取后核对，勿重复提交", "unknown");
      const result = this.snapshot(response, dataset);
      if (result.version === input.expectedVersion) throw new Error("上游未返回新版本");
      return result;
    } catch (error) { throw normalizeError(error, true); }
  }

  private endpoint(connection: DataConnectionRecord, dataset: DataDatasetRecord, recordId: string): string {
    if (!connection.enabled || connection.type !== "http" || dataset.writeback?.version !== 1 || dataset.connectionId !== connection.id || dataset.projectId !== connection.projectId) throw new DataWritebackError(400, "unsupported-target", "填报仅支持本项目已启用的 HTTP 连接");
    try { assertDataWritebackConfig(dataset.writeback); } catch { throw new DataWritebackError(400, "writeback-not-configured", "数据集尚未配置有效填报目标"); }
    if (!/^[\p{L}\p{N}_-]{1,128}$/u.test(recordId)) throw new DataWritebackError(400, "invalid-record-id", "记录标识无效");
    try {
      const base = new URL(String(connection.config.url));
      if (!/^https?:$/.test(base.protocol) || base.username || base.password || base.hash) throw new Error("invalid URL");
      return new URL(dataset.writeback.recordPath.replace("{id}", encodeURIComponent(recordId)), base.origin).href;
    } catch { throw new DataWritebackError(400, "invalid-target", "填报连接必须配置不含凭据的绝对 HTTP 地址"); }
  }

  private headers(connection: DataConnectionRecord): Record<string, string> {
    try {
      const headers = httpConnectionHeaders(connection);
      if (Object.keys(headers).some(name => ["host", "connection", "content-length", "transfer-encoding", "upgrade", "if-match"].includes(name.toLowerCase()))) throw new Error("reserved header");
      return { ...headers, accept: "application/json" };
    } catch { throw new DataWritebackError(400, "invalid-credential", "填报连接凭据配置无效"); }
  }

  private snapshot(response: { body: Buffer; etag?: string }, dataset: DataDatasetRecord): DataWritebackSnapshot {
    if (!strongVersion(response.etag)) throw new DataWritebackError(502, "version-unsupported", "数据源未返回强 ETag，不能执行受控填报");
    let raw: unknown;
    try { raw = JSON.parse(response.body.toString("utf8")); } catch { throw new DataWritebackError(502, "invalid-record", "数据源未返回有效记录"); }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new DataWritebackError(502, "invalid-record", "数据源记录必须是对象");
    const values: Record<string, DataWritebackValue> = {};
    for (const field of dataset.writeback!.fields) {
      const value = (raw as Record<string, unknown>)[field.key];
      if (value !== undefined && value !== null && !["string", "number", "boolean"].includes(typeof value)) throw new DataWritebackError(502, "invalid-record", "数据源字段类型不支持填报");
      values[field.key] = (value ?? null) as DataWritebackValue;
    }
    return { values, version: response.etag };
  }
}

function normalizeError(error: unknown, submitted: boolean): DataWritebackError {
  if (error instanceof DataWritebackError && (!submitted || ["revision-conflict", "redirect-denied", "write-rejected"].includes(error.code))) return error;
  if (error instanceof DirectBindingGatewayError && ["OUTBOUND_DENIED", "INVALID_BINDING", "CREDENTIAL_NOT_FOUND"].includes(error.code)) return new DataWritebackError(400, "outbound-denied", "填报目标不符合出站访问策略");
  if (submitted) return new DataWritebackError(502, "write-outcome-unknown", "写入结果未确认，请重新读取后核对，勿重复提交", "unknown");
  return new DataWritebackError(502, "record-read-failed", "无法读取填报记录，请检查数据源");
}
