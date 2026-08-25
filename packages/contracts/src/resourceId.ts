export const MAX_PATH_SAFE_RESOURCE_ID_LENGTH = 128;

const PATH_SAFE_RESOURCE_ID = /^[A-Za-z0-9._:-]+$/;

export function isPathSafeResourceId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_PATH_SAFE_RESOURCE_ID_LENGTH
    && value !== "."
    && value !== ".."
    && PATH_SAFE_RESOURCE_ID.test(value);
}

export function assertPathSafeResourceId(value: unknown, label = "资源 ID"): asserts value is string {
  if (!isPathSafeResourceId(value)) {
    throw new Error(`${label} 必须是 1-${MAX_PATH_SAFE_RESOURCE_ID_LENGTH} 个路径安全字符`);
  }
}
