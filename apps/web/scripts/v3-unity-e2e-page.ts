// V3 Unity WebGL 托管端到端的浏览器侧宿主：复用产品真实模块 unityBridge.ts（parseUnityBuildManifest /
// readUnityBridgeEvent / unityHostMessage / resolveUnityDataLayers），按 UnitySceneEmbed 的合同驱动
// 跨源 iframe 内的真实 Unity WASM Player：加载进度 → ready → init/ping/action 下发 → ack/health/capabilities 收集。
// 页面只驱动与记录，不做任何静默回退；所有判定证据经 window.__v3 交回 runner。
import {
  parseUnityBuildManifest,
  readUnityBridgeEvent,
  resolveUnityDataLayers,
  unityHostMessage,
  type UnityBridgeEventMessage,
} from "../src/unityBridge";

declare global {
  interface Window {
    __v3?: {
      manifest?: unknown;
      manifestError?: string;
      progress: number[];
      ready: boolean;
      capabilities: string[];
      acks: Array<{ messageId: string; messageType: string; at: number }>;
      health?: { fps: number; scene: string; at: number };
      events: Array<{ eventName: string; payload: unknown; at: number }>;
      errors: string[];
      sent: Array<{ type: string; messageId: string; at: number }>;
      finished: boolean;
      failure?: string;
    };
  }
}

const state = {
  progress: [] as number[],
  ready: false,
  capabilities: [] as string[],
  acks: [] as Array<{ messageId: string; messageType: string; at: number }>,
  events: [] as Array<{ eventName: string; payload: unknown; at: number }>,
  errors: [] as string[],
  sent: [] as Array<{ type: string; messageId: string; at: number }>,
  finished: false,
};
window.__v3 = state as NonNullable<Window["__v3"]>;

(async () => {
  try {
    const query = new URLSearchParams(window.location.search);
    const manifestUrl = query.get("manifest");
    if (!manifestUrl) throw new Error("缺少 manifest 查询参数");
    const fallbackOrigin = new URL(manifestUrl).origin;
    const allowedOrigin = query.get("allowedOrigin") || fallbackOrigin;

    // 第 1 步：与产品同一条 manifest 拉取+解析合同（getUnityBuildManifest → parseUnityBuildManifest）。
    const raw = await fetch(manifestUrl).then((response) => {
      if (!response.ok) throw new Error(`manifest 拉取失败 HTTP ${response.status}`);
      return response.json();
    });
    const manifest = parseUnityBuildManifest(raw, manifestUrl);
    state.manifest = manifest;
    const playerUrl = manifest.playerUrl;
    const targetOrigin = new URL(playerUrl).origin;

    // 第 2 步：跨源 iframe 加载真实 Unity Player（sandbox 与 UnitySceneEmbed 同款合同）。
    const viewport = document.getElementById("viewport")!;
    const iframe = document.createElement("iframe");
    iframe.src = playerUrl;
    iframe.title = "Unity WebGL V3";
    iframe.setAttribute("sandbox", "allow-scripts allow-same-origin allow-pointer-lock allow-downloads");
    iframe.setAttribute("allow", "fullscreen; gamepad; autoplay");
    viewport.appendChild(iframe);

    let sequence = 0;
    const pending = new Map<string, { type: string }>();
    const send = (type: Parameters<typeof unityHostMessage>[0], payload: unknown) => {
      const messageId = `v3:${++sequence}`;
      iframe.contentWindow?.postMessage(
        unityHostMessage(type, "v3-unity-e2e", payload as never, messageId),
        targetOrigin,
      );
      state.sent.push({ type, messageId, at: Date.now() });
      pending.set(messageId, { type });
      return messageId;
    };

    const messageFilter = (event: MessageEvent) => {
      if (event.origin !== targetOrigin || event.source !== iframe.contentWindow) return;
      const message: UnityBridgeEventMessage | undefined = readUnityBridgeEvent(event.data);
      if (!message) return;
      if (message.type === "load-progress") state.progress.push(message.progress ?? -1);
      else if (message.type === "ready") {
        state.ready = true;
        // 第 3 步：ready 后按产品合同下发 init（含资源数据层 telemetry），再 ping（health）与 action focus（ack）。
        send("init", {
          scene: manifest.scenes?.[0] ?? "",
          parameters: {},
          filters: {},
          data: null,
          dataLayers: resolveUnityDataLayers(
            (manifest.dataLayers ?? []).map((layer) => ({ layerKey: layer.key, dataKey: layer.key })),
            { "telemetry.temperature": 78.5 },
            {},
            undefined,
          ),
          properties: {},
          manifest,
        });
        window.setTimeout(() => send("ping", { requestedAt: Date.now() }), 300);
        window.setTimeout(() => send("action", { action: "focus", objectId: manifest.objects?.[0]?.id ?? null, value: null }), 700);
        window.setTimeout(() => { state.finished = true; }, 1600);
      } else if (message.type === "ack") {
        state.acks.push({ messageId: message.messageId ?? "", messageType: message.messageType ?? "", at: Date.now() });
        pending.delete(message.messageId ?? "");
      } else if (message.type === "health") {
        state.health = { fps: message.fps ?? 0, scene: message.scene ?? "", at: Date.now() };
      } else if (message.type === "capabilities") {
        state.capabilities = message.capabilities ?? [];
      } else if (message.type === "event") {
        state.events.push({ eventName: message.eventName ?? "", payload: message.payload, at: Date.now() });
      } else if (message.type === "error") {
        state.errors.push(message.message ?? "unknown");
      }
    };
    window.addEventListener("message", messageFilter);
  } catch (reason) {
    state.manifestError = reason instanceof Error ? reason.message : String(reason);
    state.failure = state.manifestError;
  }
})();
