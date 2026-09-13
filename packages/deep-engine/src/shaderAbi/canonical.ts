function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

/** Stable JSON used by cross-runtime ABI fingerprint checks. Object keys are sorted; array order remains significant. */
export function canonicalShaderAbiJson(value: unknown): string { return canonical(value); }
