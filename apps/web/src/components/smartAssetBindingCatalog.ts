import type { SmartBindingCatalogItem, SmartBindingPosition, SmartBindingSceneObject } from "@bim-studio/studio-core";
import type { ComponentRecord } from "../viewer/analysis";

export type SmartBindingCatalogFormat = "auto" | "json" | "csv";

export const MAX_BINDING_CATALOG_BYTES = 5 * 1024 * 1024;
const MAX_SOURCE_LENGTH = MAX_BINDING_CATALOG_BYTES;
const MAX_CATALOG_ITEMS = 10_000;
export const MAX_BINDING_PAIR_COUNT = 250_000;

const FIELD_ALIASES = {
  deviceId: ["deviceid", "device_id", "id", "设备编号", "设备id", "编码", "位号", "测点编号"],
  name: ["name", "devicename", "device_name", "label", "设备名称", "名称", "测点名称"],
  tags: ["tags", "tag", "aliases", "别名", "标签", "位号标签"],
  space: ["space", "room", "area", "zone", "floor", "空间", "房间", "区域", "楼层"],
  category: ["category", "type", "kind", "设备类别", "类别", "类型"],
  x: ["x", "positionx", "position_x", "坐标x"],
  y: ["y", "positiony", "position_y", "坐标y"],
  z: ["z", "positionz", "position_z", "坐标z"],
} as const;

/**
 * 解析用户粘贴的设备/测点目录。解析失败时整体拒绝，避免静默丢行后形成错误绑定。
 */
export function parseSmartBindingCatalog(
  source: string,
  format: SmartBindingCatalogFormat = "auto",
): SmartBindingCatalogItem[] {
  const normalized = source.replace(/^\uFEFF/, "").trim();
  if (!normalized) throw new Error("请粘贴或导入设备/测点目录");
  if (normalized.length > MAX_SOURCE_LENGTH) throw new Error("目录超过 5 MiB，请按区域或专业拆分后再绑定");
  const resolvedFormat = format === "auto" ? detectFormat(normalized) : format;
  const records = resolvedFormat === "json" ? parseJsonRecords(normalized) : parseCsvRecords(normalized);
  if (!records.length) throw new Error("目录中没有可用设备或测点");
  if (records.length > MAX_CATALOG_ITEMS) throw new Error("目录超过 10,000 项，请按区域或专业拆分后再绑定");
  const items = records.map((record, index) => catalogItemFromRecord(record, index + 1));
  assertUnique(items.map((item) => item.deviceId));
  return items;
}

/** 将查看器记录转换为稳定的匹配输入，不补造场景中不存在的空间坐标。 */
export function componentRecordsToBindingObjects(records: readonly ComponentRecord[]): SmartBindingSceneObject[] {
  return records.map((record) => {
    const position = positionFromRecord(record.properties, `场景对象 ${record.name}`, false);
    return {
      id: record.stableId,
      name: record.name,
      path: record.path,
      category: record.category ?? record.type,
      properties: {
        ...record.properties,
        ...(record.level ? { space: record.level } : {}),
      },
      ...(position ? { position } : {}),
    };
  });
}

export function assertBindingWorkload(sceneCount: number, catalogCount: number): void {
  if (sceneCount * catalogCount > MAX_BINDING_PAIR_COUNT) {
    throw new Error("当前范围超过 25 万个候选对，请先按楼层、区域或类别缩小场景范围");
  }
}

function detectFormat(source: string): Exclude<SmartBindingCatalogFormat, "auto"> {
  return source.startsWith("[") || source.startsWith("{") ? "json" : "csv";
}

function parseJsonRecords(source: string): Array<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("JSON 格式无效，请检查括号、引号和末尾逗号");
  }
  const value = Array.isArray(parsed) ? parsed : objectArray(parsed);
  if (!value) throw new Error("JSON 应为数组，或包含 devices / items / data 数组");
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`JSON 第 ${index + 1} 项不是对象`);
    return item as Record<string, unknown>;
  });
}

function objectArray(value: unknown): unknown[] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const object = value as Record<string, unknown>;
  return [object.devices, object.items, object.data, object.catalog].find(Array.isArray) as unknown[] | undefined;
}

function parseCsvRecords(source: string): Array<Record<string, unknown>> {
  const rows = parseDelimited(source);
  if (rows.length < 2) throw new Error("CSV 至少需要表头和一行设备数据");
  const headers = rows[0]!.map((value) => value.trim());
  if (headers.some((header) => !header)) throw new Error("CSV 表头包含空字段");
  if (new Set(headers.map(normalizeKey)).size !== headers.length) throw new Error("CSV 表头包含重复字段");
  return rows.slice(1)
    .filter((row) => row.some((value) => value.trim()))
    .map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index]?.trim() ?? ""])));
}

