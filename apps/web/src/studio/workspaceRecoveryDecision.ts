import type { WorkspaceRecoveryDraft } from "./workspaceRecoveryStore";

/** A decision belongs to an exact draft in one workspace, not just a wall-clock timestamp. */
export function workspaceRecoveryDecisionKey(draft: Pick<WorkspaceRecoveryDraft, "projectId" | "applicationId" | "sceneId" | "savedAt">): string {
  return JSON.stringify([draft.projectId, draft.applicationId ?? "", draft.sceneId, draft.savedAt]);
}
