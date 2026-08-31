import * as THREE from "three";
import type { Vector3Value } from "@bim-studio/contracts";
import type { ComponentRecord } from "./analysis";

interface NativeBimElementMetadata {
  elementId?: string;
  uniqueId?: string;
  displayProperties?: Record<string, string>;
  [key: string]: unknown;
}

export interface NativeBimSpaceMetadata {
  spaceId?: string;
  name?: string;
  number?: string;
  kind?: string;
  level?: string;
  department?: string;
  areaSquareMetres?: number;
  volumeCubicMetres?: number;
  bounds?: { min: Vector3Value; max: Vector3Value };
  parameters?: Array<{ name?: string; value?: string; groupTypeId?: string }>;
  [key: string]: unknown;
}

export interface NativeBimPropertiesFile {
  schemaVersion?: number;
  model?: Record<string, unknown>;
  elements?: Record<string, NativeBimElementMetadata>;
  types?: Record<string, NativeBimElementMetadata>;
  materials?: Record<string, Record<string, unknown>>;
  spaces?: Record<string, NativeBimSpaceMetadata>;
  [elementId: string]: unknown;
}

export function flattenProperties(value: unknown, output: Record<string, string>, prefix = ""): void {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const label = prefix ? `${prefix}.${key}` : key;
    if (child === null || child === undefined) continue;
    if (typeof child === "string" || typeof child === "number" || typeof child === "boolean") {
      if (!(label in output)) output[label] = String(child);
    } else if (Array.isArray(child)) {
      if (!(label in output)) output[label] = child.map((item) => typeof item === "object" ? JSON.stringify(item) : String(item)).join(", ");
    } else if (prefix.split(".").length < 2) {
      flattenProperties(child, output, label);
    }
  }
}

/** 将转换器元数据挂回场景对象，保留实例、类型与材质的来源层级。 */
export function hydrateNativeBimMetadata(root: THREE.Object3D, payload: NativeBimPropertiesFile): void {
  if (payload.model && typeof payload.model === "object") root.userData.BimModel = payload.model;
  if (payload.spaces && typeof payload.spaces === "object") root.userData.BimSpaces = payload.spaces;
  const source = payload.elements && typeof payload.elements === "object"
    ? payload.elements
    : Object.fromEntries(
        Object.entries(payload).filter(([key, value]) => key !== "model" && key !== "schemaVersion" && value && typeof value === "object")
      ) as Record<string, NativeBimElementMetadata>;
  const objectsByElement = new Map<string, THREE.Object3D[]>();
  root.traverse((object) => {
    const elementId = scalarText(object.userData.ElementId);
    if (!elementId) return;
    const objects = objectsByElement.get(elementId) ?? [];
    objects.push(object);
    objectsByElement.set(elementId, objects);
  });
  for (const [elementId, metadata] of Object.entries(source)) {
    const candidates = objectsByElement.get(elementId) ?? [];
    const object = candidates.find((candidate) => candidate.userData.NodeType === "Element")
      ?? candidates.find((candidate) => candidate.children.length > 0)
      ?? candidates[0];
    if (!object || !metadata || typeof metadata !== "object") continue;
    const displayProperties = metadata.displayProperties && typeof metadata.displayProperties === "object"
      ? metadata.displayProperties
      : { ...primitiveProperties(metadata), ...parameterProperties(metadata.instanceParameters, "实例") };
    const typeId = scalarText(metadata.typeId);
    const typeMetadata = typeId ? payload.types?.[typeId] : undefined;
    const typeDisplay = typeMetadata?.displayProperties && typeof typeMetadata.displayProperties === "object"
      ? typeMetadata.displayProperties
      : parameterProperties(typeMetadata?.parameters, "类型");
    const materialIds = Array.isArray(metadata.materialIds) ? metadata.materialIds.map(scalarText).filter(Boolean) as string[] : [];
    const materials = materialIds.map((id) => payload.materials?.[id]).filter(Boolean);
    Object.assign(object.userData, typeDisplay, displayProperties, {
      NodeType: "Element",
      ElementId: scalarText(metadata.elementId) ?? elementId,
      UniqueId: scalarText(metadata.uniqueId) ?? scalarText(object.userData.UniqueId) ?? "",
      BimMetadata: { ...metadata, typeMetadata, materials }
    });
  }
}

export function firstProperty(properties: Record<string, string>, names: string[]): string | undefined {
  const normalizedNames = names.map((name) => name.toLocaleLowerCase("zh-CN"));
  for (const [key, value] of Object.entries(properties)) {
    if (normalizedNames.includes(key.toLocaleLowerCase("zh-CN")) && value.trim()) return value.trim();
  }
  return undefined;
}

export function nearestBimElement(object: THREE.Object3D, boundary?: THREE.Object3D): THREE.Object3D | undefined {
  let current: THREE.Object3D | null = object;
  while (current) {
    if (current.userData.NodeType === "Element") return current;
    if (current === boundary) return undefined;
    current = current.parent;
  }
  return undefined;
}

export function isVectorValue(value: unknown): value is Vector3Value {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Vector3Value>;
  return Number.isFinite(candidate.x) && Number.isFinite(candidate.y) && Number.isFinite(candidate.z);
}

export function vectorValue(vector: THREE.Vector3): Vector3Value {
  return { x: vector.x, y: vector.y, z: vector.z };
}

export function uniqueComponentRecords(records: ComponentRecord[]): ComponentRecord[] {
  const seen = new Set<string>();
  return records.filter((record) => {
    const key = `${record.modelId}:${record.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function primitiveProperties(value: Record<string, unknown>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string" || typeof child === "number" || typeof child === "boolean") output[key] = String(child);
  }
  return output;
}

function parameterProperties(value: unknown, prefix: string): Record<string, string> {
  if (!Array.isArray(value)) return {};
  const output: Record<string, string> = {};
  for (const parameter of value) {
    if (!parameter || typeof parameter !== "object") continue;
    const record = parameter as Record<string, unknown>;
    const name = scalarText(record.name);
    const parameterValue = scalarText(record.value);
    if (!name || parameterValue === undefined) continue;
    const baseKey = `${prefix}.${name}`;
    let key = baseKey;
    let duplicate = 2;
    while (key in output) key = `${baseKey} (${duplicate++})`;
    output[key] = parameterValue;
  }
  return output;
}

export function scalarText(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return undefined;
}
