import { validateDataWritebackValues, type DataWritebackConfig, type DataWritebackSnapshot, type DataWritebackValue } from "@bim-studio/contracts";

export function createWritebackDraft(config: DataWritebackConfig, snapshot: DataWritebackSnapshot): Record<string, string> {
  return Object.fromEntries(config.fields.map(field => [field.key, snapshot.values[field.key] == null ? "" : String(snapshot.values[field.key])]));
}

/** 输入过程保持原文，确认时一次性转型；空值与 0 / false 分开处理。 */
export function prepareWritebackDraft(config: DataWritebackConfig, draft: Readonly<Record<string, string>>) {
  const values: Record<string, DataWritebackValue> = {};
  for (const field of config.fields) {
    const text = draft[field.key] ?? "";
    values[field.key] = text === "" ? null : field.type === "number" ? Number(text.trim() || "NaN")
      : field.type === "boolean" ? text === "true" ? true : text === "false" ? false : text : text;
  }
  return { values, issues: validateDataWritebackValues(config, values) };
}

export function writebackConflicts(config: DataWritebackConfig, baseline: DataWritebackSnapshot, current: DataWritebackSnapshot, draft: Readonly<Record<string, string>>) {
  const local = prepareWritebackDraft(config, draft).values;
  return config.fields.flatMap(field => {
    const key = field.key;
    return baseline.values[key] !== current.values[key] && local[key] !== current.values[key]
      ? [{ key, before: baseline.values[key], local: local[key], current: current.values[key] }] : [];
  });
}
