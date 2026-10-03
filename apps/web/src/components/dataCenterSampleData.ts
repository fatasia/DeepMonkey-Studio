import type { DataConnectionType, DataDatasetField } from "@bim-studio/contracts";
import type { AppLocale } from "../i18n";

/**
 * KWeaver 式开箱即用:数据中心内置样例(设备遥测演示)。
 * 草稿构建与 UI 解耦(幂等键面=固定名,交互侧按 name 去重);后端真源=/api/demo/sensors
 * (dataIntegration.ts 的 bim_studio_demo_metrics 表,开机自动种子)。
 */

export const SAMPLE_CONNECTION_NAME_ZH = "内置演示数据";

export interface SampleConnectionDraft {
  readonly name: string;
  readonly type: DataConnectionType;
  readonly enabled: boolean;
  readonly config: Record<string, string>;
}

export function buildSampleConnectionDraft(name: string): SampleConnectionDraft {
  return {
    name,
    type: "http",
    enabled: true,
    config: { url: "/api/demo/sensors", format: "json" },
  };
}

export interface SampleDatasetDraft {
  readonly connectionId: string;
  readonly name: string;
  readonly sourceKey: string;
  readonly refreshSeconds: number;
  readonly fields: DataDatasetField[];
}

export function buildSampleDatasetDraft(connectionId: string, name: string, locale: AppLocale = "zh-CN"): SampleDatasetDraft {
  const zh = locale === "zh-CN";
  const fields: DataDatasetField[] = [
    { key: "recorded_at", label: zh ? "时间" : "Time", type: "datetime" },
    { key: "device_id", label: zh ? "设备" : "Device", type: "string" },
    { key: "temperature", label: zh ? "温度" : "Temperature", type: "number", unit: "°C" },
    { key: "pressure", label: zh ? "压力" : "Pressure", type: "number", unit: "MPa" },
    { key: "running", label: zh ? "运行中" : "Running", type: "boolean" },
  ];
  return {
    connectionId,
    name,
    sourceKey: "/api/demo/sensors",
    refreshSeconds: 15,
    fields,
  };
}
