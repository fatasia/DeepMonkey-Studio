import type { DataDatasetField } from "@bim-studio/contracts";

export function datasetSchemaChanged(current: DataDatasetField[], discovered: DataDatasetField[]): boolean {
  if (current.length !== discovered.length) return true;
  return discovered.some((field, index) => {
    const saved = current[index];
    return !saved || saved.key !== field.key || saved.label !== field.label || saved.type !== field.type || saved.unit !== field.unit;
  });
}
