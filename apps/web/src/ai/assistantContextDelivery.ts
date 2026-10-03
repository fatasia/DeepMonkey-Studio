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
  const { budget, ...rest } = receipt;
  return readBudget(budget) ? { ...rest, budget } : rest;
}

/** 预算回执是可选增量字段：格式不符只丢弃它，不连带否定整份交付回执。 */
function readBudget(value: unknown): value is NonNullable<AiContextDelivery["budget"]> {
  if (!value || typeof value !== "object") return false;
  const budget = value as NonNullable<AiContextDelivery["budget"]>;
  const count = (item: unknown): item is number => typeof item === "number" && Number.isSafeInteger(item) && item >= 0;
  return count(budget.budgetChars) && count(budget.originalChars) && count(budget.usedChars) && Array.isArray(budget.trimmed)
    && budget.trimmed.every((item) => item && typeof item.id === "string" && ["compacted", "shrunk", "omitted"].includes(item.action)
      && count(item.fromChars) && count(item.toChars) && typeof item.reason === "string");
}
