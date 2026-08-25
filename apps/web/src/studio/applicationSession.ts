import type { ApplicationDocument } from "@bim-studio/contracts";
import { ApplicationStore } from "@bim-studio/studio-core";

export class ApplicationSession {
  readonly store = new ApplicationStore();

  openDocument(application: ApplicationDocument): ApplicationDocument {
    this.store.load(application);
    return this.store.getState().document!;
  }

  getDocument(): ApplicationDocument | undefined {
    return this.store.getState().document;
  }
}
