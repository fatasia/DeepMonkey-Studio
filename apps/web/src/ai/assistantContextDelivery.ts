import type { AiContextDelivery } from "@bim-studio/contracts";

export function readContextDelivery(value: unknown): AiContextDelivery | undefined {
  if (!value || typeof value !== "object") return undefined;
  const receipt = value as AiContextDelivery;
  const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  if (receipt.unit !== "utf16" || !count(receipt.preparedChars) || !count(receipt.sentChars)
    || receipt.sentChars > receipt.preparedChars || !Array.isArray(receipt.sources)) return undefined;
  if (!receipt.sources.every((source) => source && typeof source.id === "string" && typeof source.path === "string"
    && ["sent", "partial", "omitted"].includes(source.status) && typeof source.transformed === "boolean"
    && count(source.preparedChars) && count(source.sentChars) && source.sentChars <= source.preparedChars)) return undefined;
  return receipt;
}
