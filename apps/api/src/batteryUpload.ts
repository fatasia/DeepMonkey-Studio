import { parse } from "csv-parse/sync";

export const BATTERY_UPLOAD_LIMIT_BYTES = 15 * 1024 * 1024;
export const BATTERY_UPLOAD_MAX_RECORDS = 100_000;

/** 服务端重新解析原始文件，避免客户端提交重复字段名膨胀后的巨型 JSON。 */
export function parseBatteryUpload(buffer: Buffer): Array<Record<string, string | number>> {
  let headers: string[] = [];
  const source = buffer.toString("utf8");
  const records = parse(buffer, {
    bom: true,
    columns(values) {
      headers = values.map((value: string) => value.trim());
      validateHeaders(headers);
      return headers;
    },
    delimiter: detectDelimiter(source),
    skip_empty_lines: true,
    relax_column_count: false,
    trim: true,
  }) as Array<Record<string, string>>;

  if (!headers.length || !records.length) throw new Error("文件至少需要表头和一行采样数据");
  if (records.length > BATTERY_UPLOAD_MAX_RECORDS) {
    throw new Error("文件超过 100,000 行，请按单电芯或单工况拆分后再分析");
  }
  return records.map((record) => Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, scalar(value)]),
  ));
}

function detectDelimiter(source: string): string {
  const firstLine = source.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0] ?? "";
  const counts = new Map([[",", 0], ["\t", 0], [";", 0]]);
  let quoted = false;
  for (let index = 0; index < firstLine.length; index += 1) {
    const character = firstLine[index]!;
    if (character === '"') {
      if (quoted && firstLine[index + 1] === '"') index += 1;
      else quoted = !quoted;
      continue;
    }
    if (!quoted && counts.has(character)) counts.set(character, counts.get(character)! + 1);
  }
  return [...counts].sort((left, right) => right[1] - left[1])[0]?.[0] ?? ",";
}

function validateHeaders(headers: string[]): void {
  if (headers.some((value) => !value)) throw new Error("表头包含空字段，请补充字段名后重试");
  if (new Set(headers).size !== headers.length) throw new Error("表头包含重复字段，请先合并或重命名");
}

function scalar(value: string): string | number {
  if (!value) return "";
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) return value;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : value;
}
