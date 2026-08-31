export interface ParsedBatteryCsv {
  headers: string[];
  rowCount: number;
}

const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_RECORDS = 100_000;

/**
 * 解析电池采样 CSV/TSV。这里保留空值为字符串，并只转换有限数字，避免把设备编号等文本误转。
 * 超大文件直接阻断，不做静默截断，防止模型在不完整时间序列上给出看似有效的结论。
 */
export async function parseBatteryCsv(file: File): Promise<ParsedBatteryCsv> {
  if (file.size > MAX_FILE_BYTES) throw new Error("文件超过 15 MiB，请先按单电芯或单工况拆分后再分析");
  const rows = parseDelimited(await file.text());
  if (rows.length < 2) throw new Error("文件至少需要表头和一行采样数据");
  if (rows.length - 1 > MAX_RECORDS) throw new Error("文件超过 100,000 行，请按单电芯或单工况拆分后再分析");

  const headers = rows[0]!.map((value) => value.trim());
  if (headers.some((value) => !value)) throw new Error("表头包含空字段，请补充字段名后重试");
  if (new Set(headers).size !== headers.length) throw new Error("表头包含重复字段，请先合并或重命名");

  const rowCount = rows.slice(1).filter((row) => row.some((value) => value.trim())).length;
  if (!rowCount) throw new Error("文件没有可用采样数据");
  return { headers, rowCount };
}

function parseDelimited(source: string): string[][] {
  const normalized = source.replace(/^\uFEFF/, "");
  const delimiter = detectDelimiter(normalized);
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;

  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index]!;
    if (character === '"') {
      if (quoted && normalized[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (!quoted && character === delimiter) {
      row.push(value);
      value = "";
      continue;
    }
    if (!quoted && (character === "\n" || character === "\r")) {
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
      if (character === "\r" && normalized[index + 1] === "\n") index += 1;
      continue;
    }
    value += character;
  }
  if (quoted) throw new Error("CSV 引号未闭合，请检查文件格式");
  if (value || row.length) {
    row.push(value);
    rows.push(row);
  }
  return rows;
}

function detectDelimiter(source: string): string {
  const firstLine = source.split(/\r?\n/, 1)[0] ?? "";
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
