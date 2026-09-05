import type { ApplicationDocument } from "@bim-studio/contracts";
import {
  createUpdateDashboardDataWidgetCommand,
  createUpdateDashboardNodeFrameCommand,
  createUpdateDashboardNodeStateCommand,
  createUpdateDashboardSceneViewportCommand,
  type StudioCommand,
} from "@bim-studio/studio-core";

/** Shared validation/command contract; callers choose author history or playback state. */
export function scriptComponentCommands(document: ApplicationDocument, id: string, patch: Record<string, unknown>): StudioCommand[] {
  const entry = document.pages.flatMap((page) => page.nodes.map((node) => ({ page, node }))).find(({ node }) => node.id === id || node.name === id);
  if (!entry) throw new Error(`找不到组件“${id}”`);
  const { page, node } = entry;
  const commands: StudioCommand[] = [];
  if (patch.frame && typeof patch.frame === "object") {
    commands.push(createUpdateDashboardNodeFrameCommand(page.id, node.id, { ...node.frame, ...(patch.frame as Partial<typeof node.frame>) }));
  }
  const state = Object.fromEntries(["name", "visible", "selectable", "locked", "groupId", "groupName"].filter((key) => key in patch).map((key) => [key, patch[key]]));
  if (Object.keys(state).length) commands.push(createUpdateDashboardNodeStateCommand(page.id, node.id, state));
  if (node.kind === "data-widget" && patch.widget && typeof patch.widget === "object") {
    commands.push(createUpdateDashboardDataWidgetCommand(page.id, node.id, { ...node.widget, ...(patch.widget as Partial<typeof node.widget>) }));
  }
  if (node.kind === "scene-viewport") {
    const viewport = patch.viewport && typeof patch.viewport === "object" ? patch.viewport as Record<string, unknown> : patch;
    commands.push(createUpdateDashboardSceneViewportCommand(page.id, node.id, {
      sceneId: typeof viewport.sceneId === "string" ? viewport.sceneId : node.sceneId,
      renderMode: viewport.renderMode === "realtime" || viewport.renderMode === "static-placeholder" || viewport.renderMode === "load-on-interaction" ? viewport.renderMode : node.renderMode,
      interactionPolicy: viewport.interactionPolicy === "click-select" || viewport.interactionPolicy === "display-only" || viewport.interactionPolicy === "full-navigation" ? viewport.interactionPolicy : node.interactionPolicy,
      ...(typeof viewport.cameraViewId === "string" ? { cameraViewId: viewport.cameraViewId } : node.cameraViewId ? { cameraViewId: node.cameraViewId } : {}),
    }));
  }
  return commands;
}
