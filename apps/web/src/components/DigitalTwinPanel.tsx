import { Activity, ExternalLink, Radio, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";
import type { SceneDataMessage } from "../viewer/ViewerEngine";

export function DigitalTwinPanel({ locale, onClose, onMessage }: { locale: AppLocale; onClose: () => void; onMessage: (message: SceneDataMessage) => void }) {
  const [status, setStatus] = useState<"connecting" | "online" | "offline">("connecting");
  const [received, setReceived] = useState(0);
  const callback = useRef(onMessage);
  callback.current = onMessage;

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/iot/ws/scene`);
    socket.addEventListener("open", () => setStatus("online"));
    socket.addEventListener("close", () => setStatus("offline"));
    socket.addEventListener("error", () => setStatus("offline"));
    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(String(event.data)) as SceneDataMessage;
        if (!message.source || !message.key || !message.timestamp) return;
        callback.current(message);
        setReceived((value) => value + 1);
      } catch { /* 非结构化消息不进入场景。 */ }
    });
    return () => socket.close();
  }, []);

  return <section className="digital-twin-panel" aria-label={tr(locale, "数字孪生数据桥", "Digital twin data bridge")}>
    <header><span><Radio size={16} /></span><div><strong>{tr(locale, "数字孪生", "Digital twin")}</strong><small>{tr(locale, "Node-RED 数据桥", "Node-RED data bridge")}</small></div><button title={tr(locale, "关闭", "Close")} onClick={onClose}><X size={15} /></button></header>
    <div className={`twin-status ${status}`}><i /><span>{status === "online" ? tr(locale, "数据桥在线", "Bridge online") : status === "connecting" ? tr(locale, "正在连接", "Connecting") : tr(locale, "数据桥离线", "Bridge offline")}</span><strong>{received}</strong><small>{tr(locale, "条消息", "messages")}</small></div>
    <p>{tr(locale, "流程负责接协议和数据库；只有映射后的显隐、颜色、位置、标签消息会进入当前场景。", "Flows connect protocols and databases; only mapped visibility, color, position and label messages enter the current scene.")}</p>
    <div className="twin-links"><a href="/node-red" target="_blank" rel="noreferrer"><Activity size={15} />{tr(locale, "流程编辑器", "Flow editor")}<ExternalLink size={12} /></a><a href="/iot/dashboard" target="_blank" rel="noreferrer">{tr(locale, "看板", "Dashboard")}<ExternalLink size={12} /></a></div>
    <details><summary>{tr(locale, "场景消息示例", "Scene message example")}</summary><pre>{`POST /iot/scene\n{\n  "source": "mqtt/ahu-01",\n  "key": "alarm",\n  "value": "#ff334f",\n  "target": { "modelId": "..." },\n  "action": "color"\n}`}</pre></details>
  </section>;
}
