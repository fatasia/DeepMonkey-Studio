import type { CSSProperties } from "react";
import type { DeviceSignalSnapshot } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import { deviceSignalPresentation } from "../deviceSignalPresentation";
import "./DeviceSignalView.css";

export function DeviceSignalView({ signal, title, locale, onLocate, onAcknowledge, pending = false }: {
  signal:DeviceSignalSnapshot; title:string; locale:AppLocale;
  onLocate?:()=>void; onAcknowledge?:()=>void; pending?:boolean;
}) {
  const presentation = deviceSignalPresentation(signal,locale);
  return <div className={`device-signal-view is-${signal.state} ${signal.active ? "has-alarm" : ""}`} style={{"--signal-color":`var(--${presentation.token})`} as CSSProperties} role="status">
    <span className="device-signal-view__symbol" aria-hidden="true">{presentation.icon}</span>
    <div className="device-signal-view__copy"><small title={title}>{title}</small><strong>{presentation.label}</strong>
      {(typeof signal.value === "number" || typeof signal.value === "string" && (signal.state === "unknown" || signal.value.trim() && Number.isFinite(Number(signal.value)))) && <span>{String(signal.value)}{signal.unit ? ` ${signal.unit}` : ""}</span>}
      {signal.message && <p>{signal.message}</p>}
      {signal.active && <em>{signal.acknowledged ? tr(locale,"已确认","Acknowledged") : tr(locale,"未确认","Unacknowledged")}</em>}
    </div>
    {(onLocate || onAcknowledge && signal.active && !signal.acknowledged) && <div className="device-signal-view__actions">
      {onLocate && <button type="button" onClick={event=>{event.stopPropagation();onLocate();}}>{tr(locale,"定位设备","Locate device")}</button>}
      {onAcknowledge && signal.active && !signal.acknowledged && <button type="button" disabled={pending} onClick={event=>{event.stopPropagation();onAcknowledge();}}>{pending?tr(locale,"确认中…","Acknowledging…"):tr(locale,"确认告警","Acknowledge")}</button>}
    </div>}
  </div>;
}
