import { translate as tr, type AppLocale } from "../i18n";
import { assistantWorkspaceTarget, type AssistantContextSource } from "./assistantReliability";

/** Combine live workspace evidence with discovered project sources. */
export function assistantContextSources(
  workspaceTarget: ReturnType<typeof assistantWorkspaceTarget>,
  contextSources: AssistantContextSource[],
  locale: AppLocale,
): AssistantContextSource[] {
  const workspaceSources: AssistantContextSource[] = [
    workspaceTarget.scene
      ? {
          id: "workspace-scene",
          label: tr(locale, "当前三维场景快照", "Current 3D scene snapshot"),
          state: "ready",
          kind: "snapshot",
          ...(workspaceTarget.scene.modelCount === undefined ? {} : { count: workspaceTarget.scene.modelCount }),
        }
      : undefined,
    workspaceTarget.selected
      ? {
          id: "workspace-selection",
          label: tr(locale, "当前选中对象", "Current selected object"),
          state: "ready",
          kind: "snapshot",
          count: 1,
        }
      : undefined,
    workspaceTarget.dashboardWidgetCount !== undefined
      ? {
          id: "workspace-dashboard",
          label: tr(locale, "当前二维看板草稿", "Current 2D dashboard draft"),
          state: "ready",
          kind: "snapshot",
          count: workspaceTarget.dashboardWidgetCount,
      }
      : undefined,
    workspaceTarget.script
      ? {
          id: "workspace-script",
          label: tr(locale, "当前脚本快照", "Current script snapshot"),
          state: "ready",
          kind: "snapshot",
          count: 1,
        }
      : undefined,
    workspaceTarget.simulation
      ? {
          id: "workspace-simulation",
          label: tr(locale, "当前仿真任务快照", "Current simulation snapshot"),
          state: "ready",
          kind: "snapshot",
          count: 1,
        }
      : undefined,
  ].filter((source): source is AssistantContextSource => Boolean(source));
  return [...workspaceSources, ...contextSources];
}
