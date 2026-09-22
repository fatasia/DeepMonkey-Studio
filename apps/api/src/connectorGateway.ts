import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import type { LookupFunction } from "node:net";
import { createHash } from "node:crypto";
import { WebSocket as NodeWebSocket, type ClientOptions as WebSocketClientOptions, type RawData } from "ws";
import {
  assertDirectBindingSpec,
  type DirectBindingSpec,
} from "@bim-studio/contracts";
import {
  DirectBindingGatewayError,
  renderTemplate,
  selectDirectBindingValue,
  type DirectBindingGatewayOptions,
  type DirectBindingVariables,
  type DirectCredentialResolver,
  type DirectHttpGatewayResponse,
  type ResolvedAddress,
} from "./connectorBindingValues.js";
export {
  DirectBindingGatewayError,
  renderTemplate,
  selectDirectBindingValue,
} from "./connectorBindingValues.js";
export type {
  DirectBindingErrorCode,
  DirectBindingGatewayOptions,
  DirectBindingOutboundPolicy,
  DirectBindingVariables,
  DirectCredentialResolver,
  DirectHttpGatewayResponse,
  ResolvedDirectCredential,
} from "./connectorBindingValues.js";

interface PreparedTarget { url: URL; address: ResolvedAddress; headers: Record<string, string> }

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_ALLOWED_PORTS = [80, 443] as const;

export class DirectHttpConnectorGateway {
  constructor(private readonly options: DirectBindingGatewayOptions = {}) {}

  async execute(binding: DirectBindingSpec, variables: DirectBindingVariables = {}): Promise<DirectHttpGatewayResponse> {
    validateBinding(binding);
    if (binding.transport !== "http" || !binding.http) {
      throw new DirectBindingGatewayError("INVALID_BINDING", "该网关请求必须使用 HTTP 直接绑定", 400, false);
    }
    const target = await prepareTarget(binding, ["http:", "https:"], this.options);
    for (const [name, template] of Object.entries(binding.http.params ?? {})) {
      target.url.searchParams.set(name, String(renderTemplate(template, variables) ?? ""));
    }
    const bodyValue = binding.http.bodyTemplate === undefined ? undefined : renderTemplate(binding.http.bodyTemplate, variables);
    const body = bodyValue === undefined ? undefined : Buffer.from(
      typeof bodyValue === "string" ? bodyValue : JSON.stringify(bodyValue),
      "utf8"
    );
    const headers: Record<string, string> = { accept: "application/json, text/plain;q=0.9, */*;q=0.1", ...target.headers };
    if (body) {
      headers["content-type"] ??= typeof bodyValue === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8";
      headers["content-length"] = String(body.byteLength);
    }
    const upstream = await requestPinned(target, binding.http.method, headers, body, {
      timeoutMs: this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxResponseBytes: this.options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
    });
    const data = decodeResponse(upstream.body, upstream.contentType);
    if (upstream.status < 200 || upstream.status >= 300) {
      throw new DirectBindingGatewayError(
        "UPSTREAM_ERROR",
        `上游接口返回 HTTP ${upstream.status}`,
        502,
        upstream.status >= 500
      );
    }
    return {
      ok: true,
      status: upstream.status,
      ...(upstream.contentType ? { contentType: upstream.contentType } : {}),
      data,
      value: selectDirectBindingValue(data, binding)
    };
  }
}

interface HttpResponseBytes { status: number; contentType?: string; etag?: string; body: Buffer }

