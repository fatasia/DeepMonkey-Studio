export const PROJECT_POST_ACCEPTANCE_CARD_IDS = Object.freeze(["V01", "V02", "V03", "V04", "V05"]);
const ALLOWED = new Set(["passed", "partial", "unverified"]);

export function validateProjectPostAcceptanceCards(cards) {
  if (!Array.isArray(cards) || cards.length !== PROJECT_POST_ACCEPTANCE_CARD_IDS.length) return { valid: false, reason: "exactly five V01–V05 cards are required" };
  const ids = cards.map((card) => card?.id);
  if (new Set(ids).size !== ids.length || PROJECT_POST_ACCEPTANCE_CARD_IDS.some((id) => !ids.includes(id))) return { valid: false, reason: "V01–V05 card IDs must be unique and complete" };
  for (const card of cards) {
    if (!ALLOWED.has(card?.status) || typeof card.reason !== "string" || !card.reason.trim()) return { valid: false, reason: `${card?.id ?? "unknown"} must have a supported status and reason` };
    if (card.status === "passed" && card.independentEvidence !== true) return { valid: false, reason: `${card.id} cannot pass without independentEvidence=true` };
    if (card.status !== "passed" && !card.reason.trim()) return { valid: false, reason: `${card.id} needs an explicit gap reason` };
  }
  return { valid: true, reason: null };
}
