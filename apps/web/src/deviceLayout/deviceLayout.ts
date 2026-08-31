export interface DeviceBoxDraft {
  id: string;
  name: string;
  category: string;
  position: { x: number; y: number; z: number };
  size: { width: number; height: number; depth: number };
  rotationY: number;
  color: string;
  properties: Record<string, string | number | boolean | null>;
}

export interface DeviceLayoutResult {
  devices: DeviceBoxDraft[];
  issues: string[];
}

export interface DeviceGridOptions {
  rows: number;
  columns: number;
  spacingX: number;
  spacingZ: number;
  originX: number;
  originY: number;
  originZ: number;
  width: number;
  height: number;
  depth: number;
  prefix: string;
  color: string;
}

export interface DeviceLayoutTransform {
  offsetX: number;
  offsetY: number;
  offsetZ: number;
  scale: number;
}

interface GeoJsonFeatureCollection {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    id?: string | number;
    geometry?: { type?: string; coordinates?: unknown } | null;
    properties?: Record<string, unknown> | null;
  }>;
}

const MAX_DEVICE_COUNT = 5_000;
const DEFAULT_COLOR = "#3f8cff";

/** 生成规则阵列，适合尚无正式模型时快速搭建设备孪生占位。 */
export function createDeviceGrid(options: DeviceGridOptions): DeviceBoxDraft[] {
  const rows = boundedInteger(options.rows, 1, 200);
  const columns = boundedInteger(options.columns, 1, 200);
  if (rows * columns > MAX_DEVICE_COUNT) throw new Error(`单次最多生成 ${MAX_DEVICE_COUNT} 台设备`);
  const devices: DeviceBoxDraft[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const index = row * columns + column + 1;
      const id = `${safeId(options.prefix || "device")}-${String(index).padStart(3, "0")}`;
      devices.push({
        id,
        name: `${options.prefix || "设备"} ${String(index).padStart(3, "0")}`,
        category: "设备",
        position: {
          x: finite(options.originX) + column * positive(options.spacingX, "X 间距"),
          y: finite(options.originY),
          z: finite(options.originZ) + row * positive(options.spacingZ, "Z 间距"),
        },
        size: normalizedSize(options.width, options.height, options.depth),
        rotationY: 0,
        color: validColor(options.color),
        properties: { row: row + 1, column: column + 1, source: "grid" },
      });
    }
  }
  return devices;
}

/**
 * 接受 CSV/TSV、JSON 数组或 GeoJSON。GeoJSON Point 使用 [X,Z,Y]；Polygon 会按包围盒生成方盒，
 * 因而可承接由 CAD 平面图预处理得到的设备轮廓。
 */
export function parseDeviceLayoutText(text: string): DeviceLayoutResult {
  const source = text.trim();
  if (!source) return { devices: [], issues: ["请输入或导入设备数据"] };
  try {
    if (source.startsWith("{") || source.startsWith("[")) {
      const parsed: unknown = JSON.parse(source);
      if (isFeatureCollection(parsed)) return devicesFromGeoJson(parsed);
      if (Array.isArray(parsed)) return devicesFromRows(parsed);
      return { devices: [], issues: ["JSON 必须是对象数组或 GeoJSON FeatureCollection"] };
    }
    return devicesFromRows(parseDelimitedRows(source));
  } catch (reason) {
    return { devices: [], issues: [reason instanceof Error ? reason.message : String(reason)] };
  }
}

export function toDeviceGeoJson(devices: readonly DeviceBoxDraft[]): GeoJsonFeatureCollection {
  return {
    type: "FeatureCollection",
    features: devices.map((device) => ({
      type: "Feature",
      id: device.id,
      // 工程场景采用 Y-up；GeoJSON 第二维对应场景 Z，第三维为高程 Y。
      geometry: { type: "Point", coordinates: [device.position.x, device.position.z, device.position.y] },
      properties: {
        ...device.properties,
        equipmentId: device.id,
        name: device.name,
        category: device.category,
        width: device.size.width,
        height: device.size.height,
        depth: device.size.depth,
        rotationY: device.rotationY,
        color: device.color,
        coordinateOrder: "X,Z,Y",
      },
    })),
  };
}

/** 将图纸坐标或数据坐标统一映射到当前场景，不修改原始解析结果。 */
export function transformDeviceLayout(devices: readonly DeviceBoxDraft[], transform: DeviceLayoutTransform): DeviceBoxDraft[] {
  const scale = positive(transform.scale, "坐标比例");
  const offsetX = finite(transform.offsetX);
  const offsetY = finite(transform.offsetY);
  const offsetZ = finite(transform.offsetZ);
  return devices.map((device) => ({
    ...device,
    position: {
      x: device.position.x * scale + offsetX,
      y: device.position.y * scale + offsetY,
      z: device.position.z * scale + offsetZ,
    },
    size: {
      width: device.size.width * scale,
      height: device.size.height * scale,
      depth: device.size.depth * scale,
    },
  }));
}

