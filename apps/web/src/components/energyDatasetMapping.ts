import type { DataDatasetField, DataDatasetPreview, EnergyObservation } from "@bim-studio/contracts";

export interface EnergyFieldMap {
  timestamp: string;
  output: string;
  energyKwh: string;
  idleMinutes: string;
}

export const EMPTY_ENERGY_FIELD_MAP: EnergyFieldMap = { timestamp: "", output: "", energyKwh: "", idleMinutes: "" };

export function inferEnergyFieldMap(fields: DataDatasetField[]): EnergyFieldMap {
  const find = (pattern: RegExp) => fields.find((field) => pattern.test(`${field.key} ${field.label}`.toLowerCase()))?.key ?? "";
  return {
    timestamp: find(/(^|[_\s])(time|timestamp|recorded[_\s]?at|datetime|日期|时间)($|[_\s])/),
    output: find(/(^|[_\s])(output|production|quantity|yield|产量|产出)($|[_\s])/),
    energyKwh: find(/(^|[_\s])(energy|energy[_\s]?kwh|kwh|power[_\s]?usage|能耗|电量)($|[_\s])/),
    idleMinutes: find(/(^|[_\s])(idle|idle[_\s]?minutes|downtime|空转|停机)($|[_\s])/),
  };
}

export function energyObservationsFromPreview(preview: DataDatasetPreview, mapping: EnergyFieldMap): EnergyObservation[] {
  if (!mapping.output || !mapping.energyKwh) throw new Error("请选择产量和能耗字段");
  const rows = preview.rows.map((row, index) => {
    const output = Number(row[mapping.output]);
    const energyKwh = Number(row[mapping.energyKwh]);
    const idleValue = mapping.idleMinutes ? Number(row[mapping.idleMinutes]) : undefined;
    return {
      timestamp: String((mapping.timestamp ? row[mapping.timestamp] : undefined) ?? `row-${index + 1}`),
      output,
      energyKwh,
      ...(idleValue !== undefined && Number.isFinite(idleValue) ? { idleMinutes: idleValue } : {}),
    };
  });
  if (rows.length < 4) throw new Error("数据集至少需要 4 行有效时序数据");
  if (rows.some((row) => !Number.isFinite(row.output) || !Number.isFinite(row.energyKwh))) throw new Error("产量或能耗字段包含非数值，请修正字段映射或源数据");
  return rows;
}