function catalogItemFromRecord(record: Record<string, unknown>, row: number): SmartBindingCatalogItem {
  const deviceId = textField(record, FIELD_ALIASES.deviceId);
  const name = textField(record, FIELD_ALIASES.name);
  if (!deviceId) throw new Error(`第 ${row} 项缺少设备编号 deviceId`);
  if (!name) throw new Error(`第 ${row} 项缺少设备名称 name`);
  const position = nestedPosition(record, row) ?? positionFromRecord(record, `第 ${row} 项`);
  const tagsValue = field(record, FIELD_ALIASES.tags);
  const tags = Array.isArray(tagsValue)
    ? tagsValue.map(String).map((value) => value.trim()).filter(Boolean)
    : typeof tagsValue === "string" ? tagsValue.split(/[|,，;；]/).map((value) => value.trim()).filter(Boolean) : [];
  return {
    deviceId,
    name,
    ...(tags.length ? { tags } : {}),
    ...(textField(record, FIELD_ALIASES.space) ? { space: textField(record, FIELD_ALIASES.space)! } : {}),
    ...(textField(record, FIELD_ALIASES.category) ? { category: textField(record, FIELD_ALIASES.category)! } : {}),
    ...(position ? { position } : {}),
  };
}

function nestedPosition(record: Record<string, unknown>, row: number): SmartBindingPosition | undefined {
  const value = Object.entries(record).find(([key]) => normalizeKey(key) === "position")?.[1];
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`第 ${row} 项 position 必须是 {x,y,z} 对象`);
  return positionFromRecord(value as Record<string, unknown>, `第 ${row} 项 position`);
}

function positionFromRecord(record: Readonly<Record<string, unknown>>, label: string, strict = true): SmartBindingPosition | undefined {
  const rawX = field(record, FIELD_ALIASES.x);
  const rawY = field(record, FIELD_ALIASES.y);
  const rawZ = field(record, FIELD_ALIASES.z);
  if ([rawX, rawY, rawZ].every((value) => value === undefined || value === "")) return undefined;
  const x = finiteNumber(rawX);
  const y = finiteNumber(rawY);
  const z = rawZ === undefined || rawZ === "" ? undefined : finiteNumber(rawZ);
  if (x === undefined || y === undefined || (rawZ !== undefined && rawZ !== "" && z === undefined)) {
    if (!strict) return undefined;
    throw new Error(`${label} 的坐标必须包含有限数值 X、Y，可选 Z`);
  }
  return { x, y, ...(z === undefined ? {} : { z }) };
}

function field(record: Readonly<Record<string, unknown>>, aliases: readonly string[]): unknown {
  const wanted = new Set(aliases.map(normalizeKey));
  return Object.entries(record).find(([key]) => wanted.has(normalizeKey(key)))?.[1];
}

function textField(record: Readonly<Record<string, unknown>>, aliases: readonly string[]): string | undefined {
  const value = field(record, aliases);
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  return String(value).trim() || undefined;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const number = typeof value === "number" ? value : Number(value.trim());
  return Number.isFinite(number) ? number : undefined;
}

function assertUnique(ids: readonly string[]): void {
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate) throw new Error(`设备编号重复：${duplicate}`);
}

function normalizeKey(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/[\s.-]+/g, "_");
}

function parseDelimited(source: string): string[][] {
  const delimiter = detectDelimiter(source);
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === '"') {
      if (quoted && source[index + 1] === '"') { value += '"'; index += 1; }
      else quoted = !quoted;
    } else if (!quoted && character === delimiter) { row.push(value); value = ""; }
    else if (!quoted && (character === "\r" || character === "\n")) {
      row.push(value); rows.push(row); row = []; value = "";
      if (character === "\r" && source[index + 1] === "\n") index += 1;
    } else value += character;
  }
  if (quoted) throw new Error("CSV 引号未闭合");
  if (value || row.length) { row.push(value); rows.push(row); }
  return rows;
}

function detectDelimiter(source: string): string {
  const firstLine = source.split(/\r?\n/, 1)[0] ?? "";
  const delimiters = [",", "\t", ";"];
  return delimiters.map((delimiter) => ({ delimiter, count: firstLine.split(delimiter).length - 1 }))
    .sort((left, right) => right.count - left.count)[0]!.delimiter;
}
