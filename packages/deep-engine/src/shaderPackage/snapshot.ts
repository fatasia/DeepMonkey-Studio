export function cloneCanonical<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => cloneCanonical(entry)) as T;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneCanonical(entry)])) as T;
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach((entry) => deepFreeze(entry));
    Object.freeze(value);
  }
  return value;
}

export const immutableCanonicalSnapshot = <T>(value: T): T => deepFreeze(cloneCanonical(value));
