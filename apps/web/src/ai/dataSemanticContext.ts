import type { DataDatasetField, DataDatasetRecord } from "@bim-studio/contracts";

export type DataSemanticRole = "device" | "measurementPoint" | "metric" | "space" | "maintenanceEvent" | "time";

export interface AskDataSemanticContext {
  schemaVersion: 1;
  scope: "project-datasets";
  relationTypes: readonly ["device-measurementPoint", "measurementPoint-metric", "device-space", "device-maintenanceEvent"];
  datasets: Array<{
    datasetId: string;
    datasetName: string;
    fields: Array<DataDatasetField & { role: DataSemanticRole }>;
    unresolvedFields: string[];
  }>;
  decisionBoundary: string;
}

const ROLE_ALIASES: Record<DataSemanticRole, string[]> = {
  device: ["device", "deviceid", "equipment", "equipmentid", "asset", "assetid", "设备", "设备编号", "资产", "机台"],
  measurementPoint: ["tag", "tagid", "point", "pointid", "sensor", "sensorid", "测点", "点位", "传感器"],
  metric: ["metric", "indicator", "value", "reading", "temperature", "pressure", "soc", "soh", "rul", "指标", "数值", "温度", "压力"],
  space: ["space", "spaceid", "area", "line", "lineid", "workshop", "room", "floor", "空间", "区域", "产线", "车间", "房间", "楼层"],
  maintenanceEvent: ["event", "eventid", "alarm", "fault", "workorder", "case", "caseid", "maintenance", "事件", "告警", "故障", "工单", "维护"],
  time: ["time", "timestamp", "recordedat", "createdat", "updatedat", "datetime", "时间", "采集时间", "发生时间"]
};

/**
 * 从项目已有字段生成一次性的轻量语义索引，不创建本体数据库或推断不存在的业务关系。
 * 未识别字段会原样列出，由问数助手要求用户澄清，避免大模型猜字段。
 */
export function buildAskDataSemanticContext(datasets: DataDatasetRecord[]): AskDataSemanticContext {
  return {
    schemaVersion: 1,
    scope: "project-datasets",
    relationTypes: ["device-measurementPoint", "measurementPoint-metric", "device-space", "device-maintenanceEvent"],
    datasets: datasets.map((dataset) => {
      const fields = dataset.fields.flatMap((field) => {
        const role = inferSemanticRole(field);
        return role ? [{ ...field, role }] : [];
      });
      const recognized = new Set(fields.map((field) => field.key));
      return {
        datasetId: dataset.id,
        datasetName: dataset.name,
        fields,
        unresolvedFields: dataset.fields.filter((field) => !recognized.has(field.key)).map((field) => field.key)
      };
    }),
    decisionBoundary: "仅用于字段候选与歧义提示；查询必须引用真实数据集和字段，未知字段不得执行"
  };
}

export function inferSemanticRole(field: DataDatasetField): DataSemanticRole | undefined {
  if (field.type === "datetime") return "time";
  const candidates = [...aliasCandidates(field.key), ...aliasCandidates(field.label)];
  const roles = (Object.entries(ROLE_ALIASES) as Array<[DataSemanticRole, string[]]>)
    .filter(([, aliases]) => candidates.some((candidate) => aliases.includes(candidate)))
    .map(([role]) => role);
  // 一个字段同时命中多个角色时宁可要求澄清，也不选择看似合理的第一个结果。
  return roles.length === 1 ? roles[0] : undefined;
}

function normalizeAlias(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[\s_.:\-/]+/g, "");
}

function aliasCandidates(value: string): string[] {
  const separated = value.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return [normalizeAlias(value), ...separated.split(/[\s_.:\-/]+/).map(normalizeAlias)].filter(Boolean);
}