function devicesFromRows(input: unknown[]): DeviceLayoutResult {
  const devices: DeviceBoxDraft[] = [];
  const issues: string[] = [];
  const usedIds = new Set<string>();
  input.slice(0, MAX_DEVICE_COUNT).forEach((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      issues.push(`第 ${index + 1} 行不是对象，已跳过`);
      return;
    }
    try {
      const row = value as Record<string, unknown>;
      devices.push(deviceFromRow(row, index, usedIds));
    } catch (reason) {
      issues.push(`第 ${index + 1} 行：${reason instanceof Error ? reason.message : String(reason)}`);
    }
  });
  if (input.length > MAX_DEVICE_COUNT) issues.push(`仅处理前 ${MAX_DEVICE_COUNT} 台设备`);
  return { devices, issues };
}

function devicesFromGeoJson(collection: GeoJsonFeatureCollection): DeviceLayoutResult {
  const devices: DeviceBoxDraft[] = [];
  const issues: string[] = [];
  const usedIds = new Set<string>();
  collection.features.slice(0, MAX_DEVICE_COUNT).forEach((feature, index) => {
    try {
      const properties = feature.properties ?? {};
      const row: Record<string, unknown> = { ...properties, id: feature.id ?? properties.id };
      const geometry = feature.geometry;
      if (geometry?.type === "Point") {
        const coordinates = numericCoordinates(geometry.coordinates);
        row.x = coordinates[0];
        row.z = coordinates[1];
        row.y = coordinates[2] ?? numberValue(properties, Y_KEYS, 0);
      } else if (geometry?.type === "Polygon") {
        const bounds = polygonBounds(geometry.coordinates);
        row.x = (bounds.minX + bounds.maxX) / 2;
        row.z = (bounds.minZ + bounds.maxZ) / 2;
        row.width = numberValue(properties, WIDTH_KEYS, bounds.maxX - bounds.minX);
        row.depth = numberValue(properties, DEPTH_KEYS, bounds.maxZ - bounds.minZ);
      } else {
        throw new Error(`暂不支持 ${geometry?.type ?? "空"} 几何，只支持 Point/Polygon`);
      }
      devices.push(deviceFromRow(row, index, usedIds));
    } catch (reason) {
      issues.push(`Feature ${index + 1}：${reason instanceof Error ? reason.message : String(reason)}`);
    }
  });
  if (collection.features.length > MAX_DEVICE_COUNT) issues.push(`仅处理前 ${MAX_DEVICE_COUNT} 台设备`);
  return { devices, issues };
}

function deviceFromRow(row: Record<string, unknown>, index: number, usedIds: Set<string>): DeviceBoxDraft {
  const rawId = stringValue(row, ID_KEYS) || `device-${index + 1}`;
  const id = uniqueId(safeId(rawId), usedIds);
  const height = numberValue(row, HEIGHT_KEYS, 2);
  const properties = serializableProperties(row);
  return {
    id,
    name: stringValue(row, NAME_KEYS) || rawId,
    category: stringValue(row, CATEGORY_KEYS) || "设备",
    position: {
      x: requiredNumberValue(row, X_KEYS, "X 坐标"),
      y: numberValue(row, Y_KEYS, 0),
      z: requiredNumberValue(row, Z_KEYS, "Z 坐标"),
    },
    size: normalizedSize(numberValue(row, WIDTH_KEYS, 2), height, numberValue(row, DEPTH_KEYS, 2)),
    rotationY: numberValue(row, ROTATION_KEYS, 0),
    color: validColor(stringValue(row, COLOR_KEYS) || DEFAULT_COLOR),
    properties,
  };
}

function parseDelimitedRows(source: string): Record<string, string>[] {
  const lines = source.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) throw new Error("表格至少需要表头和一行设备数据");
  const delimiter = lines[0]!.includes("\t") ? "\t" : ",";
  const headers = parseDelimitedLine(lines[0]!, delimiter).map((item) => item.trim());
  return lines.slice(1).map((line) => Object.fromEntries(headers.map((header, index) => [header, parseDelimitedLine(line, delimiter)[index] ?? ""])));
}

function parseDelimitedLine(line: string, delimiter: string): string[] {
  const result: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (character === '"' && line[index + 1] === '"' && quoted) {
      current += '"';
      index += 1;
    } else if (character === '"') quoted = !quoted;
    else if (character === delimiter && !quoted) {
      result.push(current);
      current = "";
    } else current += character;
  }
  result.push(current);
  if (quoted) throw new Error("表格存在未闭合引号");
  return result;
}

