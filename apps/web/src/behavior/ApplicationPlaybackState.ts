import type { ApplicationDocument, JsonValue } from "@bim-studio/contracts";
import { applyStudioCommand, evaluateApplicationInteraction, type ApplicationInteractionEvent } from "@bim-studio/studio-core";
import { scriptComponentCommands } from "./scriptComponentCommands";
import { updateDashboardParameterDraft } from "../components/dashboardWorkspaceModel";

/** Disposable runtime copy: no author store, undo history, autosave or persistence. */
export class ApplicationPlaybackState {
  document: ApplicationDocument;
  variables: Record<string, JsonValue>;
  filters: Record<string, JsonValue>;
  onChange?: () => void;

  constructor(document: ApplicationDocument, variables: Readonly<Record<string, JsonValue>> = {}, filters: Readonly<Record<string, JsonValue>> = {}) {
    this.document = structuredClone(document);
    this.variables = { ...Object.fromEntries(document.data.variables.map(({ id, value }) => [id, structuredClone(value)])), ...structuredClone(variables) };
    this.filters = structuredClone(filters);
  }

  updateComponent(id: string, patch: Record<string, unknown>): void {
    let next = this.document;
    for (const command of scriptComponentCommands(next, id, patch)) next = applyStudioCommand(next, command);
    this.document = next;
    this.onChange?.();
  }

  setVariables(updates: Readonly<Record<string, JsonValue>>): boolean {
    if (!Object.entries(updates).some(([key, value]) => JSON.stringify(this.variables[key]) !== JSON.stringify(value))) return false;
    this.variables = { ...this.variables, ...structuredClone(updates) };
    this.onChange?.();
    return true;
  }

  setFilter(key: string, value: JsonValue | undefined): void {
    const widgets = this.document.pages.flatMap((page) => page.nodes.flatMap((node) => node.kind === "data-widget" ? [node.widget] : []));
    this.filters = updateDashboardParameterDraft(this.filters, widgets, key, value === undefined ? undefined : structuredClone(value));
    this.onChange?.();
  }

  interact(event: ApplicationInteractionEvent) {
    const result = evaluateApplicationInteraction(this.document, event);
    this.setVariables(result.variableUpdates);
    return result;
  }
}
