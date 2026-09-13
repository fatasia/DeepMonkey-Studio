export function uniqueById<T extends { readonly id: string }>(values: readonly T[], label: string): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    if (typeof value.id !== "string" || !value.id.length || result.has(value.id)) {
      throw new Error(`Invalid or duplicate ${label} ID.`);
    }
    result.set(value.id, value);
  }
  return result;
}

export function finiteFloat32(value: number): boolean {
  return Number.isFinite(value) && Number.isFinite(Math.fround(value));
}

export function unitFloat(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}
