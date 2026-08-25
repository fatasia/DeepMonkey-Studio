import { Activity, Database, ExternalLink, Gauge, Radio, X } from "lucide-react";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";
import type { SceneDataBridgeStatus } from "../sceneDataBridge";

export function DigitalTwinPanel({ locale, onClose, status, received }: { locale: AppLocale; onClose: () => void; status: SceneDataBridgeStatus; received: number }) {
  return <section className="digital-twin-panel" aria-label={tr(locale, "数字孪生数据桥", "Digital twin data bridge")}>
    <header><span><Radio size={16} /></span><div><strong>{tr(locale, "数据接入", "Data integration")}</strong><small>{tr(locale, "连接 → 数据集 → 场景", "Connection → dataset → scene")}</small></div><button title={tr(locale, "关闭", "Close")} onClick={onClose}><X size={15} /></button></header>
    <div className={`twin-status ${status}`}><i /><span>{status === "online" ? tr(locale, "数据桥在线", "Bridge online") : status === "connecting" ? tr(locale, "正在连接", "Connecting") : tr(locale, "数据桥离线", "Bridge offline")}</span><strong>{received}</strong><small>{tr(locale, "条消息", "messages")}</small></div>
    <div className="twin-path"><div><b>1</b><span><strong>{tr(locale, "建立连接", "Connect")}</strong><small>HTTP · SQL · MQTT · PLC</small></span></div><i /><div><b>2</b><span><strong>{tr(locale, "创建数据集", "Create dataset")}</strong><small>{tr(locale, "查询并预览字段", "Query and preview fields")}</small></span></div><i /><div><b>3</b><span><strong>{tr(locale, "绑定到场景", "Bind to scene")}</strong><small>{tr(locale, "看板或三维对象", "Dashboard or 3D object")}</small></span></div></div>
    <div className="twin-links"><a className="primary" href="/data"><Database size={15} />{tr(locale, "打开数据中心", "Open data center")}<ExternalLink size={12} /></a><a href="/manager"><Gauge size={15} />{tr(locale, "进入场景后打开看板", "Open dashboard in Studio")}</a><a href="/node-red/" target="_blank" rel="noreferrer"><Activity size={15} />{tr(locale, "高级流程编排", "Advanced flow editor")}<ExternalLink size={12} /></a></div>
    <details><summary>{tr(locale, "场景消息示例", "Scene message example")}</summary><pre>{`POST /iot/scene\n{\n  "source": "mqtt/ahu-01",\n  "key": "alarm",\n  "value": "#ff334f",\n  "target": { "modelId": "..." },\n  "action": "color"\n}`}</pre></details>
  </section>;
}
