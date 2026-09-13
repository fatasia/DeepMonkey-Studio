import type { SceneSnapshot } from "@bim-studio/contracts";
import { hasRecoverableWorkspaceChanges, type WorkspaceRecoveryDraft } from "./workspaceRecoveryStore";

/** A decision belongs to an exact draft in one workspace, not just a wall-clock timestamp. */
export function workspaceRecoveryDecisionKey(draft: Pick<WorkspaceRecoveryDraft, "projectId" | "applicationId" | "sceneId" | "savedAt">): string {
  return JSON.stringify([draft.projectId, draft.applicationId ?? "", draft.sceneId, draft.savedAt]);
}

/** 内容差异决定是否恢复；服务器较新或两端时钟不同，都不能静默隐藏本地修改。 */
export function assessWorkspaceRecovery(
  draft: WorkspaceRecoveryDraft | undefined,
  serverScene: SceneSnapshot,
  decisionKey?: string,
): "ignore" | "discard-equivalent" | "offer" {
  if (!draft || draft.projectId !== serverScene.projectId || draft.sceneId !== serverScene.id
    || decisionKey === workspaceRecoveryDecisionKey(draft)) return "ignore";
  return hasRecoverableWorkspaceChanges(draft, serverScene) ? "offer" : "discard-equivalent";
}
