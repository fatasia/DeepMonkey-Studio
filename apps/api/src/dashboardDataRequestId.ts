import { createHash } from "node:crypto";

/** Stable node identity shared by frozen closure and measured layout, without store dependencies. */
export function dashboardDataRequestId(nodeId: string): string {
  return `data.${createHash("sha256").update(nodeId).digest("hex")}`;
}
