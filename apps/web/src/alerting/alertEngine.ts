// P3 API 侧接入（2026-09-19）：告警引擎纯逻辑上移至共享包 @bim-studio/studio-core，
// 供 apps/api 告警评估桥与 web 呈现层共用同一实现；此文件保留原导入路径兼容。
// 逻辑零改动——引擎本体见 packages/studio-core/src/alertEngine.ts。
export { AlertEngine } from "@bim-studio/studio-core";
export type {
  AlertEngineOptions,
  AlertEvent,
  AlertRule,
  AlertSeverity,
  AlertStateSnapshot,
  AlertStatus,
  SignalSample,
} from "@bim-studio/studio-core";