/** 仅供已授权的服务端业务适配器使用；复用 DNS 固定与出站策略，不扩大直接绑定权限。 */
export async function requestControlledHttp(endpoint: string, method: "GET" | "PATCH", headers: Record<string, string>, body: Buffer | undefined, options: DirectBindingGatewayOptions): Promise<HttpResponseBytes> {
  if (!/^https?:\/\//i.test(endpoint)) throw new DirectBindingGatewayError("OUTBOUND_DENIED", "业务写回必须使用绝对 HTTP 地址", 400, false);
  const target = await prepareTarget({ endpoint } as DirectBindingSpec, ["http:", "https:"], options);
  return requestPinned(target, method, headers, body, { timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxResponseBytes: options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES });
}

function requestPinned(
  target: PreparedTarget,
  method: string,
  headers: Record<string, string>,
  body: Buffer | undefined,
  limits: { timeoutMs: number; maxResponseBytes: number }
): Promise<HttpResponseBytes> {
  return new Promise((resolve, reject) => {
    const transport = target.url.protocol === "https:" ? https : http;
    const request = transport.request(target.url, {
      method,
      headers,
      lookup: pinnedLookup(target.address),
      ...(target.url.protocol === "https:" ? { servername: target.url.hostname } : {})
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > limits.maxResponseBytes) {
          response.destroy(new DirectBindingGatewayError("UPSTREAM_TOO_LARGE", "上游响应超过大小限制", 502, false));
          return;
        }
        chunks.push(chunk);
      });
      response.once("end", () => resolve({
        status: response.statusCode ?? 502,
        ...(typeof response.headers.etag === "string" ? { etag: response.headers.etag } : {}),
        ...(typeof response.headers["content-type"] === "string" ? { contentType: response.headers["content-type"] } : {}),
        body: Buffer.concat(chunks)
      }));
      response.once("error", reject);
    });
    request.setTimeout(limits.timeoutMs, () => request.destroy(
      new DirectBindingGatewayError("UPSTREAM_TIMEOUT", "上游接口请求超时", 504, true)
    ));
    request.once("error", (reason) => reject(normalizeUpstreamError(reason)));
    if (body) request.write(body);
    request.end();
  });
}

function pinnedLookup(address: ResolvedAddress): LookupFunction {
  return (_hostname, options, callback) => {
    if (typeof options === "object" && options.all) {
      callback(null, [{ address: address.address, family: address.family }]);
      return;
    }
    callback(null, address.address, address.family);
  };
}

function decodeResponse(body: Buffer, contentType?: string): unknown {
  const text = body.toString("utf8");
  if (contentType?.toLowerCase().includes("json")) {
    try { return JSON.parse(text) as unknown; }
    catch (reason) { throw new DirectBindingGatewayError("UPSTREAM_ERROR", "上游返回了无效 JSON", 502, false, { cause: reason }); }
  }
  return text;
}

function validateBinding(binding: DirectBindingSpec): void {
  try { assertDirectBindingSpec(binding); }
  catch (reason) {
    throw new DirectBindingGatewayError("INVALID_BINDING", reason instanceof Error ? reason.message : "直接绑定格式无效", 400, false, { cause: reason });
  }
  if ((binding.access ?? "read-only") !== "read-only") {
    throw new DirectBindingGatewayError("INVALID_BINDING", "直接绑定仅支持只读访问", 400, false);
  }
}

async function prepareTarget(
  binding: DirectBindingSpec,
  protocols: readonly string[],
  options: DirectBindingGatewayOptions
): Promise<PreparedTarget> {
  let url: URL;
  const internal = binding.endpoint.startsWith("/") && !binding.endpoint.startsWith("//");
  try {
    if (!internal) url = new URL(binding.endpoint);
    else {
      if (!options.internalOrigin) throw new Error("服务器没有配置内部接口 origin");
      const origin = new URL(options.internalOrigin);
      if (protocols.includes("ws:") && (origin.protocol === "http:" || origin.protocol === "https:")) {
        origin.protocol = origin.protocol === "https:" ? "wss:" : "ws:";
      }
      url = new URL(binding.endpoint, origin);
    }
  }
  catch (reason) { throw new DirectBindingGatewayError("INVALID_BINDING", "直接绑定 endpoint 不是有效 URL", 400, false, { cause: reason }); }
  if (!protocols.includes(url.protocol)) denied(`不允许 ${url.protocol} 协议`);
  if (url.username || url.password) denied("URL 中不能包含凭据");
  if (url.hash) denied("URL 中不能包含片段");

  const policy = options.outboundPolicy ?? {};
  const allowedPorts = new Set(policy.allowedPorts ?? DEFAULT_ALLOWED_PORTS);
  const port = Number(url.port || (url.protocol === "http:" || url.protocol === "ws:" ? 80 : 443));
  if (!internal && !allowedPorts.has(port)) denied(`不允许访问端口 ${port}`);
  if (!internal && policy.allowedHostnames?.length && !policy.allowedHostnames.some((allowed) => hostnameMatches(url.hostname, allowed))) {
    denied("目标主机不在出站白名单中");
  }

  const addresses = await resolveAddresses(url.hostname, options.resolveHost);
  if (addresses.length === 0) denied("目标主机没有可用地址");
  if (!internal && addresses.some((item) => !isPublicAddress(item.address))) {
    if (!policy.allowPrivateNetwork) denied("目标主机解析到内网、环回或保留地址");
    if (!policy.allowedHostnames?.length) denied("访问私网目标时必须同时配置主机白名单");
  }
  const headers = binding.credentialRef
    ? await resolveCredential(binding.credentialRef, options.credentialResolver)
    : {};
  return { url, address: addresses[0]!, headers };
}

