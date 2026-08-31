import { AlertTriangle, Box, LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { DashboardDataWidgetConfig, JsonValue, UnityRuntimeCapability } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import {
  parseUnityBuildManifest,
  readUnityBridgeEvent,
  resolveUnityDataLayers,
  unityHostMessage,
  unityTargetOrigin,
  type UnityBuildManifest,
  type UnityBridgeHostMessage,
} from "../unityBridge";

type UnityRuntimeState = "loading" | "ready" | "degraded" | "error";
const EMPTY_RUNTIME_CAPABILITIES: UnityRuntimeCapability[] = [];

export interface UnityRuntimeStatusDetail {
  widgetId: string;
  state: UnityRuntimeState;
  message?: string;
  latencyMs?: number;
  fps?: number;
  scene?: string;
  lastHealthAt?: number;
  capabilities?: UnityRuntimeCapability[];
}

interface Props {
  locale: AppLocale;
  widgetId: string;
  widget: DashboardDataWidgetConfig;
  variables: Readonly<Record<string, JsonValue>>;
  filters: Readonly<Record<string, JsonValue>>;
  data?: JsonValue;
  dataContext?: JsonValue;
  compact: boolean;
  onEvent: (eventName: string, payload: JsonValue | undefined) => void;
}

/** Unity 作为可观测运行时接入：消息可确认，心跳异常可恢复，业务数据仍由平台统一管理。 */
export function UnitySceneEmbed(props: Props) {
  const { locale, widgetId, widget, variables, filters, data, dataContext, compact, onEvent } = props;
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const sequenceRef = useRef(0);
  const pendingRef = useRef(new Map<string, { startedAt: number; timeout: number }>());
  const [state, setState] = useState<UnityRuntimeState>("loading");
  const [error, setError] = useState<string>();
  const [manifest, setManifest] = useState<UnityBuildManifest>();
  const [playerUrl, setPlayerUrl] = useState(widget.unityUrl ?? "");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [capabilities, setCapabilities] = useState<UnityRuntimeCapability[]>([]);
  const [telemetry, setTelemetry] = useState<Omit<UnityRuntimeStatusDetail, "widgetId" | "state">>({});
  const targetOrigin = useMemo(
    () => unityTargetOrigin(playerUrl, widget.unityAllowedOrigin),
    [playerUrl, widget.unityAllowedOrigin],
  );
  const dataLayers = useMemo(
    () => resolveUnityDataLayers(widget.unityDataBindings, variables, filters, dataContext ?? data),
    [data, dataContext, filters, variables, widget.unityDataBindings],
  );
  const initPayload = useMemo<JsonValue>(
    () => ({
      scene: widget.unityScene ?? "",
      parameters: variables,
      filters,
      data: data ?? null,
      dataContext: dataContext ?? data ?? null,
      dataLayers,
      defaultAction: widget.unityDefaultAction ?? null,
      properties: widget.unityPropertyValues ?? {},
      manifest: manifest ? (structuredClone(manifest) as unknown as JsonValue) : null,
    }),
    [data, dataContext, dataLayers, filters, manifest, variables, widget.unityDefaultAction, widget.unityPropertyValues, widget.unityScene],
  );
  const runtimeCapabilities = useMemo(
    () => capabilities.length ? capabilities : (manifest?.runtimeCapabilities ?? EMPTY_RUNTIME_CAPABILITIES),
    [capabilities, manifest?.runtimeCapabilities],
  );
  const supportsAck = runtimeCapabilities.includes("ack");
  const supportsHeartbeat = runtimeCapabilities.includes("heartbeat");
  const connected = state === "ready" || state === "degraded";

  useEffect(() => {
    const detail: UnityRuntimeStatusDetail = {
      widgetId,
      state,
      ...telemetry,
      ...(error ? { message: error } : {}),
      ...(runtimeCapabilities.length ? { capabilities: runtimeCapabilities } : {}),
    };
    window.dispatchEvent(new CustomEvent("bim-studio:unity-status", { detail }));
  }, [error, runtimeCapabilities, state, telemetry, widgetId]);

  useEffect(() => {
    clearPendingMessages();
    if (!widget.unityManifestUrl) {
      setManifest(undefined);
      setCapabilities([]);
      setPlayerUrl(widget.unityUrl ?? "");
      return;
    }
    let cancelled = false;
    setState("loading");
    setError(undefined);
    void import("../api")
      .then(({ api }) => api.getUnityBuildManifest(widget.unityManifestUrl!))
      .then((value) => parseUnityBuildManifest(value, widget.unityManifestUrl!))
      .then((next) => {
        if (cancelled) return;
        setManifest(next);
        setCapabilities(next.runtimeCapabilities ?? []);
        setPlayerUrl(widget.unityUrl?.trim() || next.playerUrl);
      })
      .catch((reason) => {
        if (!cancelled) fail(reason);
      });
    return () => {
      cancelled = true;
    };
  }, [loadAttempt, widget.unityManifestUrl, widget.unityUrl]);

  useEffect(() => {
    if (state !== "loading" || !playerUrl) return;
    const timeout = window.setTimeout(() => {
      setState("error");
      setError(
        tr(
          locale,
          "Unity Bridge 启动超时，请检查构建压缩格式、MIME/CSP 或网络后重试。",
          "Unity Bridge timed out. Check build compression, MIME/CSP, or network, then retry.",
        ),
      );
    }, 20_000);
    return () => window.clearTimeout(timeout);
  }, [loadAttempt, locale, playerUrl, state]);

  useEffect(() => () => clearPendingMessages(), []);

  function fail(reason: unknown) {
    setState("error");
    setError(reason instanceof Error ? reason.message : String(reason));
  }

  function retry() {
    clearPendingMessages();
    setError(undefined);
    setTelemetry({});
    setState("loading");
    setLoadAttempt((current) => current + 1);
  }

  function clearPendingMessages() {
    for (const pending of pendingRef.current.values()) window.clearTimeout(pending.timeout);
    pendingRef.current.clear();
  }

  function send(type: UnityBridgeHostMessage["type"], payload: JsonValue) {
    const target = iframeRef.current?.contentWindow;
    if (!targetOrigin || !target) return;
    const messageId = `${widgetId}:${++sequenceRef.current}`;
    target.postMessage(unityHostMessage(type, widgetId, payload, messageId), targetOrigin);
    if (!supportsAck) return;
    const timeout = window.setTimeout(() => {
      pendingRef.current.delete(messageId);
      setState((current) => (current === "error" ? current : "degraded"));
      setError(
        tr(
          locale,
          "Unity 已连接，但消息确认超时；正在继续探测运行状态。",
          "Unity is connected, but message acknowledgement timed out; health probing continues.",
        ),
      );
    }, 4_000);
    pendingRef.current.set(messageId, { startedAt: performance.now(), timeout });
  }

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (!targetOrigin || event.origin !== targetOrigin || event.source !== iframeRef.current?.contentWindow) return;
      const message = readUnityBridgeEvent(event.data);
      if (!message || (message.widgetId && message.widgetId !== widgetId)) return;
      if (message.type === "ready") {
        setState("ready");
        setError(undefined);
        send("init", initPayload);
      } else if (message.type === "event") {
        onEvent(message.eventName!, message.payload);
      } else if (message.type === "ack") {
        acknowledge(message.messageId!);
      } else if (message.type === "health") {
        setTelemetry((current) => ({
          ...current,
          ...(message.fps !== undefined ? { fps: message.fps } : {}),
          ...(message.scene ? { scene: message.scene } : {}),
          lastHealthAt: Date.now(),
        }));
        setState("ready");
        setError(undefined);
      } else if (message.type === "capabilities") {
        setCapabilities(message.capabilities ?? []);
      } else {
        fail(message.message || tr(locale, "Unity 场景报告运行错误", "Unity scene reported a runtime error"));
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [initPayload, locale, onEvent, supportsAck, targetOrigin, widgetId]);

  function acknowledge(messageId: string) {
    const pending = pendingRef.current.get(messageId);
    if (!pending) return;
    window.clearTimeout(pending.timeout);
    pendingRef.current.delete(messageId);
    setTelemetry((current) => ({ ...current, latencyMs: Math.max(0, performance.now() - pending.startedAt) }));
    if (pendingRef.current.size === 0) {
      setState("ready");
      setError(undefined);
    }
  }

  useEffect(() => {
    if (!connected || !supportsHeartbeat) return;
    const timer = window.setInterval(() => send("ping", { requestedAt: Date.now() }), 5_000);
    return () => window.clearInterval(timer);
  }, [connected, locale, supportsAck, supportsHeartbeat, targetOrigin, widgetId]);

  useEffect(() => {
    if (connected) send("parameters", { variables, filters, dataLayers });
  }, [connected, dataLayers, filters, variables]);
  useEffect(() => {
    if (connected) send("data", data ?? null);
  }, [connected, data]);
  useEffect(() => {
    if (connected) send("dataLayers", dataLayers);
  }, [connected, dataLayers]);
  useEffect(() => {
    if (connected) send("properties", widget.unityPropertyValues ?? {});
  }, [connected, widget.unityPropertyValues]);
  useEffect(() => {
    if (connected) send("scene", widget.unityScene ?? "");
  }, [connected, widget.unityScene]);

  useEffect(() => {
    const receiveAction = (event: Event) => {
      const detail = (event as CustomEvent<{ widgetId?: string; action?: string; objectId?: string; value?: JsonValue }>).detail;
      if (!detail || detail.widgetId !== widgetId || !detail.action) return;
      send("action", { action: detail.action, objectId: detail.objectId ?? null, value: detail.value ?? null });
    };
    window.addEventListener("bim-studio:unity-action", receiveAction);
    return () => window.removeEventListener("bim-studio:unity-action", receiveAction);
  }, [locale, supportsAck, targetOrigin, widgetId]);

  if (!playerUrl || !targetOrigin) {
    return (
      <div className="unity-scene-empty">
        {state === "error" ? <AlertTriangle /> : <Box />}
        <strong>
          {state === "error"
            ? tr(locale, "Unity 构建清单不可用", "Unity build manifest unavailable")
            : tr(locale, "配置 Unity WebGL 场景", "Configure a Unity WebGL scene")}
        </strong>
        <span>
          {error ??
            tr(
              locale,
              "填写 Unity 构建清单或已接入 Bridge 的 HTTPS 播放地址。",
              "Enter a Unity build manifest or an HTTPS player URL with the Bridge.",
            )}
        </span>
        {state === "error" && (
          <button onClick={retry}><RefreshCw size={13} />{tr(locale, "重试", "Retry")}</button>
        )}
      </div>
    );
  }

  return (
    <div className={`unity-scene-embed ${compact ? "editing" : "runtime"}`}>
      <iframe
        key={`${playerUrl}:${loadAttempt}`}
        ref={iframeRef}
        src={playerUrl}
        title={widget.title || "Unity WebGL"}
        sandbox="allow-scripts allow-same-origin allow-pointer-lock allow-downloads"
        allow="fullscreen; gamepad; autoplay; clipboard-read; clipboard-write"
        onLoad={() => setState("loading")}
      />
      {state === "loading" && (
        <div className="unity-scene-state"><LoaderCircle className="spin" />{tr(locale, "等待 Unity Bridge 就绪", "Waiting for Unity Bridge")}</div>
      )}
      {state === "error" && (
        <div className="unity-scene-state error"><AlertTriangle /><span>{error}</span><button onClick={retry}><RefreshCw size={13} />{tr(locale, "重试", "Retry")}</button></div>
      )}
      {state === "degraded" && <div className="unity-runtime-warning"><AlertTriangle size={13} />{error}</div>}
      {compact && <i>{tr(locale, "设计模式下 Unity 输入已隔离", "Unity input is isolated in design mode")}</i>}
    </div>
  );
}
