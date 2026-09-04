import { useEffect, useState } from "react";
import { Check, Copy, ExternalLink, Gauge, PlugZap, Radio, Workflow } from "lucide-react";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";
import "./NodeRedStudio.css";

export const NODE_RED_EDITOR_PATH = "/node-red/";
export const NODE_RED_DASHBOARD_PATH = "/iot/dashboard/";
export const NODE_RED_HTTP_INGRESS_PATH = "/iot/scene";
export const NODE_RED_WEBSOCKET_PATH = "/iot/ws/scene";

export function NodeRedStudio({ locale }: { locale: AppLocale }) {
  const [copied, setCopied] = useState<"http" | "websocket">();
  // Node-RED 独立进程，未启动时 iframe 是白屏（U1-8c）；轮询健康接口给出明确离线态。
  const [online, setOnline] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const response = await fetch("/api/node-red/health", { signal: AbortSignal.timeout(4_000) });
        const body = await response.json().catch(() => null);
        if (!cancelled) setOnline(Boolean(body?.online));
      } catch {
        if (!cancelled) setOnline(false);
      }
    };
    void check();
    const timer = window.setInterval(check, 15_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

  async function copyGateway(kind: "http" | "websocket") {
    const urls = nodeRedGatewayUrls(window.location.origin);
    await navigator.clipboard.writeText(kind === "http" ? urls.httpIngress : urls.websocketConsumer);
    setCopied(kind);
    window.setTimeout(() => setCopied((current) => (current === kind ? undefined : current)), 1_500);
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
            <button type="button" onClick={() => void copyGateway("http")}>
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
            <button type="button" onClick={() => void copyGateway("websocket")}>
              {copied === "websocket" ? <Check size={13} /> : <Copy size={13} />}
              {copied === "websocket" ? tr(locale, "已复制", "Copied") : tr(locale, "复制完整地址", "Copy URL")}
            </button>
          </article>
        </div>
        <p>
          {tr(
            locale,
            "MQTT、TCP、UDP 等设备协议在 Node-RED 内接入后，统一转为 HTTP POST 消息；核心数据库、HTTP、WebSocket、MQTT、OPC UA、Modbus 与 Kafka 连接器仍由平台原生维护。",
            "Connect MQTT, TCP, UDP and other device protocols in Node-RED, then forward a normalized HTTP POST message. Core database, HTTP, WebSocket, MQTT, OPC UA, Modbus and Kafka connectors remain native platform capabilities.",
          )}
        </p>
      </section>
      {online === false ? (
        <div className="node-red-studio__offline" role="status">
          <PlugZap size={20} />
          <strong>{tr(locale, "Node-RED 服务未运行", "Node-RED service is not running")}</strong>
          <span>{tr(locale, "高级事件编排依赖独立的 Node-RED 进程；请先在服务器上启动它（默认端口 1880），启动后本页会自动恢复。", "Advanced orchestration relies on the separate Node-RED process. Start it on the server (default port 1880); this page recovers automatically once it is online.")}</span>
        </div>
      ) : (
        <iframe
          className="node-red-studio__frame"
          src={online === undefined ? "about:blank" : NODE_RED_EDITOR_PATH}
          title={tr(locale, "Node-RED 高级事件编排", "Node-RED advanced event orchestration")}
          sandbox="allow-downloads allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
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
