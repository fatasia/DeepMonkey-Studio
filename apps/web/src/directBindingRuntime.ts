import type { DirectBindingSpec, DirectBindingTemplateValue } from "@bim-studio/contracts";
import { api, openDirectBindingWebSocket } from "./api";

export type DirectBindingRuntimeStatus = "idle" | "loading" | "connecting" | "online" | "reconnecting" | "error" | "stopped";
export type DirectBindingVariables = Record<string, DirectBindingTemplateValue>;

export interface DirectBindingRuntimeHandlers {
  onValue(value: unknown, data: unknown): void;
  onStatus?(status: DirectBindingRuntimeStatus): void;
  onError?(message: string): void;
}

interface BrowserSocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "message" | "error" | "close", listener: (event: Event | MessageEvent) => void): void;
}

export interface DirectBindingRuntimeDependencies {
  executeHttp(binding: DirectBindingSpec, variables: DirectBindingVariables): Promise<{ data: unknown; value: unknown }>;
  createWebSocket(url: string, protocols: string[]): BrowserSocket;
  resolveWebSocketUrl(): string;
  authToken(): string | undefined;
  setTimer(callback: () => void, delayMs: number): number;
  clearTimer(timer: number): void;
}

const defaultDependencies: DirectBindingRuntimeDependencies = {
  executeHttp: (binding, variables) => api.executeDirectBinding(binding, variables),
  createWebSocket: () => openDirectBindingWebSocket(),
  resolveWebSocketUrl: () => "",
  authToken: () => undefined,
  setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimer: (timer) => window.clearTimeout(timer)
};

export class DirectBindingRuntime {
  private active = false;
  private timer: number | undefined;
  private socket: BrowserSocket | undefined;
  private reconnectAttempt = 0;

  constructor(
    readonly binding: DirectBindingSpec,
    private readonly variables: DirectBindingVariables,
    private readonly handlers: DirectBindingRuntimeHandlers,
    private readonly dependencies: DirectBindingRuntimeDependencies = defaultDependencies
  ) {}

  start(): () => void {
    if (this.active) return () => this.stop();
    this.active = true;
    if (this.binding.transport === "http") this.startHttp();
    else this.connectWebSocket();
    return () => this.stop();
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    if (this.timer !== undefined) this.dependencies.clearTimer(this.timer);
    this.timer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
    this.handlers.onStatus?.("stopped");
  }

  private startHttp(): void {
    const refresh = this.binding.http?.refresh;
    if (!refresh) return this.fail("HTTP 直接绑定缺少刷新策略");
    if (refresh.immediate === false) this.scheduleHttp(refresh.intervalMs);
    else void this.pollHttp();
  }

  private async pollHttp(): Promise<void> {
    if (!this.active) return;
    this.handlers.onStatus?.("loading");
    try {
      const response = await this.dependencies.executeHttp(this.binding, this.variables);
      if (!this.active) return;
      this.handlers.onValue(response.value, response.data);
      this.handlers.onStatus?.("online");
    } catch (reason) {
      if (!this.active) return;
      this.handlers.onError?.(errorMessage(reason));
      this.handlers.onStatus?.("error");
    }
    if (this.active) this.scheduleHttp(this.binding.http!.refresh.intervalMs);
  }

  private scheduleHttp(delayMs: number): void {
    this.timer = this.dependencies.setTimer(() => {
      this.timer = undefined;
      void this.pollHttp();
    }, delayMs);
  }

  private connectWebSocket(): void {
    if (!this.active) return;
    this.handlers.onStatus?.(this.reconnectAttempt > 0 ? "reconnecting" : "connecting");
    const token = this.dependencies.authToken();
    const protocols = token ? [`bim-studio-auth.${token}`] : [];
    let socket: BrowserSocket;
    try {
      socket = this.dependencies.createWebSocket(this.dependencies.resolveWebSocketUrl(), protocols);
      this.socket = socket;
    } catch (reason) {
      this.fail(errorMessage(reason));
      return this.scheduleReconnect();
    }
    socket.addEventListener("open", () => {
      if (!this.active || this.socket !== socket) return;
      socket.send(JSON.stringify({ type: "subscribe", requestId: "runtime", binding: this.binding, variables: this.variables }));
    });
    socket.addEventListener("message", (event) => {
      if (!this.active || this.socket !== socket) return;
      try {
        const message = JSON.parse(String((event as MessageEvent).data)) as DirectGatewayWebSocketMessage;
        if (message.type === "data") {
          this.reconnectAttempt = 0;
          this.handlers.onValue(message.value, message.data);
          this.handlers.onStatus?.("online");
        } else if (message.type === "state") {
          this.handlers.onStatus?.(gatewayState(message.state));
        } else if (message.type === "error") {
          this.handlers.onError?.(message.error?.message ?? "直接绑定 WebSocket 返回错误");
          this.handlers.onStatus?.("error");
        }
      } catch (reason) {
        this.fail(`无法解析直接绑定消息：${errorMessage(reason)}`);
      }
    });
    socket.addEventListener("error", () => this.fail("直接绑定 WebSocket 连接失败"));
    socket.addEventListener("close", () => {
      if (!this.active || this.socket !== socket) return;
      this.socket = undefined;
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    const policy = this.binding.websocket?.reconnect;
    if (!this.active || !policy?.enabled) return;
    const delay = Math.min(policy.maxDelayMs, policy.initialDelayMs * policy.multiplier ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.handlers.onStatus?.("reconnecting");
    this.timer = this.dependencies.setTimer(() => {
      this.timer = undefined;
      this.connectWebSocket();
    }, delay);
  }

  private fail(message: string): void {
    this.handlers.onError?.(message);
    this.handlers.onStatus?.("error");
  }
}

interface DirectGatewayWebSocketMessage {
  type?: "subscribed" | "state" | "data" | "error";
  state?: "connecting" | "open" | "reconnecting" | "closed" | "error";
  data?: unknown;
  value?: unknown;
  error?: { message?: string };
}

function gatewayState(state: DirectGatewayWebSocketMessage["state"]): DirectBindingRuntimeStatus {
  if (state === "open") return "online";
  if (state === "reconnecting") return "reconnecting";
  if (state === "error") return "error";
  if (state === "closed") return "stopped";
  return "connecting";
}

export async function testDirectBinding(binding: DirectBindingSpec, variables: DirectBindingVariables = {}, timeoutMs = 8_000): Promise<unknown> {
  if (binding.transport === "http") return (await api.executeDirectBinding(binding, variables)).value;
  return new Promise((resolve, reject) => {
    let settled = false;
    const runtime = new DirectBindingRuntime(binding, variables, {
      onValue: (value) => finish(() => resolve(value)),
      onError: (message) => finish(() => reject(new Error(message)))
    });
    let stop = () => runtime.stop();
    const timeout = window.setTimeout(() => finish(() => reject(new Error("WebSocket 测试连接超时"))), timeoutMs);
    stop = runtime.start();
    function finish(action: () => void) {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      stop();
      action();
    }
  });
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