function polygonBounds(value: unknown): { minX: number; minZ: number; maxX: number; maxZ: number } {
  if (!Array.isArray(value) || !Array.isArray(value[0])) throw new Error("Polygon 坐标无效");
  const ring = value[0] as unknown[];
  const coordinates = ring.map(numericCoordinates);
  if (coordinates.length < 4) throw new Error("Polygon 至少需要四个坐标点");
  return {
    minX: Math.min(...coordinates.map((item) => item[0]!)),
    maxX: Math.max(...coordinates.map((item) => item[0]!)),
    minZ: Math.min(...coordinates.map((item) => item[1]!)),
    maxZ: Math.max(...coordinates.map((item) => item[1]!)),
  };
}

function numericCoordinates(value: unknown): number[] {
  if (!Array.isArray(value) || value.length < 2) throw new Error("坐标至少需要 X、Z 两个值");
  const result = value.slice(0, 3).map(Number);
  if (result.some((item) => !Number.isFinite(item))) throw new Error("坐标必须是有限数字");
  return result;
}

function normalizedSize(width: number, height: number, depth: number) {
  return { width: positive(width, "宽度"), height: positive(height, "高度"), depth: positive(depth, "深度") };
}

function numberValue(row: Record<string, unknown>, aliases: readonly string[], fallback: number): number {
  const raw = findValue(row, aliases);
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${aliases[0]} 必须是有限数字`);
  return value;
}

function requiredNumberValue(row: Record<string, unknown>, aliases: readonly string[], label: string): number {
  const raw = findValue(row, aliases);
  if (raw === undefined || raw === "") throw new Error(`缺少${label}`);
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${label}必须是有限数字`);
  return value;
}

function stringValue(row: Record<string, unknown>, aliases: readonly string[]): string {
  const value = findValue(row, aliases);
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function findValue(row: Record<string, unknown>, aliases: readonly string[]): unknown {
  const normalized = new Map(Object.entries(row).map(([key, value]) => [normalizeKey(key), value]));
  return aliases
    .map(normalizeKey)
    .map((key) => normalized.get(key))
    .find((value) => value !== undefined);
}

function normalizeKey(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s_-]/g, "");
}
function finite(value: number): number {
  if (!Number.isFinite(value)) throw new Error("坐标必须是有限数字");
  return value;
}
function positive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label}必须大于 0`);
  return value;
}
function boundedInteger(value: number, minimum: number, maximum: number): number {
  const result = Math.round(value);
  if (!Number.isFinite(result) || result < minimum || result > maximum) throw new Error(`数量必须在 ${minimum}–${maximum} 之间`);
  return result;
}
function safeId(value: string): string {
  return (
    value
      .trim()
      .replace(/[^\p{L}\p{N}._:-]+/gu, "-")
      .replace(/^-+|-+$/g, "") || "device"
  );
}
function validColor(value: string): string {
  return /^#[0-9a-f]{6}$/i.test(value) ? value : DEFAULT_COLOR;
}
function uniqueId(base: string, used: Set<string>): string {
  let id = base;
  let index = 2;
  while (used.has(id)) id = `${base}-${index++}`;
  used.add(id);
  return id;
}
function isFeatureCollection(value: unknown): value is GeoJsonFeatureCollection {
  return Boolean(value && typeof value === "object" && (value as { type?: unknown }).type === "FeatureCollection" && Array.isArray((value as { features?: unknown }).features));
}
function serializableProperties(row: Record<string, unknown>): Record<string, string | number | boolean | null> {
  return Object.fromEntries(
    Object.entries(row).filter((entry): entry is [string, string | number | boolean | null] => entry[1] === null || ["string", "number", "boolean"].includes(typeof entry[1])),
  );
}

const ID_KEYS = ["equipmentId", "deviceId", "id", "code", "设备编号", "设备ID", "编号"];
const NAME_KEYS = ["name", "label", "deviceName", "equipmentName", "设备名称", "名称"];
const CATEGORY_KEYS = ["category", "type", "设备类型", "类别"];
const X_KEYS = ["x", "positionX", "坐标X", "横坐标"];
const Y_KEYS = ["y", "positionY", "elevation", "坐标Y", "高程", "标高"];
const Z_KEYS = ["z", "positionZ", "planY", "坐标Z", "纵坐标"];
const WIDTH_KEYS = ["width", "w", "宽度"];
const HEIGHT_KEYS = ["height", "h", "高度"];
const DEPTH_KEYS = ["depth", "length", "d", "深度", "长度"];
const ROTATION_KEYS = ["rotationY", "rotation", "angle", "旋转", "角度"];
const COLOR_KEYS = ["color", "颜色"];
