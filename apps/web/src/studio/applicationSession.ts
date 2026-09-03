import type { ApplicationDocument, ApplicationObjectRef } from "@bim-studio/contracts";
import { ApplicationStore } from "@bim-studio/studio-core";

export class ApplicationSession {
  readonly store = new ApplicationStore();

  openDocument(application: ApplicationDocument): ApplicationDocument {
    const current = this.store.getState();
    const retainedSelection = current.document?.metadata.id === application.metadata.id
      ? current.selection.filter((item) => selectionExists(application, item))
      : [];
    this.store.load(application);
    if (retainedSelection.length > 0) this.store.setSelection(retainedSelection);
    return this.store.getState().document!;
  }

  acknowledgeSave(application: ApplicationDocument): ApplicationDocument {
    this.store.acknowledgeSave(application);
    return this.store.getState().document!;
  }

  getDocument(): ApplicationDocument | undefined {
    return this.store.getState().document;
  }
}

function selectionExists(application: ApplicationDocument, selection: ApplicationObjectRef): boolean {
  if (selection.kind === "page") return application.pages.some((page) => page.id === selection.id);
  if (selection.kind === "widget") return application.pages.some((page) => page.nodes.some((node) => node.id === selection.id));
  if (selection.kind === "scene") return application.scenes.some((scene) => scene.id === selection.id);
  const scene = application.scenes.find((candidate) => candidate.id === selection.sceneId);
  return Boolean(scene && [...scene.models, ...scene.primitives].some((model) => model.modelId === selection.modelId));
}
