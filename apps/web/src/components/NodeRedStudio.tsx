import { useEffect, useState } from "react";
import { Check, Copy, ExternalLink, Gauge, LoaderCircle, PlugZap, Radio, RefreshCw, Workflow } from "lucide-react";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";
import "./NodeRedStudio.css";
import { fetchNodeRedHealth } from "../api";

export const NODE_RED_EDITOR_PATH = "/node-red/";
export const NODE_RED_DASHBOARD_PATH = "/iot/dashboard/";
export const NODE_RED_HTTP_INGRESS_PATH = "/iot/scene";
export const NODE_RED_WEBSOCKET_PATH = "/iot/ws/scene";

export function NodeRedStudio({ locale }: { locale: AppLocale }) {
  const [copied, setCopied] = useState<"http" | "websocket">();
  // Node-RED 独立进程，未启动时 iframe 是白屏（U1-8c）；轮询健康接口给出明确离线态。
  const [online, setOnline] = useState<boolean | undefined>(undefined);
  const [healthError, setHealthError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [copyError, setCopyError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    const controller = new AbortController();
    const check = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const health = await fetchNodeRedHealth(AbortSignal.any([controller.signal, AbortSignal.timeout(4_000)]));
        if (!cancelled) { setOnline(health.online); setHealthError(false); }
      } catch {
        if (!cancelled) { setOnline(undefined); setHealthError(true); }
      } finally { inFlight = false; }
    };
    void check();
    const timer = window.setInterval(check, 15_000);
    return () => { cancelled = true; controller.abort(); window.clearInterval(timer); };
  }, [retry]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(undefined), 1_500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function copyGateway(kind: "http" | "websocket") {
    const urls = nodeRedGatewayUrls(window.location.origin);
    try {
      await navigator.clipboard.writeText(kind === "http" ? urls.httpIngress : urls.websocketConsumer);
      setCopied(kind);
      setCopyError(false);
    } catch { setCopied(undefined); setCopyError(true); }
  }

  return (
    <section className="node-red-studio">
      <header className="node-red-studio__header">
        <div>
          <span className="node-red-studio__eyebrow">
            <Workflow size={14} />
            NODE-RED
          </span>
          <strong>{tr(locale, "高级事件编排", "Advanced event orchestration")}</strong>
          <small>
            {tr(
              locale,
              "独立运行时：触发、路由、设备协议、状态与子流程。离线时请由管理员按部署文档检查外部 Node-RED 服务与反向代理。",
              "Separate runtime for triggers, routing, device protocols, state and subflows. If offline, ask an administrator to check the external Node-RED service and reverse proxy in the deployment guide.",
            )}
          </small>
        </div>
        <nav>
          <a href={NODE_RED_DASHBOARD_PATH} target="_blank" rel="noreferrer">
            <Gauge size={14} />
            {tr(locale, "运行看板", "Runtime dashboard")}
          </a>
          <a className="primary" href={NODE_RED_EDITOR_PATH} target="_blank" rel="noreferrer">
            <ExternalLink size={14} />
            {tr(locale, "新窗口打开", "Open in new window")}
          </a>
        </nav>
      </header>
      <div className="node-red-studio__notice">
        <strong>{tr(locale, "能力边界", "Capability boundary")}</strong>
        <span>
          {tr(
            locale,
            "这里接入的是随项目部署的 Node-RED，不等同于平台内置的轻量数据流水线；可用节点取决于已安装的节点包。",
            "This embeds the separately deployed Node-RED runtime, not the platform's lightweight native pipeline. Available nodes depend on installed node packages.",
          )}
        </span>
      </div>
      <section className="node-red-gateway" aria-label={tr(locale, "Node-RED 场景数据网关", "Node-RED scene data gateway")}>
        <header>
          <span>
            <Radio size={14} />
            <strong>{tr(locale, "平台消费入口", "Platform gateway")}</strong>
          </span>
          <small>
            {tr(
              locale,
              "Node-RED 负责长尾协议适配，平台继续消费统一场景消息。",
              "Node-RED adapts long-tail protocols while the platform keeps consuming one scene-message contract.",
            )}
          </small>
        </header>
        <div>
          <article>
            <span>
              <strong>HTTP POST</strong>
              <small>{tr(locale, "外部系统 / Node-RED 写入", "External systems / Node-RED write")}</small>
            </span>
            <code>{NODE_RED_HTTP_INGRESS_PATH}</code>
            <button type="button" aria-label={tr(locale, "复制 HTTP 地址", "Copy HTTP URL")} onClick={() => void copyGateway("http")}>
              {copied === "http" ? <Check size={13} /> : <Copy size={13} />}
              {copied === "http" ? tr(locale, "已复制", "Copied") : tr(locale, "复制完整地址", "Copy URL")}
            </button>
          </article>
          <article>
            <span>
              <strong>WebSocket</strong>
              <small>{tr(locale, "场景运行时订阅", "Scene runtime subscribes")}</small>
            </span>
            <code>{NODE_RED_WEBSOCKET_PATH}</code>
            <button type="button" aria-label={tr(locale, "复制 WebSocket 地址", "Copy WebSocket URL")} onClick={() => void copyGateway("websocket")}>
              {copied === "websocket" ? <Check size={13} /> : <Copy size={13} />}
              {copied === "websocket" ? tr(locale, "已复制", "Copied") : tr(locale, "复制完整地址", "Copy URL")}
            </button>
          </article>
        </div>
        {copyError && <p role="alert">{tr(locale, "复制失败，请检查浏览器剪贴板权限后重试", "Copy failed. Check clipboard permissions and retry.")}</p>}
        <p>
          {tr(
            locale,
            "MQTT、TCP、UDP 等设备协议在 Node-RED 内接入后，统一转为 HTTP POST 消息；核心数据库、HTTP、WebSocket、MQTT、OPC UA、Modbus 与 Kafka 连接器仍由平台原生维护。",
            "Connect MQTT, TCP, UDP and other device protocols in Node-RED, then forward a normalized HTTP POST message. Core database, HTTP, WebSocket, MQTT, OPC UA, Modbus and Kafka connectors remain native platform capabilities.",
          )}
        </p>
      </section>
      {online !== true ? (
        <div className="node-red-studio__offline" role="status">
          {online === undefined && !healthError ? <LoaderCircle className="spin" size={20} /> : <PlugZap size={20} />}
          <strong>{healthError ? tr(locale, "暂时无法确认服务状态", "Service status could not be checked") : online === undefined ? tr(locale, "正在检查 Node-RED 服务", "Checking Node-RED service") : tr(locale, "Node-RED 服务未运行", "Node-RED service is not running")}</strong>
          <span>{healthError ? tr(locale, "请检查网络或会话后重试；检查失败不代表 Node-RED 已停止。", "Check your connection or session and retry. A failed check does not mean Node-RED is stopped.") : online === false ? tr(locale, "高级事件编排依赖独立的 Node-RED 进程；请先在服务器上启动它（默认端口 1880），启动后本页会自动恢复。", "Start the separate Node-RED service (default port 1880); this page recovers automatically.") : tr(locale, "确认服务可用后自动打开编辑器。", "The editor opens automatically once the service is available.")}</span>
          {(healthError || online === false) && <button className="button" onClick={() => { setHealthError(false); setOnline(undefined); setRetry(value => value + 1); }}><RefreshCw size={14} />{tr(locale, "重新检查", "Check again")}</button>}
        </div>
      ) : (
        <iframe
          className="node-red-studio__frame"
          src={NODE_RED_EDITOR_PATH}
          title={tr(locale, "Node-RED 高级事件编排", "Node-RED advanced event orchestration")}
          // 同源部署的受信任管理界面；scripts + same-origin 的 sandbox 并不形成隔离。
        />
      )}
    </section>
  );
}

export function nodeRedGatewayUrls(origin: string): { httpIngress: string; websocketConsumer: string } {
  const httpIngress = new URL(NODE_RED_HTTP_INGRESS_PATH, origin).href;
  const websocket = new URL(NODE_RED_WEBSOCKET_PATH, origin);
  websocket.protocol = websocket.protocol === "https:" ? "wss:" : "ws:";
  return { httpIngress, websocketConsumer: websocket.href };
}
