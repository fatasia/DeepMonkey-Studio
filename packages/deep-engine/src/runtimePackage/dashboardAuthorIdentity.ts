import { runtimeContentSha256 } from "./hash.js";

/** Stable page identity shared by authored Dashboard lowering and offline validation. */
export function dashboardRuntimePageId(applicationId: string, pageId: string): string {
  return `page.${runtimeContentSha256(JSON.stringify([applicationId, pageId, pageId]))}`;
}