async function resolveAddresses(hostname: string, resolver?: DirectBindingGatewayOptions["resolveHost"]): Promise<readonly ResolvedAddress[]> {
  const literalFamily = isIP(hostname);
  if (literalFamily === 4 || literalFamily === 6) return [{ address: hostname, family: literalFamily }];
  try {
    if (resolver) return resolver(hostname);
    const records = await dnsLookup(hostname, { all: true, verbatim: true });
    return records.flatMap((record) => record.family === 4 || record.family === 6
      ? [{ address: record.address, family: record.family }]
      : []);
  } catch (reason) {
    throw new DirectBindingGatewayError("UPSTREAM_UNAVAILABLE", "无法解析上游主机", 502, true, { cause: reason });
  }
}

async function resolveCredential(reference: string, resolver?: DirectCredentialResolver): Promise<Record<string, string>> {
  const credential = await resolver?.resolve(reference);
  if (!credential) throw new DirectBindingGatewayError("CREDENTIAL_NOT_FOUND", "找不到直接绑定所引用的服务端凭据", 424, false);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(credential.headers)) {
    const normalized = name.toLowerCase();
    if (["host", "connection", "content-length", "transfer-encoding", "upgrade"].includes(normalized)) {
      throw new DirectBindingGatewayError("INVALID_BINDING", `凭据不能注入 ${name} 请求头`, 500, false);
    }
    headers[normalized] = value;
  }
  return headers;
}

function hostnameMatches(hostname: string, allowed: string): boolean {
  const normalized = hostname.toLowerCase();
  const rule = allowed.toLowerCase();
  return rule.startsWith("*.")
    ? normalized.endsWith(rule.slice(1)) && normalized !== rule.slice(2)
    : normalized === rule;
}

function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const bytes = address.split(".").map(Number);
    const [a = 0, b = 0, c = 0] = bytes;
    return !(
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith("::ffff:")) return isPublicAddress(normalized.slice(7));
    return !(normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") ||
      /^fe[89ab]/.test(normalized) || normalized.startsWith("ff") || normalized.startsWith("2001:db8:"));
  }
  return false;
}

function denied(message: string): never {
  throw new DirectBindingGatewayError("OUTBOUND_DENIED", message, 403, false);
}

function normalizeUpstreamError(reason: unknown): DirectBindingGatewayError {
  if (reason instanceof DirectBindingGatewayError) return reason;
  return new DirectBindingGatewayError("UPSTREAM_UNAVAILABLE", "无法连接上游接口", 502, true, { cause: reason });
}

export type DirectWebSocketState = "connecting" | "open" | "reconnecting" | "closed" | "error";

interface UpstreamSocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  once(event: "open" | "close" | "error", listener: (reason?: unknown) => void): this;
  on(event: "message", listener: (data: RawData | string) => void): this;
}

export interface DirectWebSocketFactoryContext {
  url: string;
  protocols: string[];
  headers: Record<string, string>;
  lookup: LookupFunction;
  servername?: string;
}

export type DirectWebSocketFactory = (context: DirectWebSocketFactoryContext) => UpstreamSocket;

interface WebSocketSubscriber {
  onMessage(data: unknown): void;
  onState?(state: DirectWebSocketState): void;
}

interface SharedUpstream {
  binding: DirectBindingSpec;
  variables: DirectBindingVariables;
  subscribers: Set<WebSocketSubscriber>;
  socket: UpstreamSocket | undefined;
  attempt: number;
  timer?: NodeJS.Timeout;
  stopped: boolean;
}

export class DirectWebSocketMultiplexer {
  private readonly upstreams = new Map<string, SharedUpstream>();
  private readonly factory: DirectWebSocketFactory;

  constructor(private readonly options: DirectBindingGatewayOptions = {}, factory?: DirectWebSocketFactory) {
    this.factory = factory ?? defaultWebSocketFactory;
  }

