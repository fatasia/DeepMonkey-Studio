import { useState } from "react";
import { assertDeviceSignalRule, type DeviceSignalRule } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import "./DeviceSignalView.css";

export function DeviceSignalRuleEditor({locale,value={},onChange,disabled=false}:{locale:AppLocale;value?:DeviceSignalRule;onChange:(rule:DeviceSignalRule)=>void;disabled?:boolean}) {
  const [error,setError] = useState("");
  function commit(key:"lowAlarm"|"highAlarm",raw:string) {
    const next={...value};
    if(!raw.trim())delete next[key];else next[key]=Number(raw);
    try { assertDeviceSignalRule(next);setError("");onChange(next); } catch(reason) {setError(reason instanceof Error?reason.message:String(reason));}
  }
  return <details className="device-signal-rule" open={Boolean(value.lowAlarm!==undefined||value.highAlarm!==undefined)}>
    <summary>{tr(locale,"告警规则","Alarm rules")}</summary>
    {(["lowAlarm","highAlarm"] as const).map((key,index)=><label key={`${key}:${value[key]??""}`}><span>{index===0?tr(locale,"低限（含等值）","Low limit (inclusive)"):tr(locale,"高限（含等值）","High limit (inclusive)")}</span>
      <input type="number" step="any" disabled={disabled} defaultValue={value[key]??""} placeholder={tr(locale,"不设阈值","No threshold")} onBlur={event=>commit(key,event.target.value)} onKeyDown={event=>{if(event.key==="Enter")event.currentTarget.blur();}} />
    </label>)}
    <label><span>{tr(locale,"告警级别","Severity")}</span><select disabled={disabled} value={value.severity??"warning"} onChange={event=>onChange({...value,severity:event.target.value as NonNullable<DeviceSignalRule["severity"]>})}>
      <option value="info">{tr(locale,"提示","Info")}</option><option value="warning">{tr(locale,"预警","Warning")}</option><option value="critical">{tr(locale,"严重","Critical")}</option>
    </select></label>
    {error && <p role="alert">{error}</p>}
  </details>;
}
