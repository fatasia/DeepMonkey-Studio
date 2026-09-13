import type { DeviceOperatingState, DeviceSignalSnapshot } from "@bim-studio/contracts";
import type { AppLocale } from "./i18n";

const labels: Record<DeviceOperatingState, readonly [string,string,string]> = {
  unknown:["未知","Unknown","?"],normal:["正常","Normal","✓"],running:["运行","Running","▶"],idle:["待机","Idle","○"],
  warning:["预警","Warning","⚠"],alarm:["告警","Alarm","⚠"],offline:["离线","Offline","⊘"],
};
export function deviceSignalPresentation(signal: DeviceSignalSnapshot, locale: AppLocale) {
  const token = signal.active ? signal.severity === "critical" ? "danger" : signal.severity === "info" ? "info" : "warning"
    : signal.state === "running" || signal.state === "normal" ? "success" : signal.state === "offline" ? "info" : "text-muted";
  return { label:labels[signal.state][locale === "zh-CN" ? 0 : 1], icon:labels[signal.state][2], token };
}