  subscribe(binding: DirectBindingSpec, variables: DirectBindingVariables, subscriber: WebSocketSubscriber): () => void {
    validateBinding(binding);
    if (binding.transport !== "websocket" || !binding.websocket) {
      throw new DirectBindingGatewayError("INVALID_BINDING", "该订阅必须使用 WebSocket 直接绑定", 400, false);
    }
    const key = websocketKey(binding, variables);
    let upstream = this.upstreams.get(key);
    if (!upstream) {
      upstream = { binding, variables, subscribers: new Set(), socket: undefined, attempt: 0, stopped: false };
      upstream.subscribers.add(subscriber);
      this.upstreams.set(key, upstream);
      void this.connect(key, upstream);
    } else {
      upstream.subscribers.add(subscriber);
    }
    subscriber.onState?.(upstream.socket?.readyState === NodeWebSocket.OPEN ? "open" : "connecting");
    return () => {
      upstream!.subscribers.delete(subscriber);
      if (upstream!.subscribers.size === 0) this.stop(key, upstream!);
    };
  }

  close(): void {
    for (const [key, upstream] of this.upstreams) this.stop(key, upstream);
  }

  get upstreamCount(): number { return this.upstreams.size; }

  private async connect(key: string, upstream: SharedUpstream): Promise<void> {
    if (upstream.stopped || upstream.subscribers.size === 0) return;
    notifyState(upstream, upstream.attempt === 0 ? "connecting" : "reconnecting");
    try {
      const target = await prepareTarget(upstream.binding, ["ws:", "wss:"], this.options);
      if (upstream.stopped || upstream.subscribers.size === 0) return;
      const socket = this.factory({
        url: target.url.toString(),
        protocols: upstream.binding.websocket?.protocols ?? [],
        headers: target.headers,
        lookup: pinnedLookup(target.address),
        ...(target.url.protocol === "wss:" ? { servername: target.url.hostname } : {})
      });
      upstream.socket = socket;
      socket.once("open", () => {
        upstream.attempt = 0;
        notifyState(upstream, "open");
        const message = upstream.binding.websocket?.subscribeMessageTemplate;
        if (message !== undefined) socket.send(JSON.stringify(renderTemplate(message, upstream.variables)));
      });
      socket.on("message", (raw) => {
        const data = parseWebSocketMessage(raw);
        for (const subscriber of upstream.subscribers) subscriber.onMessage(data);
      });
      socket.once("error", () => notifyState(upstream, "error"));
      socket.once("close", () => this.reconnectOrStop(key, upstream));
    } catch {
      notifyState(upstream, "error");
      this.reconnectOrStop(key, upstream);
    }
  }

  private reconnectOrStop(key: string, upstream: SharedUpstream): void {
    upstream.socket = undefined;
    const reconnect = upstream.binding.websocket?.reconnect;
    if (upstream.stopped) return;
    if (upstream.subscribers.size === 0 || !reconnect?.enabled) return this.stop(key, upstream);
    const delay = Math.min(reconnect.maxDelayMs, reconnect.initialDelayMs * reconnect.multiplier ** upstream.attempt);
    upstream.attempt += 1;
    notifyState(upstream, "reconnecting");
    upstream.timer = setTimeout(() => void this.connect(key, upstream), delay);
  }

  private stop(key: string, upstream: SharedUpstream): void {
    upstream.stopped = true;
    if (upstream.timer) clearTimeout(upstream.timer);
    upstream.socket?.close();
    notifyState(upstream, "closed");
    this.upstreams.delete(key);
  }
}

function defaultWebSocketFactory(context: DirectWebSocketFactoryContext): UpstreamSocket {
  const options: WebSocketClientOptions & { lookup: LookupFunction } = {
    headers: context.headers,
    lookup: context.lookup,
    ...(context.servername ? { servername: context.servername } : {})
  };
  return new NodeWebSocket(context.url, context.protocols, options);
}

function websocketKey(binding: DirectBindingSpec, variables: DirectBindingVariables): string {
  const shared = {
    endpoint: binding.endpoint,
    credentialRef: binding.credentialRef,
    protocols: binding.websocket?.protocols,
    subscribeMessage: binding.websocket?.subscribeMessageTemplate === undefined
      ? undefined
      : renderTemplate(binding.websocket.subscribeMessageTemplate, variables)
  };
  return createHash("sha256").update(JSON.stringify(shared)).digest("hex");
}

function parseWebSocketMessage(raw: RawData | string): unknown {
  const text = typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : Buffer.from(raw as ArrayBuffer).toString("utf8");
  try { return JSON.parse(text) as unknown; }
  catch { return text; }
}

function notifyState(upstream: SharedUpstream, state: DirectWebSocketState): void {
  for (const subscriber of upstream.subscribers) subscriber.onState?.(state);
}
