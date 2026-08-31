import type { SceneMaterialState } from "@bim-studio/contracts";

const COLOR_KEYS = ["color", "emissive"] as const;
const BOOLEAN_KEYS = ["wireframe", "doubleSided"] as const;
const NUMBER_RANGES = {
  roughness: [0, 1],
  metalness: [0, 1],
  normalScale: [0, 4],
  emissiveIntensity: [0, 10],
  textureRepeat: [0.05, 100],
  textureRepeatX: [0.05, 100],
  textureRepeatY: [0.05, 100],
  textureOffsetX: [-100, 100],
  textureOffsetY: [-100, 100],
  textureRotation: [-Math.PI * 100, Math.PI * 100],
} as const;

const ALLOWED_KEYS = new Set<string>([
  ...COLOR_KEYS,
  ...BOOLEAN_KEYS,
  ...Object.keys(NUMBER_RANGES),
]);

/**
 * 数据源和 Worker 只能驱动高频标量材质参数。贴图 URL、视频和动画仍由素材库或受信任编辑器管理，
 * 避免实时数据把任意外部资源注入渲染管线。
 */
export function normalizeMaterialDataPatch(value: unknown): SceneMaterialState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("材质字段必须是 JSON 对象");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const unsupported = Object.keys(descriptors).filter((key) => !ALLOWED_KEYS.has(key));
  if (unsupported.length) throw new Error(`材质字段包含不支持参数：${unsupported.join("、")}`);
  if (!Object.keys(descriptors).length) throw new Error("材质字段至少需要一个参数");

  const patch: SceneMaterialState = {};
  for (const key of COLOR_KEYS) {
    const current = dataValue(descriptors[key], key);
    if (current === undefined) continue;
    if (typeof current !== "string" || !/^#[0-9a-f]{6}$/i.test(current)) {
      throw new Error(`${key} 必须是 #RRGGBB 颜色`);
    }
    patch[key] = current;
  }
  for (const key of BOOLEAN_KEYS) {
    const current = dataValue(descriptors[key], key);
    if (current === undefined) continue;
    if (typeof current !== "boolean") throw new Error(`${key} 必须是布尔值`);
    patch[key] = current;
  }
  for (const [key, range] of Object.entries(NUMBER_RANGES)) {
    const current = dataValue(descriptors[key], key);
    if (current === undefined) continue;
    if (typeof current !== "number" || !Number.isFinite(current) || current < range[0] || current > range[1]) {
      throw new Error(`${key} 必须是 ${range[0]}–${range[1]} 范围内的数字`);
    }
    (patch as Record<string, unknown>)[key] = current;
  }
  return patch;
}

function dataValue(descriptor: PropertyDescriptor | undefined, key: string): unknown {
  if (!descriptor) return undefined;
  if (!("value" in descriptor)) throw new Error(`材质字段 ${key} 不能使用访问器`);
  return descriptor.value;
}
